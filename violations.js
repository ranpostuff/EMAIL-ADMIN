/* ==========================================================================
   RESCUEPRIORITY — VIOLATIONS MODULE
   --------------------------------------------------------------------------
   Additive module, same conventions as students.js / scan-attendance.js /
   panic.js: owns one new Firebase path, reuses studentsState/sectionsState
   read-only, never touches students/, sections/, classrooms/, or incidents/.

   New Firebase path owned by this file:
     violations/{studentId}/{pushKey} -> {
         type          : string   ("Cutting Classes", "Fighting", ...)
         offenseCount  : number   (1, 2, 3, 4...)
         notes         : string | null
         timestamp     : number
     }

   Keyed by studentId first (not a flat list) so "how many violations does
   this student have" — the thing the Section Detail modal needs — is a
   single child read/count instead of a scan over every violation ever
   logged school-wide.

   Camera scanning reuses the same html5-qrcode UMD build (window.Html5Qrcode)
   and "QR encodes LRN only" convention as scan-attendance.js.
========================================================================== */

import { database } from "./script.js";
import { studentsState, sectionsState } from "./students.js";
import {
    ref,
    push,
    set,
    onValue,
    query,
    orderByChild,
    limitToLast
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const violationsRootRef = ref(database, "violations");
const recentViolationsQuery = query(violationsRootRef); // small dataset (per-school violations), no need to page

/* Exported live cache so students.js can show a per-student violation
   count/list inside the Section Detail modal without opening its own
   second listener on violations/. */
export let violationsState = {}; // studentId -> [{ key, type, offenseCount, notes, timestamp }, ...]

let flatViolationsCache = []; // flattened + denormalized, for the Recent Violations table only

let html5QrInstance = null;
let cameraRunning = false;
let matchedStudentId = null; // student currently shown in the found-card / about to be logged

document.addEventListener("DOMContentLoaded", () => {
    initViolationsModule();
});

function initViolationsModule() {
    setupScanStartButton();
    setupManualLookup();
    setupForm();

    onValue(
        violationsRootRef,
        (snapshot) => {
            const data = snapshot.val() || {};
            const nextState = {};
            const flat = [];

            Object.entries(data).forEach(([studentId, records]) => {
                const list = Object.entries(records || {}).map(([key, record]) => ({ key, ...record }));
                list.sort((a, b) => a.timestamp - b.timestamp);
                nextState[studentId] = list;
                list.forEach((record) => flat.push({ studentId, ...record }));
            });

            violationsState = nextState;
            flat.sort((a, b) => b.timestamp - a.timestamp);
            flatViolationsCache = flat.slice(0, 100); // recent-log table only needs the latest handful

            renderViolationsTable();
            if (matchedStudentId) refreshFoundCardBadge(matchedStudentId);
        },
        (error) => console.error("[violations listener] Firebase read failed:", error.code, error.message)
    );
}

/* ==========================================================================
   CAMERA SCANNING — mirrors scan-attendance.js's startCamera()/stopCamera()
========================================================================== */
function setupScanStartButton() {
    const startBtn = document.getElementById("btn-violations-start-scan");
    if (!startBtn) return;

    startBtn.addEventListener("click", async () => {
        if (cameraRunning) return;

        if (typeof window.Html5Qrcode === "undefined") {
            alert("Camera library failed to load. Use manual LRN entry instead.");
            return;
        }

        const idleBox = document.getElementById("violations-scanner-idle");

        try {
            html5QrInstance = new window.Html5Qrcode("violations-qr-reader");
            await html5QrInstance.start(
                { facingMode: "environment" },
                { fps: 10, qrbox: { width: 220, height: 220 } },
                (decodedText) => handleLrnLookup(decodedText.trim()),
                () => { /* per-frame decode miss, expected while framing — ignore */ }
            );
            cameraRunning = true;
            if (idleBox) idleBox.classList.add("hidden");
        } catch (error) {
            console.error("Failed to start violations camera:", error);
            alert("Camera unavailable. Check permissions, or use manual LRN entry instead.");
        }
    });
}

async function stopScanCamera() {
    if (!cameraRunning || !html5QrInstance) return;
    try {
        await html5QrInstance.stop();
        html5QrInstance.clear();
    } catch (error) {
        console.error("Failed to stop violations camera:", error);
    }
    cameraRunning = false;
    const idleBox = document.getElementById("violations-scanner-idle");
    if (idleBox) idleBox.classList.remove("hidden");
}

/* ==========================================================================
   MANUAL LOOKUP FALLBACK
========================================================================== */
function setupManualLookup() {
    const btn = document.getElementById("btn-violations-manual-lookup");
    const input = document.getElementById("violations-manual-lrn");
    if (!btn || !input) return;

    const run = () => {
        const lrn = input.value.trim();
        if (!lrn) return;
        handleLrnLookup(lrn);
        input.value = "";
    };

    btn.addEventListener("click", run);
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") run();
    });
}

