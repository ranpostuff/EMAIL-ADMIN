/* ==========================================================================
   RESCUEPRIORITY — STUDENT INCIDENT REPORTER
   --------------------------------------------------------------------------
   Standalone mobile-first web app, separate deployment from the main
   RescuePriority dashboard, but pointed at the SAME Firebase Realtime
   Database. It only READS students/ and sections/ (to identify the
   reporting student) and only WRITES to incidents/ and
   classrooms/{facilityId} — the exact same two paths the main dashboard's
   "Trigger Test Alert" button writes to (see script.js in the main
   project), so a report from this app lights up the Campus Map exactly
   like any other emergency.

   Extra fields added onto the incidents/{pushKey} record, on top of the
   dashboard's existing shape (incidentNumber, timestamp, classroom,
   status, resolvedAt):
       studentId          : string   (the reporting student's key in students/)
       studentName        : string   (denormalized for display even if the
                                       student record is later edited/removed)
       incidentType       : string   ("Headache", "Fire", "Fight", ...)
       roomWide           : boolean  (true = whole-area report, false = one student)
       description        : string | null (optional free-text notes)
       reportedVia        : "student-app"
       facilityId         : string | null (the ACTUAL place the student picked
                                            on the map — see below)
       locationOverridden : boolean  (true if the student changed the location
                                       away from the room their scan implied —
                                       real incidents don't always happen at
                                       your assigned seat, so this is never
                                       forced to match the scan)

   SECURITY NOTE: this app can only do what your Firebase Realtime Database
   security rules allow. For a real deployment you'll want rules that let
   an anonymous/public client read students/sections (or better, read only
   by LRN via a Cloud Function) and write incidents/classrooms, but NOT
   read/write anything else. This starter assumes the same permissive
   rules the rest of the astig/RescuePriority prototype currently uses.
========================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
    getDatabase,
    ref,
    get,
    push,
    set,
    update,
    runTransaction
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { SCHOOL_FACILITIES, ZONE_ORDER, displayFacilityName, findFacility } from "./facilities.js";
import { triggerIncidentAlert } from "./notify-incident.js";

/* Same public client config used throughout the main RescuePriority app —
   this is a Firebase Web SDK config (not a secret; access is governed by
   Firebase security rules), duplicated here so this app has zero
   dependency on the main dashboard's codebase. */
const firebaseConfig = {
    apiKey: "AIzaSyDHPzeyaEtVvEvnH1Va81i24tpiCX8Gx-8",
    authDomain: "school-alert-system-8f211.firebaseapp.com",
    databaseURL: "https://school-alert-system-8f211-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "school-alert-system-8f211",
    storageBucket: "school-alert-system-8f211.firebasestorage.app",
    messagingSenderId: "568204675808",
    appId: "1:568204675808:web:1ca3536d31b7dc5db45e85",
    measurementId: "G-JT58NQCRMQ"
};

const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

const studentsRootRef = ref(database, "students");
const sectionsRootRef = ref(database, "sections");
const incidentsRootRef = ref(database, "incidents");
const lastIncidentNumberRef = ref(database, "counters/lastIncidentNumber");

/* ==========================================================================
   STATE
========================================================================== */
let html5QrInstance = null;
let cameraRunning = false;

let matchedStudentId = null;
let matchedStudent = null;
let matchedSection = null;

let scannedFacilityId = null;   // the room implied by the student's scan (may be null)
let selectedFacilityId = null;  // the room actually picked for THIS report — defaults to scannedFacilityId
let locationOverridden = false; // true once the student changes it away from the scanned room

let reportRoomWide = false;     // false = "Just Me", true = "Everyone Here"
let reportType = null;

const ARM_SECONDS = 3; // how long the Send button stays cancellable before it actually fires
let armTimer = null;
let armInterval = null;
let armRemaining = ARM_SECONDS;

