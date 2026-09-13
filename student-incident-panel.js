/* ========================================================================== 
   RESCUEPRIORITY — STUDENT INCIDENT PANEL
   --------------------------------------------------------------------------
   This module keeps the two identities on a student-submitted incident
   separate:

   1) Student involved  -> incident.studentId / studentName / studentLrn
                           This is the QR-scanned or manually-entered LRN
                           student and is the PRIMARY person shown to admins.

   2) Reporting account -> incident.reporterId / reporterName / reporterLrn
                           This is whoever was logged in and submitted the
                           report. It is shown separately for accountability.

   Older incident records may only contain studentId/studentName. Those are
   handled with conservative fallbacks so historical data continues to render.
========================================================================== */

import { database } from "./script.js";
import { studentsState, sectionsState } from "./students.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const classroomsRootRef = ref(database, "classrooms");
const incidentsRootRef = ref(database, "incidents");

let classroomsCache = {};
let incidentsCache = {};
let openFacilityId = null;
let currentIncident = null;

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

    if (!incident) {
        banner.classList.add("hidden");
        currentIncident = null;
        return;
    }

    const involved = resolveInvolvedParty(incident);
    const reporter = resolveReporterParty(incident);

    // Keep system/test incidents without either student identity out of this UI.
    if (!involved.hasIdentity && !reporter.hasIdentity) {
        banner.classList.add("hidden");
        currentIncident = null;
        return;
    }

    currentIncident = incident;

    const typeBadge = document.getElementById("modal-student-incident-type");
    const nameEl = document.getElementById("modal-student-name");
    const reporterEl = document.getElementById("modal-student-reporter");
    const photoEl = document.getElementById("modal-student-photo");
    const photoFallbackEl = document.getElementById("modal-student-photo-fallback");

    if (typeBadge) {
        const typeLabel = incident.incidentType ? `Reported: ${incident.incidentType}` : "Reported Emergency";
        typeBadge.textContent = incident.roomWide ? `${typeLabel} — Room-wide` : typeLabel;
    }

    // IMPORTANT: the primary person is the student involved, not the reporter.
    if (nameEl) {
        nameEl.textContent = incident.roomWide
            ? "Student involved: Everyone in the reported area"
            : `Student involved: ${involved.name}`;
    }

    if (reporterEl) {
        reporterEl.textContent = reporter.hasIdentity
            ? `Reported by ${reporter.name}`
            : "Reporter not recorded";
    }

    // Primary photo/initials follow the student involved.
    setPhoto(photoEl, photoFallbackEl, involved.student, involved.name, incident.roomWide ? "ALL" : null);

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
    const involved = resolveInvolvedParty(incident);
    const reporter = resolveReporterParty(incident);

    const typeBadge = document.getElementById("reporter-modal-type");
    const scopeNote = document.getElementById("reporter-modal-scope-note");
    const roleLabel = document.getElementById("reporter-modal-role-label");
    const nameEl = document.getElementById("reporter-modal-name");
    const lrnEl = document.getElementById("reporter-modal-lrn");
    const sectionEl = document.getElementById("reporter-modal-section");
    const adviserEl = document.getElementById("reporter-modal-adviser");
    const parentEl = document.getElementById("reporter-modal-parent");
    const contactGrid = document.getElementById("involved-student-contact-grid");
    const descWrap = document.getElementById("reporter-modal-desc-wrap");
    const descEl = document.getElementById("reporter-modal-desc");
    const photoEl = document.getElementById("reporter-modal-photo");
    const photoFallbackEl = document.getElementById("reporter-modal-photo-fallback");
    const reporterNameEl = document.getElementById("reporter-accountability-name");
    const reporterMetaEl = document.getElementById("reporter-accountability-meta");

    if (typeBadge) typeBadge.textContent = incident.incidentType ? `Reported: ${incident.incidentType}` : "Reported Emergency";
    if (scopeNote) scopeNote.classList.toggle("hidden", !incident.roomWide);

    // Primary identity: scanned/manual student involved.
    if (roleLabel) roleLabel.textContent = incident.roomWide ? "Affected Group" : "Student Involved";
    if (nameEl) nameEl.textContent = incident.roomWide ? "Everyone in the reported area" : involved.name;
    if (lrnEl) lrnEl.textContent = incident.roomWide ? "No single LRN selected" : `LRN: ${involved.lrn}`;
    if (sectionEl) sectionEl.textContent = incident.roomWide ? "Room-wide incident" : involved.sectionLabel;

    if (contactGrid) contactGrid.classList.toggle("hidden", incident.roomWide || !involved.student);
    if (adviserEl) adviserEl.textContent = involved.adviser;
    if (parentEl) adviserEl && (parentEl.textContent = involved.parentContact);

    setPhoto(photoEl, photoFallbackEl, involved.student, involved.name, incident.roomWide ? "ALL" : null);

    // Secondary identity: logged-in reporting account.
    if (reporterNameEl) reporterNameEl.textContent = reporter.name;
    if (reporterMetaEl) {
        const bits = [];
        if (reporter.lrn && reporter.lrn !== "--") bits.push(`LRN ${reporter.lrn}`);
        if (reporter.sectionLabel && reporter.sectionLabel !== "Section not on file") bits.push(reporter.sectionLabel);
        reporterMetaEl.textContent = bits.length ? bits.join(" · ") : "Reporter details not on file";
    }

    if (descWrap && descEl) {
        descEl.textContent = incident.description || "";
        descWrap.classList.toggle("hidden", !incident.description);
    }

    const modal = document.getElementById("reporter-modal");
    if (modal) modal.classList.remove("hidden");
}