function handleLrnLookup(lrn) {
    const entry = Object.entries(studentsState).find(([, s]) => s.lrn === lrn);
    if (!entry) {
        alert(`LRN ${lrn} isn't registered. Check the Students section.`);
        return;
    }
    const [studentId] = entry;
    showFoundCard(studentId);
    stopScanCamera(); // camera served its purpose — free it up rather than leaving it running behind the form
}

/* ==========================================================================
   FOUND-STUDENT CARD + VIOLATION FORM
========================================================================== */
function showFoundCard(studentId) {
    const student = studentsState[studentId];
    if (!student) return;

    matchedStudentId = studentId;

    const card = document.getElementById("violations-found-card");
    const nameEl = document.getElementById("violations-found-name");
    const metaEl = document.getElementById("violations-found-meta");
    const photoEl = document.getElementById("violations-found-photo");
    const photoFallbackEl = document.getElementById("violations-found-photo-fallback");

    const fullName = studentFullName(student);
    const section = sectionsState[student.sectionId];

    nameEl.textContent = fullName;
    metaEl.textContent = `LRN ${student.lrn || "--"} \u00b7 ${section ? `${section.gradeName || "--"} \u2013 ${section.name}` : "No section"}`;

    const initials = ((student.firstName || "").charAt(0) + (student.lastName || "").charAt(0)).toUpperCase();
    photoFallbackEl.textContent = initials || "?";
    if (student.photoUrl) {
        photoEl.src = student.photoUrl;
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

    refreshFoundCardBadge(studentId);

    document.getElementById("violations-type-select").value = "Cutting Classes";
    document.getElementById("violations-offense-select").value = "1";
    document.getElementById("violations-notes").value = "";

    if (card) card.classList.remove("hidden");
}

function refreshFoundCardBadge(studentId) {
    if (matchedStudentId !== studentId) return;
    const badge = document.getElementById("violations-found-count-badge");
    if (!badge) return;
    const count = (violationsState[studentId] || []).length;
    badge.textContent = count === 1 ? "1 prior violation" : `${count} prior violations`;
}

function setupForm() {
    const cancelBtn = document.getElementById("btn-violations-cancel");
    const submitBtn = document.getElementById("btn-violations-submit");

    if (cancelBtn) {
        cancelBtn.addEventListener("click", () => {
            matchedStudentId = null;
            const card = document.getElementById("violations-found-card");
            if (card) card.classList.add("hidden");
        });
    }

    if (submitBtn) {
        submitBtn.addEventListener("click", async () => {
            if (!matchedStudentId) return;

            const type = document.getElementById("violations-type-select").value;
            const offenseCount = Number(document.getElementById("violations-offense-select").value);
            const notes = document.getElementById("violations-notes").value.trim();

            submitBtn.disabled = true;
            try {
                await set(push(ref(database, `violations/${matchedStudentId}`)), {
                    type,
                    offenseCount,
                    notes: notes || null,
                    timestamp: Date.now()
                });

                const card = document.getElementById("violations-found-card");
                if (card) card.classList.add("hidden");
                matchedStudentId = null;
            } catch (error) {
                console.error("Failed to log violation:", error);
                alert("Couldn't save the violation. Check your connection and try again.");
            } finally {
                submitBtn.disabled = false;
            }
        });
    }
}

/* ==========================================================================
   RECENT VIOLATIONS TABLE
========================================================================== */
function renderViolationsTable() {
    const tbody = document.getElementById("violations-table-body");
    const emptyState = document.getElementById("violations-table-empty");
    if (!tbody) return;

    tbody.innerHTML = "";

    if (flatViolationsCache.length === 0) {
        if (emptyState) emptyState.classList.remove("hidden");
        return;
    }
    if (emptyState) emptyState.classList.add("hidden");

    flatViolationsCache.forEach((record) => {
        const student = studentsState[record.studentId];
        const section = student ? sectionsState[student.sectionId] : null;

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${escapeHtml(student ? studentFullName(student) : "Unknown student")}</td>
            <td>${escapeHtml(section ? section.name : "--")}</td>
            <td>${escapeHtml(record.type)}</td>
            <td>${ordinal(record.offenseCount)}</td>
            <td>${new Date(record.timestamp).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
        `;
        tbody.appendChild(tr);
    });
}

function ordinal(n) {
    if (n === 1) return "1st Offense";
    if (n === 2) return "2nd Offense";
    if (n === 3) return "3rd Offense";
    return `${n}th Offense`;
}

function studentFullName(student) {
    return [student.firstName, student.middleName, student.lastName, student.extension]
        .filter((v) => v && String(v).trim())
        .join(" ");
}

function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
}
