/* ==========================================================================
   RESCUEPRIORITY — PANIC / EVACUATION MODULE
   --------------------------------------------------------------------------
   Additive module. Does NOT touch classrooms/, incidents/, or counters/ —
   same convention as students.js and scan-attendance.js.

   New Firebase path owned by this file:
     panics/{facilityId} -> { active: true, triggeredAt: number }
     (the node is removed entirely once an evacuation is ended)

   PANIC vs. the existing THREAT state
   ------------------------------------
   A "panic" is a separate, brighter/faster visual state layered on top of
   the room card and the room modal. It deliberately does NOT create an
   incident or flip classrooms/{facilityId}.emergency — it's a distinct
   per-classroom evacuation trigger, not a duplicate emergency workflow.

   Real hardware target: an ultrasonic sensor mounted at the classroom
   door, wired into Firebase the same way the ESP32 already wires into
   classrooms/. Until that hardware exists, two things simulate a press —
   the room modal's own Panic button (the realistic case: someone in that
   room presses it) and the "Trigger Test Panic" button in the Campus Map
   header (a random-classroom demo button, same spirit as the existing
   "Trigger Test Alert").

   EVACUATION COUNT
   ------------------
   There's no sensor yet actually counting bodies through a doorway, so
   instead of inventing a fake number, this counts something real: any
   student on that classroom's roster who scans OUT at the gate (kiosk /
   scan-attendance) at or after the panic's triggeredAt counts as
   evacuated. It reuses the same attendance/ log scan-attendance.js
   already writes — no new student-facing workflow needed.
========================================================================== */

