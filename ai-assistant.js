/* ==========================================================================
   RESCUEPRIORITY — AI ASSISTANT
   Connects the existing chat UI to the RescuePriority AI backend.
   NVIDIA Nemotron is primary and Gemini is the automatic fallback. API
   keys stay in Vercel and never touch this file or the browser.

   Sends { question, context } to /api/ask-ai, where `context` comes from
   ai-context.js's buildAIContext() (live Firebase-backed data: active
   emergencies, incident stats, recent incidents, top classrooms/zones,
   resolution stats, time-of-day stats). Runs independently of script.js.
========================================================================== */

import { buildAIContext } from "./ai-context.js";

const AI_ENDPOINT = "/api/ask-ai";
const AI_HISTORY_KEY = "rescuepriority-ai-history";

function loadHistory() {
    try {
        const value = JSON.parse(sessionStorage.getItem(AI_HISTORY_KEY) || "[]");
        return Array.isArray(value) ? value.slice(-12) : [];
    } catch {
        return [];
    }
}

function initAIAssistant() {
    const form = document.getElementById("ai-chat-form");
    const input = document.getElementById("ai-chat-input");
    const messagesEl = document.getElementById("ai-chat-messages");
    const emptyState = document.getElementById("ai-chat-empty-state");
    const clearBtn = document.getElementById("ai-chat-clear");
    const sendBtn = document.getElementById("ai-chat-send");
    const promptButtons = document.querySelectorAll(".ai-suggested-prompt");

    if (!form || !input || !messagesEl) return;
    let conversation = loadHistory();

    function saveHistory() {
        try {
            sessionStorage.setItem(AI_HISTORY_KEY, JSON.stringify(conversation.slice(-12)));
        } catch {
            // The assistant still works when private browsing blocks storage.
        }
    }

    function addMessage(role, text) {
        const bubble = document.createElement("div");
        bubble.className = `ai-chat-bubble ai-chat-bubble-${role}`;
        bubble.textContent = text;
        messagesEl.appendChild(bubble);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return bubble;
    }

    function addTypingBubble() {
        const bubble = document.createElement("div");
        bubble.className = "ai-chat-bubble ai-chat-bubble-assistant ai-chat-bubble-typing";
        bubble.innerHTML = `<span class="ai-typing-dot"></span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span>`;
        messagesEl.appendChild(bubble);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return bubble;
    }

    if (conversation.length) {
        if (emptyState) emptyState.classList.add("hidden");
        conversation.forEach(item => addMessage(item.role, item.content));
    }

    async function askAI(question) {
        const typingBubble = addTypingBubble();
        if (sendBtn) sendBtn.disabled = true;

        try {
            const context = buildAIContext();
            const history = conversation.slice(-8);

            const response = await fetch(AI_ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ question, context, history })
            });

            const data = await response.json().catch(() => ({}));

            typingBubble.remove();

            if (!response.ok) {
                addMessage("assistant", data.error || "Something went wrong. Please try again.");
                return;
            }

            if (!data.answer) {
                addMessage("assistant", "The AI assistant didn't return an answer. Please try again.");
                return;
            }

            addMessage("assistant", data.answer);
            conversation.push(
                { role: "user", content: question },
                { role: "assistant", content: data.answer }
            );
            conversation = conversation.slice(-12);
            saveHistory();
        } catch (err) {
            console.error("[ai-assistant] request failed:", err);
            typingBubble.remove();
            addMessage("assistant", "Couldn't reach the AI assistant. Check your connection and try again.");
        } finally {
            if (sendBtn) sendBtn.disabled = false;
        }
    }

    promptButtons.forEach(button => {
        button.addEventListener("click", () => {
            input.value = button.textContent;
            input.focus();
        });
    });

    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;

        if (emptyState) emptyState.classList.add("hidden");
        addMessage("user", text);
        input.value = "";

        askAI(text);
    });

    if (clearBtn) {
        clearBtn.addEventListener("click", () => {
            messagesEl.innerHTML = "";
            conversation = [];
            try { sessionStorage.removeItem(AI_HISTORY_KEY); } catch { /* no-op */ }
            if (emptyState) emptyState.classList.remove("hidden");
        });
    }
}

document.addEventListener("DOMContentLoaded", initAIAssistant);
