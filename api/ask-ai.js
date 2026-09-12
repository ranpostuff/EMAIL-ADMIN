/* RescuePriority AI backend: NVIDIA primary, Gemini fallback. */
import { createHash } from "node:crypto";

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || "nvidia/nemotron-3-ultra-550b-a55b";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const CACHE_TTL_MS = 2 * 60 * 1000;
const CACHE_MAX_ENTRIES = 80;
const responseCache = globalThis.__rescuePriorityAICache || new Map();
globalThis.__rescuePriorityAICache = responseCache;

const SYSTEM_PROMPT = `You are the RescuePriority Emergency Operations Assistant for MCNHS administrators.

You receive a compact JSON snapshot of current RescuePriority data. It can include active emergencies, incident totals, recent incidents, top classrooms and zones, exact student incident rankings, incident types, violation statistics, a 30-day trend, resolution statistics, and time-of-day statistics.

Rules:
- Ground every factual statement in the supplied data. Never invent a student, incident, classroom, adviser, statistic, cause, or emergency condition.
- Treat student information as sensitive. Mention a student by name only when the administrator's question specifically requires student-level information.
- Distinguish recorded facts from possible interpretations.
- Never diagnose a student or make punitive, medical, or psychological conclusions from incident counts.
- If data is missing, incomplete, or tied, say so plainly.
- You are read-only and advisory. Never claim you changed records or guarantee safety.
- Prefer concise answers. Use plain text, short paragraphs, and numbered lists. Do not use Markdown symbols.
- Keep the entire answer under 180 words and finish every section completely.
- For analysis, state what the data shows, what it may mean, and no more than 3 practical next actions.`;

function normalizeHistory(history) {
    if (!Array.isArray(history)) return [];
    return history
        .filter(item => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
        .slice(-8)
        .map(item => ({ role: item.role, content: item.content.trim().slice(0, 1600) }))
        .filter(item => item.content);
}

function cleanAnswer(value) {
    if (!value || typeof value !== "string") return "";
    return value.trim()
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)/g, "$1")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^[\*-]\s+/gm, "• ");
}

function isDeepAnalysis(question) {
    return /\b(analy[sz]e|analysis|why|pattern|trend|compare|prevent|recommend|prioriti[sz]e|risk|explain|improve)\b/i.test(question);
}

function formatRanking(rows, countKey, noun) {
    if (!Array.isArray(rows) || rows.length === 0) return `There are no recorded ${noun} rankings in the current data.`;
    const highest = Number(rows[0][countKey]) || 0;
    const tied = rows.filter(row => (Number(row[countKey]) || 0) === highest);
    const heading = tied.length > 1 ? `There is a tie at ${highest} ${noun}:` : `The highest recorded count is ${highest} ${noun}:`;
    return `${heading}\n${rows.slice(0, 5).map((row, index) => `${index + 1}. ${row.name || row.zone || "Unknown"} — ${Number(row[countKey]) || 0}`).join("\n")}`;
}

function tryFastAnswer(question, context) {
    const q = question.toLowerCase();
    const stats = context?.incidentStatistics || {};

    if (/(who|which|show|list|top).*(student).*(most|highest|top|incident)|student.*(most|highest).*incident/.test(q)) {
        return formatRanking(context?.studentIncidentStatistics?.topStudents, "incidentCount", "incidents");
    }
    if (/(who|which|show|list|top).*(student).*(most|highest|top|violation)|student.*(most|highest).*violation/.test(q)) {
        return formatRanking(context?.violationStatistics?.topStudents, "violationCount", "violations");
    }
    if (/(which|what|show|top).*(classroom|area|zone).*(most|highest|top).*incident/.test(q)) {
        return formatRanking(context?.topClassroomsAndZones?.topClassrooms, "count", "incidents");
    }
    if (/how many.*(active emergency|active incident)|number of.*active/.test(q)) {
        return `There ${Number(stats.active) === 1 ? "is" : "are"} ${Number(stats.active) || 0} active incident${Number(stats.active) === 1 ? "" : "s"} in the current records.`;
    }
    if (/how many.*resolved|number of.*resolved/.test(q)) {
        return `${Number(stats.resolved) || 0} incidents are recorded as resolved.`;
    }
    if (/how many.*incident|total.*incident|number of.*incident/.test(q) && !isDeepAnalysis(question)) {
        return `There are ${Number(stats.total) || 0} recorded incidents: ${Number(stats.active) || 0} active and ${Number(stats.resolved) || 0} resolved.`;
    }
    if (/which.*(classroom|area).*(emergency)|current.*emergenc/.test(q) && !isDeepAnalysis(question)) {
        const active = Array.isArray(context?.activeEmergencies) ? context.activeEmergencies : [];
        if (!active.length) return "No facilities are currently flagged as being in an emergency state.";
        return `Currently flagged facilities:\n${active.map((item, index) => `${index + 1}. ${item.name}${item.zone ? ` — ${item.zone}` : ""}`).join("\n")}`;
    }
    return "";
}

