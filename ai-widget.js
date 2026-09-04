/* ==========================================================================
   RESCUEPRIORITY — FLOATING AI WIDGET (Analytics)
   ----------------------------------------------------------------------
   A compact floating chat, separate from the full AI Assistant page.
   Lives entirely inside #analytics-view in index.html, so script.js's
   existing view-switching "hidden" toggle shows/hides it automatically —
   no view-tracking logic needed here.

   Two ways to open it:
   1. The floating action button (bottom-right, visible on Analytics)
   2. Any "Ask AI" button on a chart card — opens the panel and
      immediately asks a question about that specific chart

   Shares the same backend (/api/ask-ai) and the same buildAIContext()
   data layer as the full AI Assistant — just a different, smaller UI.
   Runs independently of script.js and ai-assistant.js.
========================================================================== */

import { buildAIContext } from "./ai-context.js";

const AI_ENDPOINT = "/api/ask-ai";

function initAIWidget() {
    const fab = document.getElementById("ai-widget-fab");
    const panel = document.getElementById("ai-widget-panel");
    const closeBtn = document.getElementById("ai-widget-close");
    const form = document.getElementById("ai-widget-form");
    const input = document.getElementById("ai-widget-input");
    const messagesEl = document.getElementById("ai-widget-messages");
    const sendBtn = document.getElementById("ai-widget-send");
    const chartButtons = document.querySelectorAll(".ai-ask-chart-btn");

    if (!fab || !panel || !form || !input || !messagesEl) return;

    function openPanel() {
        panel.classList.remove("hidden");
        fab.classList.add("is-active");
        input.focus();
    }

    function closePanel() {
        panel.classList.add("hidden");
        fab.classList.remove("is-active");
    }

    function clearEmptyNote() {
        const note = messagesEl.querySelector(".ai-widget-empty-note");
        if (note) note.remove();
    }

    function addMessage(role, text) {
        clearEmptyNote();
        const bubble = document.createElement("div");
        bubble.className = `ai-chat-bubble ai-chat-bubble-${role}`;
        bubble.textContent = text;
        messagesEl.appendChild(bubble);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return bubble;
    }

    function addTypingBubble() {
        clearEmptyNote();
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
            console.error("[ai-widget] request failed:", err);
            typingBubble.remove();
            addMessage("assistant", "Couldn't reach the AI assistant. Check your connection and try again.");
        } finally {
            if (sendBtn) sendBtn.disabled = false;
        }
    }

    fab.addEventListener("click", () => {
        if (panel.classList.contains("hidden")) {
            openPanel();
        } else {
            closePanel();
        }
    });

    if (closeBtn) closeBtn.addEventListener("click", closePanel);

    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;

        addMessage("user", text);
        input.value = "";
        askAI(text);
    });

    // Each chart's "Ask AI" button opens the panel and immediately sends
    // a question naming that specific chart, so the AI's answer stays
    // focused on the chart the person actually clicked from.
    chartButtons.forEach(button => {
        button.addEventListener("click", () => {
            const chartTitle = button.dataset.chartTitle || "this chart";
            openPanel();
            const question = `What does the "${chartTitle}" chart mean?`;
            addMessage("user", question);
            askAI(question);
        });
    });
}

document.addEventListener("DOMContentLoaded", initAIWidget);
