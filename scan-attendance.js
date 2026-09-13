/* ==========================================================================
   RESCUEPRIORITY — SCAN ATTENDANCE MODULE
   --------------------------------------------------------------------------
   Additive module. Does NOT touch classrooms/, incidents/, or counters/.
   Reuses the existing Firebase connection from script.js and the live
   students/ cache from students.js instead of opening a second listener.

   New Firebase path owned by this file:
     attendance/{logId} -> studentId, facilityId, timestamp, direction

   Scanning is browser/camera-based (html5-qrcode, loaded via <script> in
   index.html, exposes window.Html5Qrcode) per the decision to start with
   web-based scanning rather than new dedicated hardware. QR payload is the
   student's LRN only (see students.js) — the studentId/section/facility
   correlation happens here, via a database lookup, at scan time.

   ACCESS CONTROL — STILL UNDECIDED (see planning doc point 5):
   RescuePriority currently has no auth system at all, and who exactly
   holds the scanning device (gate personnel vs. a lower-trust user vs.
   self-service by students) hasn't been decided yet. SCAN_PASSCODE below
   is a placeholder single shared passcode — good enough to stop a casual
   passer-by from opening this view, NOT a real access-control system.
   Replace this once the access model is decided.
========================================================================== */

import { database } from "./script.js";
import { studentsState } from "./students.js";
import {
    ref,
    push,
    set,
    query,
    orderByChild,
    startAt,
    onValue
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const attendanceRootRef = ref(database, "attendance");

/* TODO(access-control): placeholder only — see header note above. */
const SCAN_PASSCODE = "1234";
const SESSION_UNLOCK_KEY = "rp_scan_unlocked";

const DUPLICATE_WINDOW_MS = 8000; // ignore repeat scans of the same LRN within this window

let currentDirection = "in";
let html5QrInstance = null;
let cameraRunning = false;
let lastScan = { lrn: null, at: 0 };

/* ==========================================================================
   INITIALIZATION
========================================================================== */
document.addEventListener("DOMContentLoaded", () => {
    initScanAttendanceModule();
});

function initScanAttendanceModule() {
    setupPasscodeGate();
    setupDirectionToggle();
    setupCameraControls();
    setupManualEntry();
    setupLiveStats();

    if (sessionStorage.getItem(SESSION_UNLOCK_KEY) === "1") {
        unlockScanPanel();
    }
}

/* ==========================================================================
   PASSCODE GATE (placeholder — see header note)
========================================================================== */
function setupPasscodeGate() {
    const form = document.getElementById("scan-passcode-form");
    const input = document.getElementById("scan-passcode-input");
    const errorEl = document.getElementById("scan-passcode-error");

    if (!form) return;

    form.addEventListener("submit", (event) => {
        event.preventDefault();

        if (input.value.trim() === SCAN_PASSCODE) {
            sessionStorage.setItem(SESSION_UNLOCK_KEY, "1");
            errorEl.textContent = "";
            unlockScanPanel();
        } else {
            errorEl.textContent = "Incorrect passcode.";
            input.value = "";
            input.focus();
        }
    });
}

function unlockScanPanel() {
    const gate = document.getElementById("scan-passcode-gate");
    const panel = document.getElementById("scan-main-panel");
    if (gate) gate.classList.add("hidden");
    if (panel) panel.classList.remove("hidden");
}

/* ==========================================================================
   DIRECTION TOGGLE (in / out)
========================================================================== */
function setupDirectionToggle() {
    document.querySelectorAll(".scan-direction-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            currentDirection = btn.dataset.direction;
            document.querySelectorAll(".scan-direction-btn").forEach((b) => {
                b.classList.toggle("active", b === btn);
            });
        });
    });
}

/* ==========================================================================
   CAMERA SCANNING (html5-qrcode)
========================================================================== */
function setupCameraControls() {
    const startBtn = document.getElementById("btn-scan-start");
    const stopBtn = document.getElementById("btn-scan-stop");

    if (startBtn) startBtn.addEventListener("click", startCamera);
    if (stopBtn) stopBtn.addEventListener("click", stopCamera);
}