/* ==========================================================================
   LATENCY TEST MODE (capstone testing only — NOT a normal end-user feature)
   --------------------------------------------------------------------------
   When enabled, submitIncidentReport() attaches a high-resolution
   submitted_at timestamp to the incident record so the admin dashboard's
   own latency-test.js can measure submit-to-dashboard latency. When
   disabled (the default for every real user), nothing extra is sent and
   nothing is logged — this whole block is a no-op.
   Enable once via ?latencytest=1 in the URL; it's then remembered in
   localStorage until you visit with ?latencytest=0.
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
    // performance.timeOrigin + performance.now() gives a wall-clock epoch
    // value with sub-millisecond precision; falls back to Date.now().
    if (typeof performance !== "undefined" && performance.now && performance.timeOrigin) {
        return performance.timeOrigin + performance.now();
    }
    return Date.now();
}

/* ==========================================================================
   SCREEN NAVIGATION
========================================================================== */
function showScreen(id) {
    document.querySelectorAll(".screen").forEach((el) => el.classList.toggle("active", el.id === id));
    if (id !== "screen-scan") stopCamera();
    if (id !== "screen-report") cancelArmedSend();
}

function setupBackButtons() {
    document.querySelectorAll("[data-back-to]").forEach((btn) => {
        btn.addEventListener("click", () => showScreen(btn.dataset.backTo));
    });
}

document.addEventListener("DOMContentLoaded", () => {
    setupBackButtons();
    setupHomeButton();
    setupScanScreen();
    setupReportScreen();
    setupMapOverlay();
    setupSuccessScreen();
});

/* ==========================================================================
   HOME
========================================================================== */
function setupHomeButton() {
    const btn = document.getElementById("btn-start-report");
    if (btn) {
        btn.addEventListener("click", () => {
            resetReportState();
            showScreen("screen-scan");
        });
    }
}

function resetReportState() {
    matchedStudentId = null;
    matchedStudent = null;
    matchedSection = null;

    scannedFacilityId = null;
    selectedFacilityId = null;
    locationOverridden = false;

    reportRoomWide = false;
    reportType = null;
    cancelArmedSend();

    document.getElementById("manual-lrn-input").value = "";
    document.getElementById("scan-error").classList.add("hidden");
    document.getElementById("report-notes").value = "";
    document.querySelectorAll(".notes-disclosure").forEach((d) => (d.open = false));

    document.querySelectorAll(".type-chip").forEach((chip) => chip.classList.remove("selected"));
    document.getElementById("report-summary").classList.add("hidden");

    // Reset scope segmented control back to "Just Me"
    document.querySelectorAll(".segmented-btn").forEach((b) => b.classList.toggle("active", b.dataset.scope === "individual"));
    document.getElementById("individual-type-grid").classList.remove("hidden");
    document.getElementById("roomwide-type-grid").classList.add("hidden");
    document.getElementById("scope-hint").textContent = "A personal emergency \u2014 headache, injury, panic attack, etc.";

    updateSendButtonState();
}

/* ==========================================================================
   SCAN SCREEN — camera + manual fallback, both resolve to the same
   handleLrnLookup() (same "QR encodes LRN only" convention as the main
   dashboard's scan-attendance.js and kiosk.js)
========================================================================== */
function setupScanScreen() {
    const openCameraBtn = document.getElementById("btn-open-camera");
    const manualBtn = document.getElementById("btn-manual-lookup");
    const manualInput = document.getElementById("manual-lrn-input");

    if (openCameraBtn) openCameraBtn.addEventListener("click", startCamera);

    if (manualBtn) {
        manualBtn.addEventListener("click", () => {
            const lrn = manualInput.value.trim();
            if (!lrn) return;
            handleLrnLookup(lrn);
        });
    }
    if (manualInput) {
        manualInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") manualBtn.click();
        });
    }
}

async function startCamera() {
    if (cameraRunning) return;

    if (typeof window.Html5Qrcode === "undefined") {
        showScanError("Camera failed to load. Type your LRN below instead.");
        return;
    }

    const idleBox = document.getElementById("scanner-idle");

    try {
        html5QrInstance = new window.Html5Qrcode("qr-reader");
        await html5QrInstance.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 220, height: 220 } },
            (decodedText) => handleLrnLookup(decodedText.trim()),
            () => { /* per-frame decode miss while framing the code — expected, ignore */ }
        );
        cameraRunning = true;
        if (idleBox) idleBox.classList.add("hidden");
    } catch (error) {
        console.error("Failed to start camera:", error);
        showScanError("Couldn't access the camera. Check permissions, or type your LRN below.");
    }
}

