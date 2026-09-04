/* ==========================================================================
   RESCUEPRIORITY — EMAIL LATENCY TEST PANEL (capstone testing only)
   --------------------------------------------------------------------------
   NOT a real product feature — same family as latency-test.js and
   facilities-test.js, completely inert unless test mode is on. Drives
   api/email-latency-test.js, which simulates the batch-email pipeline
   (real Firebase routing lookups + real nodemailer message compilation)
   WITHOUT ever sending a real email — see that file's header comment for
   exactly how the "no real send" guarantee works.

   TURNING TEST MODE ON
     Append ?htmlemail=3 to the dashboard URL once. It's then remembered
     in localStorage (rp_email_latency_test) until you visit with
     ?htmlemail=0. When on, a debug panel appears bottom-left (the
     submit->dashboard latency panel already occupies bottom-right).
========================================================================== */

const ALERT_API_BASE_URL = "https://email-admin-alerts.vercel.app";

function isEmailLatencyTestModeEnabled() {
    try {
        const params = new URLSearchParams(window.location.search);
        if (params.get("htmlemail") === "3") localStorage.setItem("rp_email_latency_test", "1");
        if (params.get("htmlemail") === "0") localStorage.removeItem("rp_email_latency_test");
        return localStorage.getItem("rp_email_latency_test") === "1";
    } catch (e) {
        return false;
    }
}

function summaryLine(stats) {
    if (!stats || !stats.count) return "No data.";
    return `n=${stats.count} · mean ${stats.meanMs}ms · median ${stats.medianMs}ms · min ${stats.minMs}ms · max ${stats.maxMs}ms · sd ${stats.stddevMs}ms`;
}

function buildPanel() {
    if (document.getElementById("rp-email-latency-panel")) return;

    const panel = document.createElement("div");
    panel.id = "rp-email-latency-panel";
    panel.style.cssText = [
        "position:fixed", "bottom:12px", "left:12px", "z-index:99999",
        "background:#1b1f27", "color:#e8e8e8", "font:12px/1.4 monospace",
        "border:1px solid #4aa3f5", "border-radius:8px", "padding:10px 12px",
        "width:360px", "max-height:520px", "overflow-y:auto", "box-shadow:0 4px 16px rgba(0,0,0,.4)"
    ].join(";");

    panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <strong style="color:#4aa3f5;">EMAIL LATENCY SIM (no real sends)</strong>
        </div>
        <div style="opacity:.7;margin-bottom:6px;">
            Simulates the batch-email pipeline (real Firebase lookups + real
            message compile via nodemailer jsonTransport) with a modeled SMTP
            delay swapped in for the actual network send. Zero real emails.
        </div>
        <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px;">
            <label style="opacity:.8;">batch size</label>
            <input id="rp-el-batch-size" type="number" min="1" max="50" value="5"
                   style="width:50px;font:11px monospace;background:#0f1116;color:#e8e8e8;border:1px solid #444;border-radius:4px;padding:2px 4px;" />
            <label style="opacity:.8;">batches</label>
            <input id="rp-el-batch-count" type="number" min="1" max="20" value="3"
                   style="width:50px;font:11px monospace;background:#0f1116;color:#e8e8e8;border:1px solid #444;border-radius:4px;padding:2px 4px;" />
        </div>
        <div style="margin-bottom:6px;">
            <button id="rp-el-run" style="font:11px monospace;cursor:pointer;">run simulation</button>
            <span id="rp-el-progress" style="opacity:.8;margin-left:6px;">Idle.</span>
        </div>
        <div id="rp-el-overall" style="margin-bottom:6px;">No run yet.</div>
        <div style="max-height:220px;overflow-y:auto;border:1px solid #333;border-radius:4px;margin-bottom:6px;">
            <table id="rp-el-table" style="width:100%;border-collapse:collapse;font-size:11px;">
                <thead>
                    <tr style="text-align:left;color:#4aa3f5;">
                        <th style="padding:2px 4px;">Batch</th>
                        <th style="padding:2px 4px;">Size</th>
                        <th style="padding:2px 4px;">Wall (ms)</th>
                        <th style="padding:2px 4px;">Mean (ms)</th>
                        <th style="padding:2px 4px;">Max (ms)</th>
                    </tr>
                </thead>
                <tbody id="rp-el-tbody"></tbody>
            </table>
        </div>
        <div>
            <button id="rp-el-export-json" style="font:11px monospace;cursor:pointer;">export json</button>
        </div>
    `;
    document.body.appendChild(panel);

    let lastRunResult = null;

    document.getElementById("rp-el-run").addEventListener("click", async () => {
        const runBtn = document.getElementById("rp-el-run");
        const progressEl = document.getElementById("rp-el-progress");
        const overallEl = document.getElementById("rp-el-overall");
        const tbody = document.getElementById("rp-el-tbody");

        const batchSize = Number(document.getElementById("rp-el-batch-size").value) || 5;
        const batchCount = Number(document.getElementById("rp-el-batch-count").value) || 1;

        runBtn.disabled = true;
        progressEl.textContent = `Running ${batchCount} batch(es) of ${batchSize}...`;
        tbody.innerHTML = "";
        overallEl.textContent = "Running...";

        try {
            const response = await fetch(`${ALERT_API_BASE_URL}/api/email-latency-test`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ batchSize, batchCount })
            });
            const data = await response.json();

            if (!response.ok || !data.ok) {
                overallEl.textContent = `Error: ${data.error || response.statusText}`;
                progressEl.textContent = "Failed.";
                return;
            }

            lastRunResult = data;
            overallEl.textContent = `Overall — ${summaryLine(data.overall)}`;
            progressEl.textContent = `Done. ${data.note}`;

            tbody.innerHTML = data.batches.map((batch) => `
                <tr>
                    <td style="padding:2px 4px;">${batch.batchNumber}</td>
                    <td style="padding:2px 4px;">${batch.items.length}</td>
                    <td style="padding:2px 4px;">${batch.batchWallMs}</td>
                    <td style="padding:2px 4px;">${batch.stats.meanMs}</td>
                    <td style="padding:2px 4px;">${batch.stats.maxMs}</td>
                </tr>
            `).join("");
        } catch (error) {
            console.error("[email-latency-test] Run failed:", error);
            overallEl.textContent = `Error: ${error.message}`;
            progressEl.textContent = "Failed.";
        } finally {
            runBtn.disabled = false;
        }
    });

    document.getElementById("rp-el-export-json").addEventListener("click", () => {
        if (!lastRunResult) return;
        const blob = new Blob([JSON.stringify(lastRunResult, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `rp-email-latency-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });
}

if (isEmailLatencyTestModeEnabled()) {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", buildPanel);
    } else {
        buildPanel();
    }
}
