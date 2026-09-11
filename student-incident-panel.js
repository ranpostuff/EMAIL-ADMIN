/* ==========================================================================
   RESCUEPRIORITY — STUDENT INCIDENT PANEL
   --------------------------------------------------------------------------
   Additive module: listens for the room-modal open/close events script.js
   already dispatches, plus its own read-only listeners on classrooms/ and
   incidents/. Writes nothing.

   Shows a slim "who reported this" banner inside the room modal, and — on
   tap — the full reporter detail (photo, LRN, section, adviser, parent
   contact, note) in its own dedicated #reporter-modal. That detail used to
   be crammed directly into the room modal's small card; splitting it out
   is what actually fixes the "cramped floating window" complaint, not just
   a font-size tweak.

   The Student Incident Reporter app adds these fields onto an
   incidents/{pushKey} record it creates:
       reporterId    : string   (always present — whoever was logged in
                                  when the report was sent, "Just Me" or
                                  "Everyone Here" alike)
       reporterName  : string   (denormalized, so this still works if the
                                  student is later removed from students/)
       reporterLrn   : string   (denormalized LRN)
       studentId     : string | null (who the incident CONCERNS — same as
                                       reporterId for an individual report,
                                       null for a room-wide one; kept for
                                       back-compat with older records)
       studentName   : string | null
       incidentType  : string   ("Headache", "Fire", "Fight", ...)
       roomWide      : boolean  (true = whole-room emergency)
       description   : string | null (free-text detail, if provided)

   Older incident records only ever set studentId/studentName (no reporter*
   fields) and hid this panel entirely for roomWide reports — this file
   falls back to those fields so old data still renders, but no longer
   hides the panel for room-wide reports: the point of these fields is
   "who reported it", which is known either way.

   None of this is required for the existing "Trigger Test Alert" / ESP32
   pipeline — those incidents simply have neither set of fields, so this
   panel stays hidden for them.
========================================================================== */

import { database } from "./script.js";
import { studentsState, sectionsState } from "./students.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const classroomsRootRef = ref(database, "classrooms");
const incidentsRootRef = ref(database, "incidents");

let classroomsCache = {};
let incidentsCache = {}; // key -> incident record
let openFacilityId = null;
let currentIncident = null; // the incident currently shown in the banner/modal

document.addEventListener("DOMContentLoaded", () => {
    onValue(classroomsRootRef, (snapshot) => {
        classroomsCache = snapshot.val() || {};
        refreshPanel();
    });

    onValue(incidentsRootRef, (snapshot) => {
        incidentsCache = snapshot.val() || {};
        refreshPanel();
    });

    window.addEventListener("rp:room-modal-opened", (event) => {
        openFacilityId = event.detail.facilityId;
        refreshPanel();
    });

    window.addEventListener("rp:room-modal-closed", () => {
        openFacilityId = null;
    });

    setupReporterModal();
});

function refreshPanel() {
    const banner = document.getElementById("modal-student-incident-section");
    if (!banner) return;

    if (!openFacilityId) {
        banner.classList.add("hidden");
        currentIncident = null;
        return;
    }

    const classroomEntry = classroomsCache[openFacilityId];
    const incidentKey = classroomEntry && classroomEntry.emergency ? classroomEntry.activeIncidentKey : null;
    const incident = incidentKey ? incidentsCache[incidentKey] : null;

    const reporterId = incident ? (incident.reporterId || incident.studentId || null) : null;
    const reporterNameFallback = incident ? (incident.reporterName || incident.studentName || null) : null;

    if (!incident || (!reporterId && !reporterNameFallback)) {
        banner.classList.add("hidden");
        currentIncident = null;
        return;
    }

    currentIncident = incident;

    const student = reporterId ? studentsState[reporterId] : null;
    const fullName = student ? studentFullName(student) : (reporterNameFallback || "Unknown student");

    const typeBadge = document.getElementById("modal-student-incident-type");
    const nameEl = document.getElementById("modal-student-name");
    const photoEl = document.getElementById("modal-student-photo");
    const photoFallbackEl = document.getElementById("modal-student-photo-fallback");

    if (typeBadge) {
        const typeLabel = incident.incidentType ? `Reported: ${incident.incidentType}` : "Reported Emergency";
        typeBadge.textContent = incident.roomWide ? `${typeLabel} \u2014 Everyone Here` : typeLabel;
    }
    if (nameEl) nameEl.textContent = `Reported by ${fullName}`;

    setPhoto(photoEl, photoFallbackEl, student, fullName);

    banner.classList.remove("hidden");
}