async function stopCamera() {
    if (!cameraRunning || !html5QrInstance) return;
    try {
        await html5QrInstance.stop();
        html5QrInstance.clear();
    } catch (error) {
        console.error("Failed to stop camera:", error);
    }
    cameraRunning = false;
    const idleBox = document.getElementById("scanner-idle");
    if (idleBox) idleBox.classList.remove("hidden");
}

function showScanError(message) {
    const el = document.getElementById("scan-error");
    if (!el) return;
    el.textContent = message;
    el.classList.remove("hidden");
}

async function handleLrnLookup(lrn) {
    if (!lrn) return;

    try {
        const snapshot = await get(studentsRootRef);
        const students = snapshot.val() || {};
        const entry = Object.entries(students).find(([, s]) => s.lrn === lrn);

        if (!entry) {
            showScanError(`LRN ${lrn} wasn't found. Check with your adviser if this keeps happening.`);
            return;
        }

        const [studentId, student] = entry;
        matchedStudentId = studentId;
        matchedStudent = student;

        const sectionsSnapshot = await get(sectionsRootRef);
        const sections = sectionsSnapshot.val() || {};
        matchedSection = student.sectionId ? sections[student.sectionId] || null : null;

        scannedFacilityId = (matchedSection && matchedSection.facilityId) || student.facilityId || null;
        selectedFacilityId = scannedFacilityId;
        locationOverridden = false;

        stopCamera();
        populateReportScreen();
        showScreen("screen-report");
    } catch (error) {
        console.error("Lookup failed:", error);
        showScanError("Couldn't reach the server. Check your connection and try again.");
    }
}

/* ==========================================================================
   REPORT SCREEN — identity + scope + type + location + notes, all on one
   screen, ending in a single Send button (no separate confirm screen).
========================================================================== */
function populateReportScreen() {
    const nameEl = document.getElementById("identity-name");
    const metaEl = document.getElementById("identity-meta");
    const photoEl = document.getElementById("identity-photo");
    const photoFallbackEl = document.getElementById("identity-photo-fallback");

    const fullName = [matchedStudent.firstName, matchedStudent.middleName, matchedStudent.lastName, matchedStudent.extension]
        .filter((v) => v && String(v).trim())
        .join(" ");

    nameEl.textContent = fullName || "Student";
    metaEl.textContent = matchedSection
        ? `${matchedSection.gradeName || "--"} \u2013 ${matchedSection.name}`
        : "Section not on file";

    const initials = ((matchedStudent.firstName || "").charAt(0) + (matchedStudent.lastName || "").charAt(0)).toUpperCase();
    photoFallbackEl.textContent = initials || "?";

    if (matchedStudent.photoUrl) {
        photoEl.src = matchedStudent.photoUrl;
        photoEl.classList.remove("hidden");
        photoFallbackEl.classList.add("hidden");
        photoEl.onerror = () => {
            photoEl.classList.add("hidden");
            photoFallbackEl.classList.remove("hidden");
        };
    } else {
        photoEl.classList.add("hidden");
        photoFallbackEl.classList.remove("hidden");
    }

    updateLocationRow();
    updateReportSummary();
}

function setupReportScreen() {
    setupScopeSegmented();
    setupTypeGrids();
    setupNotes();
    setupSendButton();

    const mapBtn = document.getElementById("btn-open-map");
    if (mapBtn) mapBtn.addEventListener("click", openMapOverlay);
}