function resolveInvolvedParty(incident) {
    if (incident.roomWide) {
        return {
            hasIdentity: true,
            student: null,
            name: "Everyone in the reported area",
            lrn: "--",
            sectionLabel: "Room-wide incident",
            adviser: "--",
            parentContact: "--"
        };
    }

    const studentId = incident.studentId || null;
    const student = studentId ? studentsState[studentId] : null;
    const section = student ? sectionsState[student.sectionId] : null;
    const name = student ? studentFullName(student) : (incident.studentName || "Unknown student");
    const lrn = (student && student.lrn) || incident.studentLrn || "--";
    const sectionLabel = section
        ? `${section.gradeName || "--"} – ${section.name}`
        : (incident.studentSection || "Section not on file");
    const adviser = section && section.assignedTeacherId ? section.assignedTeacherId : "Unassigned";
    const parentBits = [];
    if (student && student.parentMobileNo) parentBits.push(student.parentMobileNo);
    if (student && student.parentEmail) parentBits.push(student.parentEmail);

    return {
        hasIdentity: Boolean(studentId || incident.studentName || incident.studentLrn),
        student,
        name,
        lrn,
        sectionLabel,
        adviser,
        parentContact: parentBits.length ? parentBits.join(" · ") : "Not on file"
    };
}

function resolveReporterParty(incident) {
    // New records use reporter*. For historical records without reporter*,
    // fall back to student* because those older records used one identity.
    const reporterId = incident.reporterId || (!incident.reporterName ? incident.studentId : null) || null;
    const student = reporterId ? studentsState[reporterId] : null;
    const section = student ? sectionsState[student.sectionId] : null;
    const name = student
        ? studentFullName(student)
        : (incident.reporterName || ((!incident.reporterId && !incident.reporterName) ? incident.studentName : null) || "Not recorded");
    const lrn = (student && student.lrn) || incident.reporterLrn || "--";
    const sectionLabel = section
        ? `${section.gradeName || "--"} – ${section.name}`
        : "Section not on file";

    return {
        hasIdentity: Boolean(reporterId || incident.reporterName || incident.reporterLrn || (!incident.reporterId && incident.studentId)),
        student,
        name,
        lrn,
        sectionLabel
    };
}

function closeReporterModal() {
    const modal = document.getElementById("reporter-modal");
    if (modal) modal.classList.add("hidden");
}

function setPhoto(photoEl, photoFallbackEl, student, fullName, forcedFallback = null) {
    if (!photoEl || !photoFallbackEl) return;

    const initials = forcedFallback || (student
        ? ((student.firstName || "").charAt(0) + (student.lastName || "").charAt(0)).toUpperCase()
        : (fullName || "?").charAt(0).toUpperCase());
    photoFallbackEl.textContent = initials || "?";

    if (student && student.photoUrl && !forcedFallback) {
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
