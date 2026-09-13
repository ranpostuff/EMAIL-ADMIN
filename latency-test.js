/* ==========================================================================
   RESCUEPRIORITY — SUBMIT \u2192 DASHBOARD LATENCY TEST (capstone testing only)
   --------------------------------------------------------------------------
   NOT a real product feature — this is instrumentation for the thesis
   Results chapter and stays completely inert unless test mode is turned on.
   No normal end user sees anything from this file.

   WHAT IT MEASURES
   incident.submitted_at   \u2014 written by the Student App (app.js), only when
                              ITS OWN latency test mode is on, at the moment
                              finalizeSend()/submitIncidentReport() actually
                              fires the write (performance.timeOrigin +
                              performance.now(), sub-ms precision).
   dashboard_update_time    \u2014 captured here, on this dashboard, the moment
                              the incident data has actually re-rendered.

   HOW "dashboard updated" IS DETECTED FOR THIS APP
   This dashboard already keeps incidents/ in sync over a live Firebase
   Realtime Database subscription: setupIncidentsListener() in script.js
   calls onValue(incidentsRootRef, ...), re-renders the incident list /
   stats / campus panels on every snapshot, and then dispatches a plain DOM
   event, "rp:incidents-updated", once that rendering finishes. That's the
   dashboard's actual update mechanism (websocket push, not polling), so
   this module listens for that same event \u2014 the only push channel this
   app has \u2014 and waits one requestAnimationFrame past it so the timestamp
   is taken after the browser has actually painted the change, not just
   after the JS handler returned.

   This file keeps its own lightweight onValue(incidents/) subscription
   purely to read record contents (submitted_at values) \u2014 same additive
   pattern as student-incident-panel.js. It does not modify or import
   anything from script.js's internals, and writes nothing to incidents/.

   TURNING TEST MODE ON
     Append ?latencytest=1 to the dashboard URL once. It's then remembered
     in localStorage (rp_latency_test) until you visit with ?latencytest=0.
     When on: a small debug panel appears bottom-right, every measurement is
     console.logged, and each is written to latencyLogs/{incidentKey} in
     Firebase (raw log, for pulling mean/median/min/max/SD afterward).

   REQUIRES: a database.rules.json entry for "latencyLogs" (added alongside
   this file \u2014 see database.rules.json in the student-app repo) so these
   writes aren't rejected by the RTDB rules. Redeploy rules before testing.
========================================================================== */

import { database } from "./script.js";
import { ref, onValue, push, set, update } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const incidentsRootRef = ref(database, "incidents");
const latencyLogRootRef = ref(database, "latencyLogs");

let latestIncidentsData = {};
let hasBaseline = false; // true once we've captured "already existed at page load"
const processedIncidentKeys = new Set();
const measurements = []; // in-memory, feeds the debug panel's stats

/* ==========================================================================
   AUTOMATED LATENCY TEST GENERATOR (Table 2 / Table 3 data collection)
   --------------------------------------------------------------------------
   Two ways to generate a trial's incident:

   1. STUDENT APP BRIDGE (preferred — a real submission)
      A hidden iframe loads the actual Student App (with its own
      ?latencytest=1 on), and each trial is a postMessage asking IT to run
      its real submitIncidentReport() write path (push + incident-number
      transaction + set, same as a genuine report) instead of this
      dashboard writing the record itself. That means the measured latency
      includes the Student App's own real submission-side overhead, not
      just this dashboard's.

   2. DIRECT WRITE (fallback)
      If no Student App URL is configured/connected, this file pushes the
      test incident itself — same as before. Still a real Firebase round
      trip, just without the Student App's own write-path overhead.

   Either way, the actual LATENCY MEASUREMENT is identical: this dashboard
   waits for its own real rp:incidents-updated signal (the same one a real
   incident triggers) and diffs against submitted_at. Once measured, the
   test incident is marked Resolved (not deleted) so a run of 100 trials
   doesn't leave 100 fake ACTIVE incidents in the live dashboard, while
   still leaving an auditable, filterable (isTestData: true) trail.
========================================================================== */
const AUTO_TEST_TIMEOUT_MS = 15000; // give up on a trial that never shows up
const AUTO_TEST_TRIAL_GAP_MS = 150; // small pause between trials
const STUDENT_BRIDGE_READY_TIMEOUT_MS = 8000;
const STUDENT_BRIDGE_URL_STORAGE_KEY = "rp_latency_student_url";