function setupScopeSegmented() {
    const buttons = document.querySelectorAll(".segmented-btn");
    const hint = document.getElementById("scope-hint");
    const individualGrid = document.getElementById("individual-type-grid");
    const roomwideGrid = document.getElementById("roomwide-type-grid");

    buttons.forEach((btn) => {
        btn.addEventListener("click", () => {
            buttons.forEach((b) => b.classList.toggle("active", b === btn));
            reportRoomWide = btn.dataset.scope === "roomwide";

            individualGrid.classList.toggle("hidden", reportRoomWide);
            roomwideGrid.classList.toggle("hidden", !reportRoomWide);

            hint.textContent = reportRoomWide
                ? "Something affecting everyone around you \u2014 fire, a fight, an intruder, etc."
                : "A personal emergency \u2014 headache, injury, panic attack, etc.";

            // Switching scope clears the previously-selected type since the
            // two grids use different options.
            reportType = null;
            document.querySelectorAll(".type-chip").forEach((chip) => chip.classList.remove("selected"));
            updateSendButtonState();
            updateReportSummary();
        });
    });
}

function setupTypeGrids() {
    document.querySelectorAll(".type-grid").forEach((grid) => {
        grid.querySelectorAll(".type-chip").forEach((chip) => {
            chip.addEventListener("click", () => {
                grid.querySelectorAll(".type-chip").forEach((c) => c.classList.remove("selected"));
                chip.classList.add("selected");
                reportType = chip.dataset.type;
                updateSendButtonState();
                updateReportSummary();
            });
        });
    });
}

function setupNotes() {
    // Notes are read directly from the textarea at submit time — nothing
    // to wire up here beyond letting the <details> disclosure do its thing.
}

function updateLocationRow() {
    const valueEl = document.getElementById("location-value");
    const facility = findFacility(selectedFacilityId);

    if (!facility) {
        valueEl.textContent = matchedSection ? matchedSection.name : "Pick a location on the map";
        return;
    }

    const label = `${displayFacilityName(facility.name)} \u00b7 ${facility.zone}`;
    valueEl.textContent = locationOverridden ? `${label} (changed)` : label;
}

function updateReportSummary() {
    const summaryEl = document.getElementById("report-summary");
    if (!reportType) {
        summaryEl.classList.add("hidden");
        return;
    }

    const facility = findFacility(selectedFacilityId);
    const roomLabel = facility ? displayFacilityName(facility.name) : (matchedSection ? matchedSection.name : "unspecified location");
    const scopeLabel = reportRoomWide ? "Everyone Here" : "Just Me";

    summaryEl.textContent = `${reportType} \u2014 ${scopeLabel} \u2014 ${roomLabel}`;
    summaryEl.classList.remove("hidden");
}

function updateSendButtonState() {
    const btn = document.getElementById("btn-send");
    const label = document.getElementById("btn-send-label");
    if (!btn || !label) return;

    if (!reportType) {
        btn.disabled = true;
        label.textContent = "Select an incident type";
        return;
    }

    btn.disabled = false;
    if (!btn.classList.contains("armed")) {
        label.textContent = "Send Report";
    }
}

/* ==========================================================================
   SEND BUTTON — tap once to arm a short, visible, cancellable countdown
   instead of navigating to a separate confirmation screen. Tap again while
   armed to cancel. This replaces the old Confirm screen so reporting a real
   emergency takes as few steps as possible.
========================================================================== */
function setupSendButton() {
    const btn = document.getElementById("btn-send");
    if (!btn) return;

    btn.addEventListener("click", () => {
        if (btn.disabled) return;
        if (btn.classList.contains("armed")) {
            cancelArmedSend();
        } else {
            armSend();
        }
    });
}

function armSend() {
    const btn = document.getElementById("btn-send");
    const label = document.getElementById("btn-send-label");
    const progress = document.getElementById("btn-send-progress");

    btn.classList.add("armed");
    armRemaining = ARM_SECONDS;
    label.textContent = `Sending in ${armRemaining}s \u2014 Tap to Cancel`;
    progress.style.transition = "none";
    progress.style.width = "100%";
    // Force layout so the next width change (0%) actually transitions.
    // eslint-disable-next-line no-unused-expressions
    progress.offsetWidth;
    progress.style.transition = `width ${ARM_SECONDS}s linear`;
    progress.style.width = "0%";

    armInterval = setInterval(() => {
        armRemaining -= 1;
        if (armRemaining > 0) {
            label.textContent = `Sending in ${armRemaining}s \u2014 Tap to Cancel`;
        }
    }, 1000);

    armTimer = setTimeout(() => {
        finalizeSend();
    }, ARM_SECONDS * 1000);
}