function setupReporterModal() {
    const banner = document.getElementById("modal-student-incident-section");
    const modal = document.getElementById("reporter-modal");
    const closeBtn = document.getElementById("reporter-modal-close");
    const doneBtn = document.getElementById("reporter-modal-done");

    if (banner) {
        banner.addEventListener("click", () => {
            if (currentIncident) openReporterModal(currentIncident);
        });
    }

    [closeBtn, doneBtn].forEach((btn) => {
        if (btn) btn.addEventListener("click", closeReporterModal);
    });

    if (modal) {
        modal.addEventListener("click", (event) => {
            if (event.target === modal) closeReporterModal();
        });
    }
}

function openReporterModal(incident) {
    const reporterId = incident.reporterId || incident.studentId || null;
    const reporterNameFallback = incident.reporterName || incident.studentName || null;
    const reporterLrnFallback = incident.reporterLrn || null;

    const student = reporterId ? studentsState[reporterId] : null;
    const studentSection = student ? sectionsState[student.sectionId] : null;
    const fullName = student ? studentFullName(student) : (reporterNameFallback || "Unknown student");

    const typeBadge = document.getElementById("reporter-modal-type");
    const scopeNote = document.getElementById("reporter-modal-scope-note");
    const roleLabel = document.getElementById("reporter-modal-role-label");
    const nameEl = document.getElementById("reporter-modal-name");
    const lrnEl = document.getElementById("reporter-modal-lrn");
    const sectionEl = document.getElementById("reporter-modal-section");
    const adviserEl = document.getElementById("reporter-modal-adviser");
    const parentEl = document.getElementById("reporter-modal-parent");
    const descWrap = document.getElementById("reporter-modal-desc-wrap");
    const descEl = document.getElementById("reporter-modal-desc");
    const photoEl = document.getElementById("reporter-modal-photo");
    const photoFallbackEl = document.getElementById("reporter-modal-photo-fallback");

    if (typeBadge) typeBadge.textContent = incident.incidentType ? `Reported: ${incident.incidentType}` : "Reported Emergency";
    if (scopeNote) scopeNote.classList.toggle("hidden", !incident.roomWide);
    if (roleLabel) roleLabel.textContent = incident.roomWide ? "Reported By" : (incident.studentId ? "Reported By (about themselves)" : "Reported By");
    if (nameEl) nameEl.textContent = fullName;
    if (lrnEl) lrnEl.textContent = `LRN: ${(student && student.lrn) || reporterLrnFallback || "--"}`;
    if (sectionEl) {
        sectionEl.textContent = studentSection
            ? `${studentSection.gradeName || "--"} \u2013 ${studentSection.name}`
            : "Section not on file";
    }
    if (adviserEl) adviserEl.textContent = studentSection && studentSection.assignedTeacherId ? studentSection.assignedTeacherId : "Unassigned";
    if (parentEl) {
        const parentBits = [];
        if (student && student.parentMobileNo) parentBits.push(student.parentMobileNo);
        if (student && student.parentEmail) parentBits.push(student.parentEmail);
        parentEl.textContent = parentBits.length ? parentBits.join(" \u00b7 ") : "Not on file";
    }
    if (descWrap && descEl) {
        descEl.textContent = incident.description ? `\u201c${incident.description}\u201d` : "";
        descWrap.classList.toggle("hidden", !incident.description);
    }

    setPhoto(photoEl, photoFallbackEl, student, fullName);

    const modal = document.getElementById("reporter-modal");
    if (modal) modal.classList.remove("hidden");
}

function closeReporterModal() {
    const modal = document.getElementById("reporter-modal");
    if (modal) modal.classList.add("hidden");
}

function setPhoto(photoEl, photoFallbackEl, student, fullName) {
    if (!photoEl || !photoFallbackEl) return;

    const initials = student
        ? ((student.firstName || "").charAt(0) + (student.lastName || "").charAt(0)).toUpperCase()
        : (fullName || "?").charAt(0).toUpperCase();
    photoFallbackEl.textContent = initials || "?";

    if (student && student.photoUrl) {
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
}

function studentFullName(student) {
    return [student.firstName, student.middleName, student.lastName, student.extension]
        .filter((v) => v && String(v).trim())
        .join(" ");
}