async function startCamera() {
    if (cameraRunning) return;

    if (typeof window.Html5Qrcode === "undefined") {
        showFeedback("error", "Camera library failed to load", "Use manual entry below instead.");
        return;
    }

    const placeholder = document.getElementById("scan-camera-placeholder");
    const startBtn = document.getElementById("btn-scan-start");
    const stopBtn = document.getElementById("btn-scan-stop");

    try {
        html5QrInstance = new window.Html5Qrcode("scan-camera-box");

        await html5QrInstance.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 220, height: 220 } },
            (decodedText) => handleScanResult(decodedText.trim()),
            () => { /* per-frame decode failure — expected while framing the code, ignore */ }
        );

        cameraRunning = true;
        if (placeholder) placeholder.classList.add("hidden");
        if (startBtn) startBtn.classList.add("hidden");
        if (stopBtn) stopBtn.classList.remove("hidden");
    } catch (error) {
        console.error("Failed to start camera:", error);
        showFeedback("error", "Camera unavailable", "Check camera permissions, or use manual entry below.");
    }
}

async function stopCamera() {
    if (!cameraRunning || !html5QrInstance) return;

    const placeholder = document.getElementById("scan-camera-placeholder");
    const startBtn = document.getElementById("btn-scan-start");
    const stopBtn = document.getElementById("btn-scan-stop");

    try {
        await html5QrInstance.stop();
        html5QrInstance.clear();
    } catch (error) {
        console.error("Failed to stop camera:", error);
    }

    cameraRunning = false;
    if (placeholder) placeholder.classList.remove("hidden");
    if (startBtn) startBtn.classList.remove("hidden");
    if (stopBtn) stopBtn.classList.add("hidden");
}

/* ==========================================================================
   MANUAL ENTRY FALLBACK (students without a printed/available QR)
========================================================================== */
function setupManualEntry() {
    const form = document.getElementById("scan-manual-form");
    const input = document.getElementById("scan-manual-input");

    if (!form) return;

    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const lrn = input.value.trim();
        if (!lrn) return;

        handleScanResult(lrn, { skipDebounce: true });
        input.value = "";
        input.focus();
    });
}

/* ==========================================================================
   SCAN HANDLING (shared by camera + manual entry)
========================================================================== */
async function handleScanResult(lrn, options = {}) {
    if (!lrn) return;

    const now = Date.now();
    if (!options.skipDebounce && lrn === lastScan.lrn && now - lastScan.at < DUPLICATE_WINDOW_MS) {
        showFeedback("duplicate", "Already scanned", "Wait a moment before scanning again.");
        return;
    }
    lastScan = { lrn, at: now };

    const entry = Object.entries(studentsState).find(([, s]) => s.lrn === lrn);

    if (!entry) {
        showFeedback("error", "Not Found", `LRN ${lrn} isn't registered. Check the Students section.`);
        return;
    }

    const [studentId, student] = entry;
    const fullName = [student.firstName, student.middleName, student.lastName, student.extension]
        .filter((v) => v && String(v).trim())
        .join(" ");

    try {
        await set(push(attendanceRootRef), {
            studentId,
            facilityId: student.facilityId || null,
            timestamp: now,
            direction: currentDirection
        });

        showFeedback(
            "success",
            fullName,
            `${currentDirection === "in" ? "Checked IN" : "Checked OUT"} \u00b7 LRN ${student.lrn}`
        );
    } catch (error) {
        console.error("Failed to write attendance log:", error);
        showFeedback("error", "Save failed", "Could not write the attendance log. Try again.");
    }
}

function showFeedback(state, title, sub) {
    const banner = document.getElementById("scan-feedback");
    if (!banner) return;

    banner.classList.remove("state-success", "state-error", "state-duplicate");
    banner.classList.add(`state-${state}`);

    document.getElementById("scan-feedback-title").textContent = title;
    document.getElementById("scan-feedback-sub").textContent = sub;
}

/* ==========================================================================
   LIVE STATS (today's scans / distinct students currently checked in)
   Client-side aggregation over today's attendance/ logs — matches the
   "client-side aggregation" starting point noted in the planning doc for
   occupancy counts, ahead of a possible Cloud Function upgrade later.
========================================================================== */
function setupLiveStats() {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const todayQuery = query(attendanceRootRef, orderByChild("timestamp"), startAt(startOfToday.getTime()));

    onValue(todayQuery, (snapshot) => {
        const logs = snapshot.val() || {};
        const entries = Object.values(logs);

        const totalScans = entries.length;

        // Latest direction per student today -> currently "in" counts as present.
        const latestByStudent = {};
        entries.forEach((log) => {
            const existing = latestByStudent[log.studentId];
            if (!existing || log.timestamp > existing.timestamp) {
                latestByStudent[log.studentId] = log;
            }
        });
        const presentCount = Object.values(latestByStudent).filter((log) => log.direction === "in").length;

        const totalEl = document.getElementById("scan-stat-total");
        const presentEl = document.getElementById("scan-stat-present");
        if (totalEl) totalEl.textContent = String(totalScans);
        if (presentEl) presentEl.textContent = String(presentCount);
    });
}