function cancelArmedSend() {
    const btn = document.getElementById("btn-send");
    const progress = document.getElementById("btn-send-progress");
    if (armTimer) clearTimeout(armTimer);
    if (armInterval) clearInterval(armInterval);
    armTimer = null;
    armInterval = null;
    if (btn) btn.classList.remove("armed");
    if (progress) {
        progress.style.transition = "none";
        progress.style.width = "0%";
    }
    updateSendButtonState();
}

async function finalizeSend() {
    const btn = document.getElementById("btn-send");
    const label = document.getElementById("btn-send-label");
    if (armInterval) clearInterval(armInterval);
    armInterval = null;
    armTimer = null;

    btn.disabled = true;
    label.textContent = "Reporting...";

    try {
        await submitIncidentReport();
        populateSuccessScreen();
        showScreen("screen-success");
    } catch (error) {
        console.error("Failed to submit incident report:", error);
        alert("Couldn't send the report. Check your connection and try again.");
        btn.classList.remove("armed");
        btn.disabled = false;
        updateSendButtonState();
    }
}

/* ==========================================================================
   CAMPUS MAP OVERLAY — lets the student pick where this is ACTUALLY
   happening instead of trusting the room implied by their scan. Real
   incidents happen in hallways, the canteen, another section's room, etc.
========================================================================== */
function setupMapOverlay() {
    const closeBtn = document.getElementById("btn-close-map");
    const useScannedBtn = document.getElementById("btn-use-scanned");
    const searchInput = document.getElementById("map-search");

    if (closeBtn) closeBtn.addEventListener("click", closeMapOverlay);
    if (useScannedBtn) {
        useScannedBtn.addEventListener("click", () => {
            selectedFacilityId = scannedFacilityId;
            locationOverridden = false;
            updateLocationRow();
            updateReportSummary();
            closeMapOverlay();
        });
    }
    if (searchInput) {
        searchInput.addEventListener("input", () => renderMapZones(searchInput.value.trim().toLowerCase()));
    }
}

function openMapOverlay() {
    const overlay = document.getElementById("map-overlay");
    const useScannedBtn = document.getElementById("btn-use-scanned");
    const searchInput = document.getElementById("map-search");

    if (searchInput) searchInput.value = "";
    if (useScannedBtn) useScannedBtn.classList.toggle("hidden", !scannedFacilityId || !locationOverridden);

    renderMapZones("");
    if (overlay) overlay.classList.remove("hidden");
}

function closeMapOverlay() {
    const overlay = document.getElementById("map-overlay");
    if (overlay) overlay.classList.add("hidden");
}

function renderMapZones(filterText) {
    const container = document.getElementById("map-zones");
    if (!container) return;

    container.innerHTML = "";

    ZONE_ORDER.forEach((zone) => {
        const facilitiesInZone = SCHOOL_FACILITIES.filter((f) => {
            if (f.zone !== zone) return false;
            if (!filterText) return true;
            const haystack = `${displayFacilityName(f.name)} ${f.section}`.toLowerCase();
            return haystack.includes(filterText);
        });

        if (facilitiesInZone.length === 0) return;

        const zoneBlock = document.createElement("div");
        zoneBlock.className = "map-zone-block";

        const heading = document.createElement("h3");
        heading.className = "map-zone-heading";
        heading.textContent = zone;
        zoneBlock.appendChild(heading);

        const grid = document.createElement("div");
        grid.className = "map-zone-grid";

        facilitiesInZone.forEach((facility) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "map-room-btn";
            if (facility.id === selectedFacilityId) btn.classList.add("selected");
            if (facility.id === scannedFacilityId) btn.classList.add("is-scanned-room");

            btn.innerHTML = `
                <span class="map-room-name">${displayFacilityName(facility.name)}</span>
                <span class="map-room-sub">${facility.section}</span>
            `;

            btn.addEventListener("click", () => {
                selectedFacilityId = facility.id;
                locationOverridden = facility.id !== scannedFacilityId;
                updateLocationRow();
                updateReportSummary();
                closeMapOverlay();
            });

            grid.appendChild(btn);
        });

        zoneBlock.appendChild(grid);
        container.appendChild(zoneBlock);
    });

    if (!container.children.length) {
        const empty = document.createElement("p");
        empty.className = "map-empty";
        empty.textContent = "No matching location found.";
        container.appendChild(empty);
    }
}

