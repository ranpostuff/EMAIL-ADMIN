/* ==========================================================================
   RESCUEPRIORITY — AI ASSISTANT
   Connects the existing chat UI to the RescuePriority AI backend (a
   serverless function that calls Gemini). The Gemini API key never
   touches this file or the browser — see /api/ask-ai.js.

   Sends { question, context } to /api/ask-ai, where `context` comes from
   ai-context.js's buildAIContext() (live Firebase-backed data: active
   emergencies, incident stats, recent incidents, top classrooms/zones,
   resolution stats, time-of-day stats). Runs independently of script.js.
========================================================================== */

import { buildAIContext } from "./ai-context.js";

const AI_ENDPOINT = "/api/ask-ai";

function initAIAssistant() {
    const form = document.getElementById("ai-chat-form");
    const input = document.getElementById("ai-chat-input");
    const messagesEl = document.getElementById("ai-chat-messages");
    const emptyState = document.getElementById("ai-chat-empty-state");
    const clearBtn = document.getElementById("ai-chat-clear");
    const sendBtn = document.getElementById("ai-chat-send");
    const promptButtons = document.querySelectorAll(".ai-suggested-prompt");

    if (!form || !input || !messagesEl) return;

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

    async function askAI(question) {
        const typingBubble = addTypingBubble();
        if (sendBtn) sendBtn.disabled = true;

        try {
            const context = buildAIContext();

            const response = await fetch(AI_ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ question, context })
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
            if (emptyState) emptyState.classList.remove("hidden");
        });
    }
}

document.addEventListener("DOMContentLoaded", initAIAssistant);
