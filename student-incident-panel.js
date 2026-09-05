/* ==========================================================================
   RESCUEPRIORITY — STUDENT INCIDENT PANEL
   --------------------------------------------------------------------------
   Additive module: listens for the room-modal
   open/close events script.js already dispatches, plus its own read-only
   listeners on classrooms/ and incidents/. Writes nothing.

   The Student Incident Reporter app (separate project, same Firebase) adds
   these OPTIONAL fields onto an incidents/{pushKey} record it creates:
       studentId     : string   (present only for an individual report)
       studentName    : string  (denormalized, so this panel works even if
                                  the student is later removed from students/)
       incidentType  : string   ("Headache", "Fire", "Fight", ...)
       roomWide      : boolean  (true = whole-room emergency, no single
                                  student at fault/affected)
       description   : string | null (free-text detail, if provided)

   None of this is required for the existing "Trigger Test Alert" / ESP32
   pipeline — those incidents simply don't have these fields, so this panel
   stays hidden for them.
========================================================================== */

import { database } from "./script.js";
import { studentsState, sectionsState } from "./students.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const classroomsRootRef = ref(database, "classrooms");
const incidentsRootRef = ref(database, "incidents");

let classroomsCache = {};
let incidentsCache = {}; // key -> incident record
let openFacilityId = null;

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
});

function refreshPanel() {
    const section = document.getElementById("modal-student-incident-section");
    if (!section) return;

    if (!openFacilityId) {
        section.classList.add("hidden");
        return;
    }

    const classroomEntry = classroomsCache[openFacilityId];
    const incidentKey = classroomEntry && classroomEntry.emergency ? classroomEntry.activeIncidentKey : null;
    const incident = incidentKey ? incidentsCache[incidentKey] : null;

    if (!incident || incident.roomWide || !incident.studentId) {
        section.classList.add("hidden");
        return;
    }

    const student = studentsState[incident.studentId];
    const studentSection = student ? sectionsState[student.sectionId] : null;

    const typeBadge = document.getElementById("modal-student-incident-type");
    const nameEl = document.getElementById("modal-student-name");
    const lrnEl = document.getElementById("modal-student-lrn");
    const sectionEl = document.getElementById("modal-student-section");
    const adviserEl = document.getElementById("modal-student-adviser");
    const parentEl = document.getElementById("modal-student-parent");
    const descEl = document.getElementById("modal-student-incident-desc");
    const photoEl = document.getElementById("modal-student-photo");
    const photoFallbackEl = document.getElementById("modal-student-photo-fallback");

    const fullName = student
        ? [student.firstName, student.middleName, student.lastName, student.extension]
            .filter((v) => v && String(v).trim())
            .join(" ")
        : (incident.studentName || "Unknown student");

    if (typeBadge) typeBadge.textContent = incident.incidentType ? `Reported: ${incident.incidentType}` : "Reported Emergency";
    if (nameEl) nameEl.textContent = fullName;
    if (lrnEl) lrnEl.textContent = `LRN: ${student && student.lrn ? student.lrn : "--"}`;
    if (sectionEl) {
        sectionEl.textContent = studentSection
            ? `${studentSection.gradeName || "--"} \u2013 ${studentSection.name}`
            : "Section not on file";
    }
    if (adviserEl) adviserEl.textContent = `Adviser: ${studentSection && studentSection.assignedTeacherId ? studentSection.assignedTeacherId : "Unassigned"}`;
    if (parentEl) {
        const parentBits = [];
        if (student && student.parentMobileNo) parentBits.push(student.parentMobileNo);
        if (student && student.parentEmail) parentBits.push(student.parentEmail);
        parentEl.textContent = `Parent contact: ${parentBits.length ? parentBits.join(" \u00b7 ") : "Not on file"}`;
    }
    if (descEl) {
        descEl.textContent = incident.description ? `\u201c${incident.description}\u201d` : "";
        descEl.classList.toggle("hidden", !incident.description);
    }

    if (photoEl && photoFallbackEl) {
        const initials = student
            ? ((student.firstName || "").charAt(0) + (student.lastName || "").charAt(0)).toUpperCase()
            : "?";
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

    section.classList.remove("hidden");
}
