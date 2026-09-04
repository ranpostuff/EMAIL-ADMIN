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

   TABLE / EXPORT SHAPE
     Deliberately mirrors latency-test.js's "auto trials" table and CSV
     one-for-one (same column pattern: trial, an id column, a start-time
     pair, an end-time pair, latency_ms, via) so both tools' exports drop
     into the same spreadsheet/report format. Here:
       incidentId      -> facilityId   (no real incident exists to name)
       submission_time -> the moment this simulated send started
       display_time    -> the moment it finished (Firebase lookup +
                           message compile + modeled network delay)
       via              -> always "simulated" (never "student-app"/"direct" —
                           nothing here is a real submission)
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

/* ==========================================================================
   CSV FIELD FORMATTING — same two workarounds as latency-test.js:
   wrap text-like ids as ="..." so Excel doesn't misread a leading "-" as
   a formula, and pair every epoch-ms column with a human-readable ISO
   column so epoch numbers don't collapse into scientific notation.
========================================================================== */
function csvTextLiteral(value) {
    const str = String(value ?? "");
    return `="${str.replace(/"/g, '""')}"`;
}

function csvIsoTimestamp(epochMs) {
    if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return "";
    return new Date(epochMs).toISOString().replace("T", " ").replace("Z", "");
}

function downloadBlob(content, mimeType, filename) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function summaryLine(stats) {
    if (!stats || !stats.count) return "No data.";
    return `n=${stats.count} · mean ${stats.meanMs}ms · median ${stats.medianMs}ms · min ${stats.minMs}ms · max ${stats.maxMs}ms · sd ${stats.stddevMs}ms`;
}

// Flattens the server's { batches: [{ items: [...] }] } shape into one
// row per simulated send, numbered 1..N across the whole run -- this flat
// list is what both the table and the CSV/JSON exports are built from.
function flattenToTrials(data) {
    let trial = 0;
    const trials = [];
    for (const batch of data.batches) {
        for (const item of batch.items) {
            trial += 1;
            trials.push({
                trial,
                facilityId: item.facilityId,
                submittedAt: item.startedAt,
                displayedAt: item.completedAt,
                latencyMs: item.totalMs,
                batchNumber: batch.batchNumber,
                recipientCount: item.recipientCount,
                via: "simulated"
            });
        }
    }
    return trials;
}

function buildPanel() {
    if (document.getElementById("rp-email-latency-panel")) return;

    const panel = document.createElement("div");
    panel.id = "rp-email-latency-panel";
    panel.style.cssText = [
        "position:fixed", "bottom:12px", "left:12px", "z-index:99999",
        "background:#1b1f27", "color:#e8e8e8", "font:12px/1.4 monospace",
        "border:1px solid #4aa3f5", "border-radius:8px", "padding:10px 12px",
        "width:380px", "max-height:560px", "overflow-y:auto", "box-shadow:0 4px 16px rgba(0,0,0,.4)"
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
                        <th style="padding:2px 4px;">Trial</th>
                        <th style="padding:2px 4px;">Facility ID</th>
                        <th style="padding:2px 4px;">Sub. Time</th>
                        <th style="padding:2px 4px;">Disp. Time</th>
                        <th style="padding:2px 4px;">Latency (ms)</th>
                    </tr>
                </thead>
                <tbody id="rp-el-tbody"></tbody>
            </table>
        </div>
        <div>
            <button id="rp-el-export-csv" style="font:11px monospace;cursor:pointer;">export trials csv</button>
            <button id="rp-el-export-json" style="font:11px monospace;cursor:pointer;">export trials json</button>
        </div>
    `;
    document.body.appendChild(panel);

    let lastTrials = [];
    let lastOverallStats = null;

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

            lastTrials = flattenToTrials(data);
            lastOverallStats = data.overall;

            overallEl.textContent = `Overall — ${summaryLine(data.overall)}`;
            progressEl.textContent = `Done. ${data.note}`;

            tbody.innerHTML = lastTrials.map((t) => `
                <tr>
                    <td style="padding:2px 4px;">${t.trial}</td>
                    <td style="padding:2px 4px;" title="batch ${t.batchNumber}, ${t.recipientCount} recipient(s)">${t.facilityId}</td>
                    <td style="padding:2px 4px;">${csvIsoTimestamp(t.submittedAt)}</td>
                    <td style="padding:2px 4px;">${csvIsoTimestamp(t.displayedAt)}</td>
                    <td style="padding:2px 4px;">${t.latencyMs.toFixed(1)}</td>
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

    document.getElementById("rp-el-export-csv").addEventListener("click", () => {
        if (!lastTrials.length) return;
        const header =
            "trial,facilityId,submission_time_ms,submission_time,display_time_ms,display_time,latency_ms,via";
        const rows = lastTrials.map((t) =>
            [
                t.trial,
                csvTextLiteral(t.facilityId),
                t.submittedAt,
                csvIsoTimestamp(t.submittedAt),
                t.displayedAt,
                csvIsoTimestamp(t.displayedAt),
                t.latencyMs,
                t.via
            ].join(",")
        );
        downloadBlob([header, ...rows].join("\n"), "text/csv", `rp-email-latency-trials-${Date.now()}.csv`);
    });

    document.getElementById("rp-el-export-json").addEventListener("click", () => {
        if (!lastTrials.length) return;
        downloadBlob(
            JSON.stringify({ trials: lastTrials, stats: lastOverallStats }, null, 2),
            "application/json",
            `rp-email-latency-trials-${Date.now()}.json`
        );
    });
}

if (isEmailLatencyTestModeEnabled()) {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", buildPanel);
    } else {
        buildPanel();
    }
}