import { database, SCHOOL_FACILITIES, isClassroomFacility } from "./script.js";
import { studentsState } from "./students.js";
import {
    ref,
    set,
    remove,
    onValue,
    query,
    orderByChild,
    startAt
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const panicsRootRef = ref(database, "panics");
const attendanceRootRef = ref(database, "attendance");

let panicsState = {};         // facilityId -> { active, triggeredAt }
let todayAttendanceLogs = []; // cached today's attendance/ logs, kept live
let openModalFacilityId = null;

/* ==========================================================================
   INITIALIZATION
========================================================================== */
document.addEventListener("DOMContentLoaded", () => {
    initPanicModule();
});

function initPanicModule() {
    setupHeaderTestPanicButton();
    setupRoomModalPanicButton();

    window.addEventListener("rp:room-modal-opened", (event) => {
        openModalFacilityId = event.detail.facilityId;
        refreshRoomModalPanicUI();
    });

    window.addEventListener("rp:room-modal-closed", () => {
        openModalFacilityId = null;
    });

    onValue(
        panicsRootRef,
        (snapshot) => {
            panicsState = snapshot.val() || {};
            applyPanicStylesToBlueprint();
            refreshRoomModalPanicUI();
        },
        (error) => {
            console.error("[panics listener] Firebase read failed:", error.code, error.message);
        }
    );

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayQuery = query(attendanceRootRef, orderByChild("timestamp"), startAt(startOfToday.getTime()));

    onValue(
        todayQuery,
        (snapshot) => {
            const logs = snapshot.val() || {};
            todayAttendanceLogs = Object.values(logs);
            refreshRoomModalPanicUI(); // live-updates the evacuation count while the modal is open
        },
        (error) => {
            console.error("[panic attendance listener] Firebase read failed:", error.code, error.message);
        }
    );
}

/* ==========================================================================
   HEADER "TRIGGER TEST PANIC" BUTTON (Campus Map view)
   Picks a random classroom without an active evacuation and raises one —
   same demo role as the existing "Trigger Test Alert" button.
========================================================================== */
function setupHeaderTestPanicButton() {
    const btn = document.getElementById("btn-trigger-panic-test");
    if (!btn) return;

    btn.addEventListener("click", () => {
        const candidates = SCHOOL_FACILITIES.filter(
            (facility) => isClassroomFacility(facility) && !isPanicActive(facility.id)
        );

        if (candidates.length === 0) {
            console.warn("Every classroom already has an active evacuation.");
            return;
        }

        const facility = candidates[Math.floor(Math.random() * candidates.length)];
        startPanic(facility.id).catch((error) => console.error("Failed to raise test panic:", error));
    });
}

/* ==========================================================================
   ROOM MODAL — PANIC TOGGLE BUTTON
========================================================================== */
function setupRoomModalPanicButton() {
    const btn = document.getElementById("btn-panic-toggle");
    if (!btn) return;

    btn.addEventListener("click", () => {
        if (!openModalFacilityId) return;

        if (isPanicActive(openModalFacilityId)) {
            endPanic(openModalFacilityId).catch((error) => console.error("Failed to end evacuation:", error));
        } else {
            startPanic(openModalFacilityId).catch((error) => console.error("Failed to start evacuation:", error));
        }
    });
}

function isPanicActive(facilityId) {
    const entry = panicsState[facilityId];
    return !!(entry && entry.active);
}

async function startPanic(facilityId) {
    await set(ref(database, `panics/${facilityId}`), {
        active: true,
        triggeredAt: Date.now()
    });
}

async function endPanic(facilityId) {
    await remove(ref(database, `panics/${facilityId}`));
}

/* ==========================================================================
   BLUEPRINT — brighter/faster "panic-active" overlay on the room card
========================================================================== */
function applyPanicStylesToBlueprint() {
    SCHOOL_FACILITIES.forEach((facility) => {
        const card = document.querySelector(`.room-card[data-id="${facility.id}"]`);
        if (!card) return;

        const active = isPanicActive(facility.id);
        card.classList.toggle("panic-active", active);

        if (active) {
            const badge = card.querySelector(".room-status-badge");
            if (badge) badge.textContent = "EVACUATE";
        }
    });
}

/* ==========================================================================
   ROOM MODAL — evacuation panel + button label/state
========================================================================== */
function refreshRoomModalPanicUI() {
    if (!openModalFacilityId) return;

    const facility = SCHOOL_FACILITIES.find((item) => item.id === openModalFacilityId);
    const btn = document.getElementById("btn-panic-toggle");
    const section = document.getElementById("modal-evac-section");
    if (!facility || !btn) return;

    if (!isClassroomFacility(facility)) {
        // Offices / support rooms have no student roster to evacuate.
        btn.classList.add("hidden");
        if (section) section.classList.add("hidden");
        return;
    }
    btn.classList.remove("hidden");

    const active = isPanicActive(facility.id);
    const entry = panicsState[facility.id];

    btn.textContent = active ? "End Evacuation" : "Panic \u2014 Start Evacuation";
    btn.classList.toggle("btn-panic-active", active);

    if (!section) return;

    if (!active || !entry) {
        section.classList.add("hidden");
        return;
    }

    section.classList.remove("hidden");

    const { evacuated, total } = computeEvacuationProgress(facility.id, entry.triggeredAt);

    const sinceEl = document.getElementById("modal-evac-since");
    const countEl = document.getElementById("modal-evac-count");
    const barEl = document.getElementById("modal-evac-bar-fill");

    if (sinceEl) {
        sinceEl.textContent = `Since ${new Date(entry.triggeredAt).toLocaleTimeString("en-PH", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        })}`;
    }
    if (countEl) countEl.textContent = `${evacuated} / ${total}`;
    if (barEl) {
        const pct = total > 0 ? Math.min(100, Math.round((evacuated / total) * 100)) : 0;
        barEl.style.width = `${pct}%`;
    }
}

/* Roster is read via student.facilityId (denormalized in students.js) so
   this doesn't need to cross-reference sections/ at all. "Evacuated" means
   at least one OUT scan at or after the panic started — a student who
   scanned back in afterwards still counts, since the point is headcount
   at the moment everyone left, not current occupancy. */
function computeEvacuationProgress(facilityId, triggeredAt) {
    const roster = Object.entries(studentsState).filter(([, student]) => student.facilityId === facilityId);
    const total = roster.length;

    const evacuatedIds = new Set(
        todayAttendanceLogs
            .filter((log) => log.direction === "out" && log.timestamp >= triggeredAt)
            .map((log) => log.studentId)
    );

    const evacuated = roster.filter(([studentId]) => evacuatedIds.has(studentId)).length;
    return { evacuated, total };
}