function cacheKey(question, context, history) {
    const stableContext = { ...(context || {}) };
    delete stableContext.generatedAt;
    return createHash("sha256")
        .update(JSON.stringify({ question: question.toLowerCase(), context: stableContext, history }))
        .digest("hex");
}

function readCache(key) {
    const item = responseCache.get(key);
    if (!item) return null;
    if (Date.now() - item.createdAt > CACHE_TTL_MS) {
        responseCache.delete(key);
        return null;
    }
    return item;
}

function writeCache(key, answer, provider) {
    if (responseCache.size >= CACHE_MAX_ENTRIES) responseCache.delete(responseCache.keys().next().value);
    responseCache.set(key, { answer, provider, createdAt: Date.now() });
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

async function askNvidia(question, context, history, deepAnalysis) {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) throw new Error("NVIDIA_API_KEY is not configured");
    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        { role: "user", content: `Current RescuePriority data (JSON):\n${JSON.stringify(context)}\n\nAdministrator question: ${question}` }
    ];
    const response = await fetchWithTimeout(NVIDIA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: NVIDIA_MODEL,
            messages,
            temperature: deepAnalysis ? 0.4 : 0.2,
            top_p: 0.9,
            max_tokens: deepAnalysis ? 900 : 450,
            stream: false,
            chat_template_kwargs: { enable_thinking: false }
        })
    }, deepAnalysis ? 22000 : 14000);
    if (!response.ok) throw new Error(`NVIDIA ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const data = await response.json();
    if (data?.choices?.[0]?.finish_reason === "length") throw new Error("NVIDIA response was truncated");
    const answer = cleanAnswer(data?.choices?.[0]?.message?.content);
    if (!answer) throw new Error("NVIDIA returned no usable answer");
    return answer;
}

async function askGemini(question, context, history, deepAnalysis) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
    const contents = history.map(item => ({
        role: item.role === "assistant" ? "model" : "user",
        parts: [{ text: item.content }]
    }));
    contents.push({ role: "user", parts: [{ text: `Current RescuePriority data (JSON):\n${JSON.stringify(context)}\n\nAdministrator question: ${question}` }] });
    const response = await fetchWithTimeout(`${GEMINI_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents,
            generationConfig: {
                temperature: deepAnalysis ? 0.45 : 0.2,
                maxOutputTokens: deepAnalysis ? 700 : 450,
                thinkingConfig: { thinkingLevel: "low" }
            }
        })
    }, deepAnalysis ? 20000 : 14000);
    if (!response.ok) throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const data = await response.json();
    const answer = cleanAnswer(data?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join(""));
    if (!answer) throw new Error("Gemini returned no usable answer");
    return answer;
}

export default async function handler(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "Method not allowed" });
    }
    const { question, context, history } = req.body || {};
    if (!question || typeof question !== "string" || !question.trim()) return res.status(400).json({ error: "A question is required." });

    const trimmedQuestion = question.trim().slice(0, 1200);
    const safeContext = context && typeof context === "object" ? context : {};
    if (JSON.stringify(safeContext).length > 180000) return res.status(413).json({ error: "The dashboard data snapshot is too large." });
    const safeHistory = normalizeHistory(history);

    const fastAnswer = tryFastAnswer(trimmedQuestion, safeContext);
    if (fastAnswer) return res.status(200).json({ answer: fastAnswer, provider: "RescuePriority Analytics", mode: "instant" });

    const key = cacheKey(trimmedQuestion, safeContext, safeHistory);
    const cached = readCache(key);
    if (cached) return res.status(200).json({ answer: cached.answer, provider: cached.provider, cached: true });

    const deepAnalysis = isDeepAnalysis(trimmedQuestion);
    let nvidiaError = null;
    if (process.env.NVIDIA_API_KEY) {
        try {
            const answer = await askNvidia(trimmedQuestion, safeContext, safeHistory, deepAnalysis);
            writeCache(key, answer, "NVIDIA Nemotron");
            return res.status(200).json({ answer, provider: "NVIDIA Nemotron", mode: deepAnalysis ? "analysis" : "fast" });
        } catch (error) {
            nvidiaError = error;
            console.error("[ask-ai] NVIDIA failed; attempting fallback:", error.message);
        }
    }
    if (process.env.GEMINI_API_KEY) {
        try {
            const answer = await askGemini(trimmedQuestion, safeContext, safeHistory, deepAnalysis);
            writeCache(key, answer, "Gemini fallback");
            return res.status(200).json({ answer, provider: "Gemini fallback", mode: deepAnalysis ? "analysis" : "fast" });
        } catch (error) {
            console.error("[ask-ai] Gemini fallback failed:", error.message);
        }
    }
    if (!process.env.NVIDIA_API_KEY && !process.env.GEMINI_API_KEY) return res.status(500).json({ error: "The AI backend has no API key configured." });
    return res.status(nvidiaError?.message?.includes("429") ? 429 : 502).json({ error: "The AI providers could not answer right now. Please try again shortly." });
}