let autoTestRunning = false;
let autoTestAbort = false;
let autoTestResults = []; // [{ trial, incidentId, submittedAt, dashboardUpdateTime, latencyMs, error? }]
const pendingAutoResolvers = new Map(); // incidentId -> { resolve(entry) }
const completedAutoMeasurements = new Map(); // incidentId -> entry, for measurements that finished before a waiter was registered
const COMPLETED_AUTO_MEASUREMENTS_CAP = 500; // safety cap so this never grows unbounded in a long session

const studentBridge = {
    iframe: null,
    ready: false,
    origin: null,
    url: null,
    pendingSubmitRequests: new Map() // requestId -> { resolve, reject }
};

/* ==========================================================================
   TEST MODE TOGGLE
========================================================================== */
function isLatencyTestModeEnabled() {
    try {
        const params = new URLSearchParams(window.location.search);
        if (params.get("latencytest") === "1") localStorage.setItem("rp_latency_test", "1");
        if (params.get("latencytest") === "0") localStorage.removeItem("rp_latency_test");
        return localStorage.getItem("rp_latency_test") === "1";
    } catch (e) {
        return false;
    }
}

function highResTimestamp() {
    if (typeof performance !== "undefined" && performance.now && performance.timeOrigin) {
        return performance.timeOrigin + performance.now();
    }
    return Date.now();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ==========================================================================
   SETUP
========================================================================== */
document.addEventListener("DOMContentLoaded", () => {
    if (!isLatencyTestModeEnabled()) return;

    console.log(
        "%c[RescuePriority] Latency test mode ON \u2014 measuring submit\u2192dashboard latency. " +
            "Only incidents carrying submitted_at (from a Student App also in test mode) are measured.",
        "color:#f5a623;font-weight:bold;"
    );

    buildDebugPanel();

    // Own data cache, read-only, additive \u2014 does not touch script.js.
    onValue(incidentsRootRef, (snapshot) => {
        latestIncidentsData = snapshot.val() || {};
        if (!hasBaseline) {
            // Whatever's already in the DB when the dashboard loads is the
            // baseline, not a "new" arrival \u2014 mark it seen without logging.
            Object.keys(latestIncidentsData).forEach((key) => processedIncidentKeys.add(key));
            hasBaseline = true;
        }
    });

    // The actual "dashboard just updated" signal \u2014 dispatched by script.js
    // after it finishes rendering a fresh incidents/ snapshot.
    window.addEventListener("rp:incidents-updated", handleIncidentsUpdated);

    // Cross-app bridge: listen for the Student App's ready/ack messages.
    window.addEventListener("message", handleStudentBridgeMessage);

    // Auto-reconnect if a Student App URL was saved from a previous session.
    const savedUrl = localStorage.getItem(STUDENT_BRIDGE_URL_STORAGE_KEY);
    if (savedUrl) connectStudentApp(savedUrl);
});

function handleIncidentsUpdated() {
    requestAnimationFrame(() => {
        const dashboardUpdateTime = highResTimestamp();
        checkForNewSubmissions(dashboardUpdateTime);
    });
}

function checkForNewSubmissions(dashboardUpdateTime) {
    Object.entries(latestIncidentsData).forEach(([key, record]) => {
        if (processedIncidentKeys.has(key)) return;
        processedIncidentKeys.add(key);

        if (!record || typeof record.submitted_at !== "number") return; // not a latency-test submission

        recordMeasurement(key, record.submitted_at, dashboardUpdateTime);
    });
}

/* ==========================================================================
   STUDENT APP BRIDGE — hidden iframe + postMessage handshake
   --------------------------------------------------------------------------
   The Student App (app.js) has its own matching bridge that only activates
   when it's (a) in its own latency test mode and (b) actually embedded in
   an iframe. It posts "rp-latency-ready" once loaded, and answers
   "rp-latency-run-trial" requests with "rp-latency-trial-submitted"
   (containing the real incidentId + submittedAt from ITS OWN write) or
   "rp-latency-trial-failed".
========================================================================== */
function connectStudentApp(rawUrl) {
    const url = (rawUrl || "").trim();
    if (!url) return;

    disconnectStudentApp();

    let resolvedUrl;
    try {
        resolvedUrl = new URL(url, window.location.href);
    } catch (e) {
        setBridgeStatus("Invalid URL.", false);
        return;
    }

    // Make sure the Student App's own latency test mode gets turned on too.
    resolvedUrl.searchParams.set("latencytest", "1");

    studentBridge.url = url;
    studentBridge.origin = resolvedUrl.origin;
    studentBridge.ready = false;
    localStorage.setItem(STUDENT_BRIDGE_URL_STORAGE_KEY, url);

    const iframe = document.createElement("iframe");
    iframe.id = "rp-latency-student-frame";
    iframe.style.cssText = "display:none;width:0;height:0;border:0;";
    iframe.src = resolvedUrl.toString();
    document.body.appendChild(iframe);
    studentBridge.iframe = iframe;

    setBridgeStatus("Connecting\u2026", null);

    setTimeout(() => {
        if (!studentBridge.ready) {
            setBridgeStatus("No response \u2014 check the URL, or it isn't in test mode. Falling back to direct writes.", false);
        }
    }, STUDENT_BRIDGE_READY_TIMEOUT_MS);
}

function disconnectStudentApp() {
    if (studentBridge.iframe && studentBridge.iframe.parentNode) {
        studentBridge.iframe.parentNode.removeChild(studentBridge.iframe);
    }
    studentBridge.iframe = null;
    studentBridge.ready = false;
    studentBridge.origin = null;
    studentBridge.pendingSubmitRequests.forEach(({ reject }) => reject(new Error("Student App disconnected")));
    studentBridge.pendingSubmitRequests.clear();
}

function handleStudentBridgeMessage(event) {
    const msg = event.data;
    if (!msg || msg.source !== "rp-latency-student") return;
    if (studentBridge.origin && event.origin !== studentBridge.origin) return;

    if (msg.type === "rp-latency-ready") {
        studentBridge.ready = true;
        setBridgeStatus("Connected \u2014 trials will submit through the Student App.", true);
        return;
    }

    if (msg.type === "rp-latency-trial-submitted" || msg.type === "rp-latency-trial-failed") {
        const pending = studentBridge.pendingSubmitRequests.get(msg.requestId);
        if (!pending) return;
        studentBridge.pendingSubmitRequests.delete(msg.requestId);
        if (msg.type === "rp-latency-trial-submitted") {
            pending.resolve({ incidentId: msg.incidentId, submittedAt: msg.submittedAt });
        } else {
            pending.reject(new Error(msg.error || "Student App reported a failed submission"));
        }
    }
}

// Ask the connected Student App to run one real submission for this trial.
// Resolves with the incidentId/submittedAt it actually wrote.
function requestStudentAppSubmission(trialIndex) {
    return new Promise((resolve, reject) => {
        if (!studentBridge.ready || !studentBridge.iframe) {
            reject(new Error("Student App not connected"));
            return;
        }

        const requestId = `t${trialIndex}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const timeoutHandle = setTimeout(() => {
            studentBridge.pendingSubmitRequests.delete(requestId);
            reject(new Error("Student App submission timed out"));
        }, AUTO_TEST_TIMEOUT_MS);

        studentBridge.pendingSubmitRequests.set(requestId, {
            resolve: (payload) => {
                clearTimeout(timeoutHandle);
                resolve(payload);
            },
            reject: (err) => {
                clearTimeout(timeoutHandle);
                reject(err);
            }
        });

        studentBridge.iframe.contentWindow.postMessage(
            { source: "rp-latency-admin", type: "rp-latency-run-trial", trialIndex, requestId },
            studentBridge.origin
        );
    });
}

function setBridgeStatus(text, connected) {
    const el = document.getElementById("rp-bridge-status");
    if (!el) return;
    el.textContent = text;
    el.style.color = connected === true ? "#3ecf6e" : connected === false ? "#e5484d" : "#e8e8e8";
}

/* ==========================================================================
   LOGGING
========================================================================== */
function recordMeasurement(incidentId, submittedAt, dashboardUpdateTime) {
    const latencyMs = dashboardUpdateTime - submittedAt;
    const entry = {
        incidentId,
        submitted_at: submittedAt,
        dashboard_update_time: dashboardUpdateTime,
        latency_ms: latencyMs,
        latency_sec: latencyMs / 1000,
        recorded_at: Date.now()
    };

    measurements.push(entry);

    console.log(
        `[RescuePriority][latency] ${incidentId}: ${latencyMs.toFixed(1)} ms (${(latencyMs / 1000).toFixed(3)} s)`
    );

    const logRef = push(latencyLogRootRef);
    set(logRef, entry).catch((err) => {
        console.error(
            "[RescuePriority][latency] Failed to write latencyLogs entry \u2014 check that database.rules.json " +
                "has a rule for \"latencyLogs\" and that it's been deployed.",
            err
        );
    });

    updateDebugPanel();

    // If an automated trial is already waiting on this exact incident, hand
    // it the measurement now. Otherwise the trial may not have registered
    // its waiter yet (the bridge's cross-iframe ack can arrive after this
    // dashboard's own onValue listener already saw the write) — buffer it
    // so waitForMeasurement() can pick it up the moment it does register.
    const pending = pendingAutoResolvers.get(incidentId);
    if (pending) {
        pendingAutoResolvers.delete(incidentId);
        pending.resolve(entry);
    } else {
        if (completedAutoMeasurements.size >= COMPLETED_AUTO_MEASUREMENTS_CAP) {
            const oldestKey = completedAutoMeasurements.keys().next().value;
            completedAutoMeasurements.delete(oldestKey);
        }
        completedAutoMeasurements.set(incidentId, entry);
    }
}

/* ==========================================================================
   STATS
========================================================================== */
function computeStats(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const mean = sum / sorted.length;
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length;
    return {
        n: sorted.length,
        mean,
        median,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        sd: Math.sqrt(variance)
    };
}

/* ==========================================================================
   DEBUG PANEL (only ever built/shown when test mode is on)
========================================================================== */
function buildDebugPanel() {
    if (document.getElementById("rp-latency-panel")) return;

    const panel = document.createElement("div");
    panel.id = "rp-latency-panel";
    panel.style.cssText = [
        "position:fixed", "bottom:12px", "right:12px", "z-index:99999",
        "background:#1b1f27", "color:#e8e8e8", "font:12px/1.4 monospace",
        "border:1px solid #f5a623", "border-radius:8px", "padding:10px 12px",
        "width:360px", "max-height:560px", "overflow-y:auto", "box-shadow:0 4px 16px rgba(0,0,0,.4)"
    ].join(";");

    panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <strong style="color:#f5a623;">LATENCY TEST MODE</strong>
            <span>
                <button id="rp-latency-export" style="font:11px monospace;cursor:pointer;">csv</button>
                <button id="rp-latency-export-json" style="font:11px monospace;cursor:pointer;">json</button>
            </span>
        </div>
        <div style="opacity:.7;margin-bottom:2px;">Manual (submissions from a test-mode Student App)</div>
        <div id="rp-latency-stats">No measurements yet.</div>
        <div id="rp-latency-list" style="margin-top:4px;"></div>

        <hr style="border:none;border-top:1px solid #333;margin:10px 0;" />

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <strong style="color:#f5a623;">STUDENT APP CONNECTION</strong>
        </div>
        <div style="opacity:.7;margin-bottom:4px;">
            Optional \u2014 route trials through a real Student App submission
            instead of this dashboard writing directly.
        </div>
        <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px;">
            <input id="rp-bridge-url" type="text" placeholder="Student App URL (e.g. ../student-2.0-main/index.html)"
                   style="flex:1;font:11px monospace;background:#0f1116;color:#e8e8e8;border:1px solid #444;border-radius:4px;padding:2px 4px;" />
            <button id="rp-bridge-connect" style="font:11px monospace;cursor:pointer;">connect</button>
        </div>
        <div id="rp-bridge-status" style="margin-bottom:6px;opacity:.85;">Not connected \u2014 trials will write directly.</div>

        <hr style="border:none;border-top:1px solid #333;margin:10px 0;" />

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <strong style="color:#f5a623;">AUTOMATED TEST GENERATOR</strong>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;">
            <button class="rp-auto-run" data-n="10" style="font:11px monospace;cursor:pointer;">run 10</button>
            <button class="rp-auto-run" data-n="30" style="font:11px monospace;cursor:pointer;">run 30</button>
            <button class="rp-auto-run" data-n="50" style="font:11px monospace;cursor:pointer;">run 50</button>
            <button class="rp-auto-run" data-n="100" style="font:11px monospace;cursor:pointer;">run 100</button>
        </div>
        <div style="display:flex;gap:4px;align-items:center;margin-bottom:6px;">
            <input id="rp-auto-custom-n" type="number" min="1" max="1000" placeholder="custom n"
                   style="width:70px;font:11px monospace;background:#0f1116;color:#e8e8e8;border:1px solid #444;border-radius:4px;padding:2px 4px;" />
            <button id="rp-auto-run-custom" style="font:11px monospace;cursor:pointer;">run</button>
            <button id="rp-auto-stop" style="font:11px monospace;cursor:pointer;" disabled>stop</button>
        </div>
        <div id="rp-auto-progress" style="opacity:.8;margin-bottom:6px;">Idle.</div>
        <div id="rp-auto-stats" style="margin-bottom:4px;">No automated trials yet.</div>
        <div style="max-height:160px;overflow-y:auto;border:1px solid #333;border-radius:4px;margin-bottom:6px;">
            <table id="rp-auto-table" style="width:100%;border-collapse:collapse;font-size:11px;">
                <thead>
                    <tr style="text-align:left;color:#f5a623;">
                        <th style="padding:2px 4px;">Trial</th>
                        <th style="padding:2px 4px;">Incident ID</th>
                        <th style="padding:2px 4px;">Sub. Time</th>
                        <th style="padding:2px 4px;">Disp. Time</th>
                        <th style="padding:2px 4px;">Latency (ms)</th>
                    </tr>
                </thead>
                <tbody id="rp-auto-tbody"></tbody>
            </table>
        </div>
        <div>
            <button id="rp-auto-export-csv" style="font:11px monospace;cursor:pointer;">export trials csv</button>
            <button id="rp-auto-export-json" style="font:11px monospace;cursor:pointer;">export trials json</button>
        </div>
    `;
    document.body.appendChild(panel);

    document.getElementById("rp-latency-export").addEventListener("click", () => exportCsv(measurements, "rp-latency-log"));
    document.getElementById("rp-latency-export-json").addEventListener("click", () => exportJson(measurements, "rp-latency-log"));

    const bridgeUrlInput = document.getElementById("rp-bridge-url");
    const savedBridgeUrl = localStorage.getItem(STUDENT_BRIDGE_URL_STORAGE_KEY);
    if (savedBridgeUrl && bridgeUrlInput) bridgeUrlInput.value = savedBridgeUrl;
    document.getElementById("rp-bridge-connect").addEventListener("click", () => {
        connectStudentApp(bridgeUrlInput.value);
    });

    panel.querySelectorAll(".rp-auto-run").forEach((btn) => {
        btn.addEventListener("click", () => runAutomatedTest(parseInt(btn.dataset.n, 10)));
    });
    document.getElementById("rp-auto-run-custom").addEventListener("click", () => {
        const n = parseInt(document.getElementById("rp-auto-custom-n").value, 10);
        if (Number.isFinite(n) && n > 0) runAutomatedTest(n);
    });
    document.getElementById("rp-auto-stop").addEventListener("click", () => {
        autoTestAbort = true;
    });
    document.getElementById("rp-auto-export-csv").addEventListener("click", () => exportAutoTestCsv());
    document.getElementById("rp-auto-export-json").addEventListener("click", () => exportAutoTestJson());
}

function updateDebugPanel() {
    const statsEl = document.getElementById("rp-latency-stats");
    const listEl = document.getElementById("rp-latency-list");
    if (!statsEl || !listEl) return;

    const stats = computeStats(measurements.map((m) => m.latency_ms));
    statsEl.textContent = stats
        ? `n=${stats.n}  mean=${stats.mean.toFixed(0)}ms  median=${stats.median.toFixed(0)}ms  ` +
          `min=${stats.min.toFixed(0)}ms  max=${stats.max.toFixed(0)}ms  sd=${stats.sd.toFixed(0)}ms`
        : "No measurements yet.";

    const recent = measurements.slice(-8).reverse();
    listEl.innerHTML = recent
        .map((m) => `<div>${m.incidentId}: ${m.latency_ms.toFixed(0)}ms</div>`)
        .join("");
}

/* ==========================================================================
   CSV FIELD FORMATTING
   --------------------------------------------------------------------------
   Two spreadsheet-import quirks these exports need to work around:

   1. Firebase push keys always start with "-" (e.g. "-P0ZR5h-3JGx...").
      Excel/Sheets auto-detect a leading "-" as the start of a formula, try
      to parse the rest as an expression, fail, and show #NAME?. Wrapping
      the value as ="-P0ZR5h..." makes it a literal-text formula instead —
      Excel evaluates it to exactly that string, dash and all, no error.

   2. Millisecond epoch timestamps (~1.79e12) get rendered in scientific
      notation by a "General"-formatted numeric CSV cell. Exporting the
      epoch as a still-precise number AND a separate human-readable
      ISO string column sidesteps that — the ISO column is never
      re-interpreted as a number, so it never collapses to 1.79E+12.
========================================================================== */
function csvTextLiteral(value) {
    const str = String(value ?? "");
    return `="${str.replace(/"/g, '""')}"`;
}

function csvIsoTimestamp(epochMs) {
    if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return "";
    return new Date(epochMs).toISOString().replace("T", " ").replace("Z", "");
}

function exportCsv(rows, filenamePrefix) {
    const header =
        "incidentId,submitted_at_ms,submitted_at,dashboard_update_time_ms,dashboard_update_time," +
        "latency_ms,latency_sec,recorded_at_ms,recorded_at";
    const lines = rows.map((m) =>
        [
            csvTextLiteral(m.incidentId),
            m.submitted_at,
            csvIsoTimestamp(m.submitted_at),
            m.dashboard_update_time,
            csvIsoTimestamp(m.dashboard_update_time),
            m.latency_ms,
            m.latency_sec,
            m.recorded_at,
            csvIsoTimestamp(m.recorded_at)
        ].join(",")
    );
    downloadBlob([header, ...lines].join("\n"), "text/csv", `${filenamePrefix}-${Date.now()}.csv`);
}

function exportJson(rows, filenamePrefix) {
    downloadBlob(JSON.stringify(rows, null, 2), "application/json", `${filenamePrefix}-${Date.now()}.json`);
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

/* ==========================================================================
   AUTOMATED TEST GENERATOR — runner + UI wiring
========================================================================== */

// Waits for THIS dashboard's own measurement of a given incidentId (i.e.
// its rp:incidents-updated → checkForNewSubmissions → recordMeasurement
// pipeline actually observing it), regardless of who wrote the record.
function waitForMeasurement(key) {
    // The measurement can arrive before this function is even called — the
    // dashboard's own onValue(incidents/) listener runs independently of
    // the bridge handshake and often wins that race. Check the buffer of
    // already-completed measurements first so we don't miss it.
    const already = completedAutoMeasurements.get(key);
    if (already) {
        completedAutoMeasurements.delete(key);
        return Promise.resolve(already);
    }

    return new Promise((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
            pendingAutoResolvers.delete(key);
            reject({ incidentId: key, timeout: true });
        }, AUTO_TEST_TIMEOUT_MS);

        pendingAutoResolvers.set(key, {
            resolve: (entry) => {
                clearTimeout(timeoutHandle);
                resolve(entry);
            }
        });
    });
}

// Marks a test incident Resolved instead of deleting it, so a run of 100
// trials clears itself out of "Active" without erasing the audit trail —
// still filterable afterward via isTestData / reportedVia.
function markTestIncidentResolved(key) {
    return update(ref(database, `incidents/${key}`), {
        status: "Resolved",
        resolvedAt: Date.now()
    }).catch((err) => {
        console.error("[RescuePriority][latency][auto] Failed to auto-resolve test incident", key, err);
    });
}

// Path 1 — direct write: this dashboard pushes the test incident itself.
function submitDirectTestIncident(trialIndex) {
    const testRef = push(incidentsRootRef);
    const key = testRef.key;
    const submittedAt = highResTimestamp();

    const payload = {
        incidentNumber: `LATENCY-TEST-${trialIndex}`,
        timestamp: Date.now(),
        classroom: "LATENCY-TEST",
        grade: null,
        status: "Reported",
        studentId: `LATENCY-TEST-${trialIndex}`,
        studentName: "Automated Latency Test",
        incidentType: "Latency Test",
        roomWide: false,
        description: null,
        reportedVia: "latency-test-generator",
        isTestData: true,
        facilityId: null,
        locationOverridden: false,
        submitted_at: submittedAt
    };

    return set(testRef, payload).then(() => ({ incidentId: key, submittedAt }));
}

// Runs one full trial: submit (via the Student App bridge if connected,
// otherwise directly), wait for this dashboard's own measurement of it,
// then mark it Resolved.
async function runSingleAutomatedTrial(trialIndex) {
    const usingBridge = studentBridge.ready;
    const { incidentId, submittedAt } = usingBridge
        ? await requestStudentAppSubmission(trialIndex)
        : await submitDirectTestIncident(trialIndex);

    let entry;
    try {
        entry = await waitForMeasurement(incidentId);
    } finally {
        markTestIncidentResolved(incidentId);
    }

    return {
        trial: trialIndex,
        incidentId,
        submittedAt: entry.submitted_at,
        dashboardUpdateTime: entry.dashboard_update_time,
        latencyMs: entry.latency_ms,
        viaStudentApp: usingBridge
    };
}

async function runAutomatedTest(totalTrials) {
    if (autoTestRunning || !Number.isFinite(totalTrials) || totalTrials <= 0) return;

    autoTestRunning = true;
    autoTestAbort = false;
    autoTestResults = [];
    setAutoControlsEnabled(false);
    renderAutoResultsTable();
    renderAutoSummary();

    for (let i = 1; i <= totalTrials; i++) {
        if (autoTestAbort) break;

        setAutoProgress(
            `Running trial ${i} of ${totalTrials} (${studentBridge.ready ? "via Student App" : "direct write"})...`
        );
        try {
            const result = await runSingleAutomatedTrial(i);
            autoTestResults.push(result);
        } catch (err) {
            const incidentId = (err && err.incidentId) || "(none)";
            const isTimeout = !!(err && err.timeout);
            const message = err instanceof Error ? err.message : isTimeout ? "timeout" : "write failed";
            autoTestResults.push({
                trial: i,
                incidentId,
                submittedAt: (err && err.submittedAt) || null,
                dashboardUpdateTime: null,
                latencyMs: null,
                error: message
            });
            console.error("[RescuePriority][latency][auto] Trial", i, "failed:", err);
        }

        renderAutoResultsTable();
        renderAutoSummary();

        if (i < totalTrials && !autoTestAbort) await sleep(AUTO_TEST_TRIAL_GAP_MS);
    }

    autoTestRunning = false;
    autoTestAbort = false;
    setAutoControlsEnabled(true);
    setAutoProgress(
        `Done — ${autoTestResults.filter((r) => !r.error).length}/${autoTestResults.length} trial(s) measured.`
    );
}

function setAutoControlsEnabled(enabled) {
    const panel = document.getElementById("rp-latency-panel");
    if (!panel) return;
    panel.querySelectorAll(".rp-auto-run, #rp-auto-run-custom").forEach((el) => (el.disabled = !enabled));
    const stopBtn = document.getElementById("rp-auto-stop");
    if (stopBtn) stopBtn.disabled = enabled;
}

function setAutoProgress(text) {
    const el = document.getElementById("rp-auto-progress");
    if (el) el.textContent = text;
}

function renderAutoResultsTable() {
    const tbody = document.getElementById("rp-auto-tbody");
    if (!tbody) return;
    tbody.innerHTML = autoTestResults
        .map((r) => {
            const via = r.viaStudentApp ? "student app" : "direct";
            if (r.error) {
                return `<tr>
                    <td style="padding:2px 4px;">${r.trial}</td>
                    <td style="padding:2px 4px;">${r.incidentId}</td>
                    <td style="padding:2px 4px;" colspan="3">${r.error}</td>
                </tr>`;
            }
            return `<tr>
                <td style="padding:2px 4px;">${r.trial}</td>
                <td style="padding:2px 4px;" title="${via}">${r.incidentId}</td>
                <td style="padding:2px 4px;">${r.submittedAt.toFixed(0)}</td>
                <td style="padding:2px 4px;">${r.dashboardUpdateTime.toFixed(0)}</td>
                <td style="padding:2px 4px;">${r.latencyMs.toFixed(0)}</td>
            </tr>`;
        })
        .join("");
}

function renderAutoSummary() {
    const el = document.getElementById("rp-auto-stats");
    if (!el) return;
    const values = autoTestResults.filter((r) => !r.error).map((r) => r.latencyMs);
    const stats = computeStats(values);
    el.textContent = stats
        ? `n=${stats.n}  mean=${stats.mean.toFixed(1)}ms  median=${stats.median.toFixed(1)}ms  ` +
          `min=${stats.min.toFixed(0)}ms  max=${stats.max.toFixed(0)}ms  sd=${stats.sd.toFixed(1)}ms`
        : "No automated trials yet.";
}

function exportAutoTestCsv() {
    const header =
        "trial,incidentId,submission_time_ms,submission_time,display_time_ms,display_time,latency_ms,via";
    const rows = autoTestResults.map((r) =>
        r.error
            ? [r.trial, csvTextLiteral(r.incidentId), "", "", "", "", `ERROR:${r.error}`, ""].join(",")
            : [
                  r.trial,
                  csvTextLiteral(r.incidentId),
                  r.submittedAt,
                  csvIsoTimestamp(r.submittedAt),
                  r.dashboardUpdateTime,
                  csvIsoTimestamp(r.dashboardUpdateTime),
                  r.latencyMs,
                  r.viaStudentApp ? "student-app" : "direct"
              ].join(",")
    );
    downloadBlob([header, ...rows].join("\n"), "text/csv", `rp-latency-auto-trials-${Date.now()}.csv`);
}

function exportAutoTestJson() {
    const stats = computeStats(autoTestResults.filter((r) => !r.error).map((r) => r.latencyMs));
    downloadBlob(
        JSON.stringify({ trials: autoTestResults, stats }, null, 2),
        "application/json",
        `rp-latency-auto-trials-${Date.now()}.json`
    );
}