/* ==========================================================================
   FIREBASE WRITE — mirrors the main dashboard's raiseClassroomEmergency()
   in script.js: atomic incident-number transaction, then a permanent
   incidents/{pushKey} record, then the current-state classrooms/ flag.
   Uses selectedFacilityId (the map pick) rather than blindly trusting the
   room implied by the student's scan, since the two can legitimately differ.
========================================================================== */
async function submitIncidentReport() {
    // Captured at the exact moment this function starts — i.e. the moment
    // the report actually fires (after the ARM_SECONDS cancel window has
    // expired), which is the "submit" side of the latency test.
    const submittedAt = isLatencyTestModeEnabled() ? highResTimestamp() : null;

    const facility = findFacility(selectedFacilityId);
    const roomName = facility ? facility.name : (matchedSection ? matchedSection.name : "Unknown Room");
    const fullName = [matchedStudent.firstName, matchedStudent.middleName, matchedStudent.lastName, matchedStudent.extension]
        .filter((v) => v && String(v).trim())
        .join(" ");
    const notes = document.getElementById("report-notes").value.trim();

    const numberResult = await runTransaction(lastIncidentNumberRef, (current) => (current || 0) + 1);
    const incidentNumber = numberResult.snapshot.val();

    const newIncidentRef = push(incidentsRootRef);
    const incidentPayload = {
        incidentNumber: `Emergency #${String(incidentNumber).padStart(3, "0")}`,
        timestamp: Date.now(),
        classroom: roomName,
        status: "Active",
        resolvedAt: null,
        studentId: matchedStudentId,
        studentName: fullName,
        incidentType: reportType,
        roomWide: reportRoomWide,
        description: notes || null,
        reportedVia: "student-app",
        facilityId: selectedFacilityId || null,
        locationOverridden
    };

    if (submittedAt !== null) {
        incidentPayload.submitted_at = submittedAt;
        console.log(`[RescuePriority][latency] Submitting ${newIncidentRef.key} at ${submittedAt.toFixed(1)}`);
    }

    await set(newIncidentRef, incidentPayload);

    if (selectedFacilityId) {
        // Don't stomp an already-active emergency's activeIncidentKey — if the
        // room is already flagged, this new report still gets logged above,
        // it just won't replace which incident the room card/modal points to.
        // (See this app's README for the tradeoff and how to change it.)
        const classroomRef = ref(database, `classrooms/${selectedFacilityId}`);
        const existingSnapshot = await get(classroomRef);
        const existing = existingSnapshot.val();

        if (!existing || !existing.emergency) {
            await update(classroomRef, {
                emergency: true,
                activeIncidentKey: newIncidentRef.key
            });
        }
    }

    triggerIncidentAlert(newIncidentRef.key);
}

/* ==========================================================================
   SUCCESS SCREEN
========================================================================== */
function populateSuccessScreen() {
    const detailEl = document.getElementById("success-detail");
    detailEl.textContent = reportRoomWide
        ? "The Command Center has been notified for everyone in this area. Stay where it's safe and wait for help."
        : "The Command Center has been notified. Stay where you are if possible \u2014 help is on the way.";
}

function setupSuccessScreen() {
    const doneBtn = document.getElementById("btn-success-done");
    if (doneBtn) {
        doneBtn.addEventListener("click", () => {
            resetReportState();
            showScreen("screen-home");
        });
    }
}
