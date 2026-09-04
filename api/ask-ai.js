/* ==========================================================================
   RESCUEPRIORITY — AI BACKEND (Vercel Serverless Function)
   ----------------------------------------------------------------------
   Runs on the server, not in the browser. This is the ONLY place the
   Gemini API key exists — it is read from an environment variable
   (GEMINI_API_KEY) that you set in the Vercel dashboard, never committed
   to the repo and never sent to the frontend.

   Deployed automatically by Vercel because it lives in /api. Reachable
   from the frontend at:  POST /api/ask-ai

   Request body:  { "question": string, "context": object }
   Response body: { "answer": string }
========================================================================== */

const GEMINI_MODEL = "gemini-3.6-flash"; // free-tier model — see setup notes
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `You are the RescuePriority Emergency Operations Assistant, built into a school's Emergency Operations Center dashboard (MCNHS).

You will be given a JSON snapshot of the CURRENT RescuePriority data (active emergencies, incident statistics, recent incidents, top classrooms/zones by incident count, resolution-time statistics, time-of-day statistics). Always base your answer on this data. Never invent incidents, classrooms, statistics, advisers, facility names, trends, or emergency conditions that are not present in the provided data.

If the data needed to answer is missing or empty, say so plainly instead of guessing.

Response style:
- Keep answers concise, understandable, and useful. No long essays.
- Plain text only. Never use Markdown formatting — no asterisks, no bold/italic markers, no bullet-point asterisks, no headers with #. Use plain numbered lines (1. 2. 3.) for lists, and the emoji headers below exactly as written.
- For simple factual questions ("is the campus safe?", "how many active emergencies?"), answer directly in 1-3 sentences.
- For analytical questions ("what should we do to prevent this?", "which area should we prioritize?"), structure the answer as:

📊 WHAT THE DATA SHOWS
[brief, factual observation grounded in the provided data]

🔎 WHAT THIS MAY MEAN
[brief interpretation — clearly framed as a possibility, not a fact]

💡 RECOMMENDED ACTION
1. [simple, practical action]
2. [simple, practical action]
3. [simple, practical action]

Rules:
- Clearly distinguish what the data definitely shows from what it may suggest. Do not present speculation as fact.
- Recommendations must be simple, practical, and realistic (e.g. inspect affected facilities, review recurring causes, increase monitoring, check for response delays, review equipment/facility conditions, improve notification procedures). Never dangerous or unrealistic recommendations.
- You are an ADVISORY system only. Never claim a recommendation guarantees safety. Never claim you can modify emergency records, classroom state, or incident data — you are read-only.
- Do not produce huge, complicated answers.`;

export default async function handler(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "Method not allowed" });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("[ask-ai] GEMINI_API_KEY is not set");
        return res.status(500).json({ error: "AI backend is not configured yet." });
    }

    const { question, context } = req.body || {};
    if (!question || typeof question !== "string" || !question.trim()) {
        return res.status(400).json({ error: "A question is required." });
    }

    const userContent = `RescuePriority data snapshot (JSON):\n${JSON.stringify(context || {})}\n\nQuestion: ${question.trim()}`;

    try {
        const geminiResponse = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
                contents: [{ role: "user", parts: [{ text: userContent }] }],
                generationConfig: {
                    temperature: 0.3,
                    maxOutputTokens: 2048,
                    thinkingConfig: {
                        thinkingLevel: "low"
                    }
                }
            })
        });

        if (geminiResponse.status === 429) {
            return res.status(429).json({ error: "The AI assistant is getting a lot of requests right now. Please wait a moment and try again." });
        }

        if (!geminiResponse.ok) {
            const errText = await geminiResponse.text();
            console.error("[ask-ai] Gemini error:", geminiResponse.status, errText);
            return res.status(502).json({ error: "The AI assistant couldn't process that right now. Please try again." });
        }

        const data = await geminiResponse.json();
        let answer = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();

        // Safety net: strip any Markdown emphasis markers the model uses
        // despite the system prompt, so the chat UI never shows raw ** or *.
        if (answer) {
            answer = answer
                .replace(/\*\*(.*?)\*\*/g, "$1")
                .replace(/(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)/g, "$1")
                .replace(/^#{1,6}\s+/gm, "")
                .replace(/^[\*\-]\s+/gm, "\u2022 ");
        }

        if (!answer) {
            return res.status(502).json({ error: "The AI assistant didn't return a usable answer. Please try rephrasing your question." });
        }

        return res.status(200).json({ answer });
    } catch (err) {
        console.error("[ask-ai] Request failed:", err);
        return res.status(500).json({ error: "Couldn't reach the AI assistant. Check your connection and try again." });
    }
}
