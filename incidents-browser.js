/* ==========================================================================
   RESCUEPRIORITY — INCIDENTS MODULE (grade-level folder browser)
   --------------------------------------------------------------------------
   Additive module, same convention as violations.js: owns its
   own read-only listeners, writes nothing.

   Replaces the old flat "every incident, newest first" list inside
   #incident-folder-list with a drill-down folder structure:

       Grade 7..12 (+ "Ungrouped")
         -> Sections within that grade (sortable: incidents / violations / A-Z)
              -> Roster: students in that section (counts + risk) and the
                 room's raw incident history
                   -> Student detail (dedicated panel, never a modal/popup)
                   -> Raw incident detail (reuses script.js's existing
                      #incident-detail-panel + renderIncidentDetail())

   Data sources (all read-only, live bindings / own listeners):
     - incidents            (script.js export)               -> per-room + optional per-student events
     - SCHOOL_FACILITIES    (script.js export)                -> room name <-> id
     - studentsState / sectionsState (students.js exports)    -> roster + grade/section grouping
     - violationsState (own listener, mirrors violations.js)  -> per-student violation history
========================================================================== */

import {
    database,
    incidents,
    SCHOOL_FACILITIES,
    displayFacilityName,
    showIncidentDetailPanel,
    renderIncidentDetail
} from "./script.js";
import { studentsState, sectionsState } from "./students.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const violationsRootRef = ref(database, "violations");
let violationsCache = {}; // studentId -> [{ key, type, offenseCount, notes, timestamp }, ...]

// Drill-down state
let level = "grades"; // "grades" | "sections" | "roster" | "student"
let activeGrade = null;
let activeSectionId = null;
let activeStudentId = null;
let sortMode = "incidents"; // "incidents" | "violations" | "alpha"

const GRADE_ORDER = ["Grade 7", "Grade 8", "Grade 9", "Grade 10", "Grade 11", "Grade 12"];

document.addEventListener("DOMContentLoaded", () => {
    onValue(
        violationsRootRef,
        (snapshot) => {
            const data = snapshot.val() || {};
            const next = {};
            Object.entries(data).forEach(([studentId, records]) => {
                next[studentId] = Object.entries(records || {}).map(([key, record]) => ({ key, ...record }));
            });
            violationsCache = next;
            render();
        },
        (error) => console.error("[incidents-browser violations listener] Firebase read failed:", error.code, error.message)
    );

    window.addEventListener("rp:incidents-updated", render);
    window.addEventListener("rp:view-changed", (event) => {
        if (event.detail.viewId === "incident-log-view") {
            resetToTop();
        }
    });

    const backToRosterBtn = document.getElementById("btn-back-to-roster");
    if (backToRosterBtn) {
        backToRosterBtn.addEventListener("click", () => {
            activeStudentId = null;
            level = "roster";
            render();
        });
    }

    // The raw single-incident timeline panel (script.js's #incident-detail-panel)
    // is entered from the room-incident-history list below; its own back button
    // should return here to the roster, not to the old flat list.
    const backToIncidentsBtn = document.getElementById("btn-back-to-incidents");
    if (backToIncidentsBtn) {
        backToIncidentsBtn.addEventListener("click", () => {
            level = activeSectionId ? "roster" : "grades";
            render();
        });
    }
});

function resetToTop() {
    level = "grades";
    activeGrade = null;
    activeSectionId = null;
    activeStudentId = null;
    render();
}

/* ==========================================================================
   HELPERS — per-student / per-section aggregation
========================================================================== */
function studentFullName(student) {
    return [student.firstName, student.middleName, student.lastName, student.extension]
        .filter((v) => v && String(v).trim())
        .join(" ");
}

function studentViolationCount(studentId) {
    return (violationsCache[studentId] || []).length;
}

function studentIncidentCount(studentId) {
    return incidents.filter((inc) => inc.studentId === studentId).length;
}

function studentMostRecentViolation(studentId) {
    const list = violationsCache[studentId] || [];
    if (list.length === 0) return null;
    return list.reduce((latest, v) => (v.timestamp > latest ? v.timestamp : latest), 0);
}

function riskLevelFor(violationCount, incidentCount) {
    const score = violationCount * 2 + incidentCount * 3;
    if (score >= 10) return "High";
    if (score >= 4) return "Medium";
    if (score > 0) return "Low";
    return "None";
}

function statusFor(violationCount) {
    if (violationCount >= 3) return "Repeat Offender";
    if (violationCount >= 1) return "Under Watch";
    return "Clear";
}

function sectionFacility(section) {
    return SCHOOL_FACILITIES.find((f) => f.id === section.facilityId) || null;
}

function sectionStudents(sectionId) {
    return Object.entries(studentsState)
        .filter(([, s]) => s.sectionId === sectionId)
        .map(([id, s]) => ({ id, ...s }));
}

function sectionIncidentCount(section) {
    const facility = sectionFacility(section);
    if (!facility) return 0;
    return incidents.filter((inc) => inc.classroom === facility.name).length;
}

function sectionViolationCount(sectionId) {
    return sectionStudents(sectionId).reduce((sum, s) => sum + studentViolationCount(s.id), 0);
}

function normalizeGradeName(gradeName) {
    const trimmed = (gradeName || "").trim();
    return trimmed || "Ungrouped";
}

function gradeSortIndex(gradeName) {
    const idx = GRADE_ORDER.indexOf(gradeName);
    return idx === -1 ? GRADE_ORDER.length : idx;
}

/* ==========================================================================
   RENDER — dispatch to the right level
========================================================================== */
function render() {
    renderBreadcrumb();
    syncPanelVisibility();

    const root = document.getElementById("incident-folder-list");
    if (!root) return;

    if (level === "grades") return renderGrades(root);
    if (level === "sections") return renderSections(root);
    if (level === "roster") return renderRoster(root);
    if (level === "student") return renderStudent();
}

function syncPanelVisibility() {
    const listPanel = document.getElementById("incident-list-panel");
    const studentPanel = document.getElementById("student-detail-panel");
    const detailPanel = document.getElementById("incident-detail-panel");

    const showList = level !== "student";
    if (listPanel) listPanel.classList.toggle("hidden", !showList);
    if (studentPanel) studentPanel.classList.toggle("hidden", level !== "student");
    if (detailPanel) detailPanel.classList.add("hidden");
}

function renderBreadcrumb() {
    const el = document.getElementById("incident-breadcrumb");
    if (!el) return;

    const crumbs = [{ label: "All Grades", action: () => { resetToTop(); } }];

    if (activeGrade) {
        crumbs.push({
            label: activeGrade,
            action: () => { level = "sections"; activeSectionId = null; activeStudentId = null; render(); }
        });
    }
    if (activeSectionId && sectionsState[activeSectionId]) {
        crumbs.push({
            label: sectionsState[activeSectionId].name,
            action: () => { level = "roster"; activeStudentId = null; render(); }
        });
    }
    if (level === "student" && activeStudentId && studentsState[activeStudentId]) {
        crumbs.push({ label: studentFullName(studentsState[activeStudentId]), action: null });
    }

    el.innerHTML = "";
    crumbs.forEach((crumb, i) => {
        if (i > 0) {
            const sep = document.createElement("span");
            sep.className = "folder-breadcrumb-sep";
            sep.textContent = "/";
            el.appendChild(sep);
        }
        const node = document.createElement(crumb.action ? "button" : "span");
        node.className = "folder-breadcrumb-crumb" + (crumb.action ? "" : " is-current");
        if (crumb.action) node.type = "button";
        node.textContent = crumb.label;
        if (crumb.action) node.addEventListener("click", crumb.action);
        el.appendChild(node);
    });
}

/* ---------- LEVEL 0: grades ---------- */
function renderGrades(root) {
    const grades = {};
    Object.values(sectionsState).forEach((section) => {
        const g = normalizeGradeName(section.gradeName);
        if (!grades[g]) grades[g] = { violationCount: 0, incidentCount: 0, sectionCount: 0 };
        grades[g].sectionCount += 1;
    });

    Object.entries(sectionsState).forEach(([sectionId, section]) => {
        const g = normalizeGradeName(section.gradeName);
        grades[g].violationCount += sectionViolationCount(sectionId);
        grades[g].incidentCount += sectionIncidentCount(section);
    });

    const gradeNames = Object.keys(grades).sort((a, b) => gradeSortIndex(a) - gradeSortIndex(b) || a.localeCompare(b));

    if (gradeNames.length === 0) {
        root.innerHTML = `<div class="empty-incident-state">No sections have been created yet. Add sections under Students &amp; Sections first.</div>`;
        return;
    }

    root.innerHTML = "";
    const grid = document.createElement("div");
    grid.className = "grade-folder-grid";

    gradeNames.forEach((gradeName) => {
        const stats = grades[gradeName];
        const card = document.createElement("button");
        card.type = "button";
        card.className = "grade-folder-card";
        card.innerHTML = `
            <span class="grade-folder-icon">&#128193;</span>
            <span class="grade-folder-name">${escapeHtml(gradeName)}</span>
            <span class="grade-folder-meta">${stats.sectionCount} section${stats.sectionCount === 1 ? "" : "s"}</span>
            <span class="grade-folder-stats">
                <span>${stats.incidentCount} incident${stats.incidentCount === 1 ? "" : "s"}</span>
                <span>${stats.violationCount} violation${stats.violationCount === 1 ? "" : "s"}</span>
            </span>
        `;
        card.addEventListener("click", () => {
            activeGrade = gradeName;
            level = "sections";
            render();
        });
        grid.appendChild(card);
    });

    root.appendChild(grid);
}

/* ---------- LEVEL 1: sections within a grade ---------- */
function renderSections(root) {
    const sectionEntries = Object.entries(sectionsState).filter(
        ([, section]) => normalizeGradeName(section.gradeName) === activeGrade
    );

    root.innerHTML = "";

    const sortRow = document.createElement("div");
    sortRow.className = "folder-sort-controls";
    [
        ["incidents", "Highest Incidents"],
        ["violations", "Highest Violations"],
        ["alpha", "Alphabetical"]
    ].forEach(([mode, label]) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "folder-sort-btn" + (sortMode === mode ? " active" : "");
        btn.textContent = label;
        btn.addEventListener("click", () => { sortMode = mode; render(); });
        sortRow.appendChild(btn);
    });
    root.appendChild(sortRow);

    if (sectionEntries.length === 0) {
        root.insertAdjacentHTML("beforeend", `<div class="empty-incident-state">No sections under ${escapeHtml(activeGrade)} yet.</div>`);
        return;
    }

    const rows = sectionEntries.map(([sectionId, section]) => ({
        sectionId,
        section,
        incidentCount: sectionIncidentCount(section),
        violationCount: sectionViolationCount(sectionId)
    }));

    if (sortMode === "incidents") rows.sort((a, b) => b.incidentCount - a.incidentCount);
    else if (sortMode === "violations") rows.sort((a, b) => b.violationCount - a.violationCount);
    else rows.sort((a, b) => a.section.name.localeCompare(b.section.name));

    const list = document.createElement("div");
    list.className = "section-folder-list";

    rows.forEach((row, i) => {
        const facility = sectionFacility(row.section);
        const el = document.createElement("button");
        el.type = "button";
        el.className = "section-folder-row";
        el.innerHTML = `
            <span class="section-folder-rank">#${i + 1}</span>
            <span class="section-folder-icon">&#128193;</span>
            <span class="section-folder-info">
                <span class="section-folder-name">${escapeHtml(row.section.name)}</span>
                <span class="section-folder-sub">${facility ? escapeHtml(displayFacilityName(facility.name)) : "No room linked"} &middot; ${sectionStudents(row.sectionId).length} student${sectionStudents(row.sectionId).length === 1 ? "" : "s"}</span>
            </span>
            <span class="section-folder-stats">
                <span class="section-folder-stat">${row.incidentCount} incident${row.incidentCount === 1 ? "" : "s"}</span>
                <span class="section-folder-stat">${row.violationCount} violation${row.violationCount === 1 ? "" : "s"}</span>
            </span>
        `;
        el.addEventListener("click", () => {
            activeSectionId = row.sectionId;
            level = "roster";
            render();
        });
        list.appendChild(el);
    });

    root.appendChild(list);
}

/* ---------- LEVEL 2: roster (students) + room incident history ---------- */
function renderRoster(root) {
    const section = sectionsState[activeSectionId];
    if (!section) { resetToTop(); return; }

    const facility = sectionFacility(section);
    const students = sectionStudents(activeSectionId).map((s) => ({
        ...s,
        violationCount: studentViolationCount(s.id),
        incidentCount: studentIncidentCount(s.id)
    })).sort((a, b) => (b.violationCount + b.incidentCount) - (a.violationCount + a.incidentCount));

    const roomIncidents = facility
        ? [...incidents].filter((inc) => inc.classroom === facility.name).sort((a, b) => b.timestamp - a.timestamp)
        : [];

    root.innerHTML = `<h3 class="folder-subheading">Students in ${escapeHtml(section.name)}</h3>`;

    const rosterWrap = document.createElement("div");
    rosterWrap.className = "section-folder-list";
    if (students.length === 0) {
        rosterWrap.innerHTML = `<div class="empty-incident-state">No students registered in this section yet.</div>`;
    } else {
        students.forEach((s) => {
            const risk = riskLevelFor(s.violationCount, s.incidentCount);
            const el = document.createElement("button");
            el.type = "button";
            el.className = "section-folder-row";
            el.innerHTML = `
                <span class="section-folder-icon">&#128100;</span>
                <span class="section-folder-info">
                    <span class="section-folder-name">${escapeHtml(studentFullName(s))}</span>
                    <span class="section-folder-sub">LRN ${escapeHtml(s.lrn || "--")}</span>
                </span>
                <span class="section-folder-stats">
                    <span class="section-folder-stat">${s.incidentCount} incident${s.incidentCount === 1 ? "" : "s"}</span>
                    <span class="section-folder-stat">${s.violationCount} violation${s.violationCount === 1 ? "" : "s"}</span>
                    <span class="status-pill risk-${risk.toLowerCase()}">${risk} Risk</span>
                </span>
            `;
            el.addEventListener("click", () => {
                activeStudentId = s.id;
                level = "student";
                render();
            });
            rosterWrap.appendChild(el);
        });
    }
    root.appendChild(rosterWrap);

    const historyHeading = document.createElement("h3");
    historyHeading.className = "folder-subheading";
    historyHeading.textContent = `Room Incident History${facility ? ` — ${displayFacilityName(facility.name)}` : ""}`;
    root.appendChild(historyHeading);

    const historyWrap = document.createElement("div");
    historyWrap.className = "incident-folder-list";
    if (roomIncidents.length === 0) {
        historyWrap.innerHTML = `<div class="empty-incident-state">No recorded incidents for this room.</div>`;
    } else {
        roomIncidents.forEach((incident) => {
            const card = document.createElement("div");
            card.className = "incident-card";
            const statusClass = `status-${incident.status.toLowerCase()}`;
            card.innerHTML = `
                <div class="incident-card-main">
                    <span class="incident-card-id">${escapeHtml(incident.incidentNumber || "")}</span>
                    <span class="incident-card-sub">${escapeHtml(displayFacilityName(incident.classroom))}</span>
                    <span class="incident-card-time">${new Date(incident.timestamp).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <span class="status-pill ${statusClass}">${escapeHtml(incident.status)}</span>
            `;
            card.addEventListener("click", () => {
                renderIncidentDetail(incident);
                showIncidentDetailPanel();
            });
            historyWrap.appendChild(card);
        });
    }
    root.appendChild(historyWrap);
}

/* ---------- LEVEL 3: student detail (dedicated panel, not a modal) ---------- */
function renderStudent() {
    const student = studentsState[activeStudentId];
    if (!student) { level = "roster"; render(); return; }

    const section = sectionsState[student.sectionId];
    const violationCount = studentViolationCount(activeStudentId);
    const incidentCount = studentIncidentCount(activeStudentId);
    const risk = riskLevelFor(violationCount, incidentCount);
    const mostRecent = studentMostRecentViolation(activeStudentId);

    setText("student-detail-name", studentFullName(student));
    setText("student-detail-meta", `LRN ${student.lrn || "--"} \u00b7 ${section ? `${section.gradeName || "--"} \u2013 ${section.name}` : "No section on file"}`);
    setText("student-detail-violation-count", String(violationCount));
    setText("student-detail-incident-count", String(incidentCount));
    setText("student-detail-recent-violation", mostRecent ? new Date(mostRecent).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" }) : "--");
    setText("student-detail-status", statusFor(violationCount));

    const badge = document.getElementById("student-detail-risk-badge");
    if (badge) {
        badge.textContent = `${risk} Risk`;
        badge.className = `status-pill risk-${risk.toLowerCase()}`;
    }

    const photoEl = document.getElementById("student-detail-photo");
    const photoFallbackEl = document.getElementById("student-detail-photo-fallback");
    if (photoEl && photoFallbackEl) {
        const initials = ((student.firstName || "").charAt(0) + (student.lastName || "").charAt(0)).toUpperCase();
        photoFallbackEl.textContent = initials || "?";
        if (student.photoUrl) {
            photoEl.src = student.photoUrl;
            photoEl.classList.remove("hidden");
            photoFallbackEl.classList.add("hidden");
            photoEl.onerror = () => { photoEl.classList.add("hidden"); photoFallbackEl.classList.remove("hidden"); };
        } else {
            photoEl.classList.add("hidden");
            photoFallbackEl.classList.remove("hidden");
        }
    }

    const timeline = document.getElementById("student-detail-timeline");
    if (timeline) {
        timeline.innerHTML = "";
        const events = [];
        (violationsCache[activeStudentId] || []).forEach((v) => {
            events.push({ timestamp: v.timestamp, type: "resolved", message: `${v.type} (${ordinal(v.offenseCount)})` });
        });
        incidents.filter((inc) => inc.studentId === activeStudentId).forEach((inc) => {
            events.push({ timestamp: inc.timestamp, type: "triggered", message: inc.incidentType ? `Incident reported: ${inc.incidentType}` : "Incident reported" });
        });
        events.sort((a, b) => b.timestamp - a.timestamp);

        if (events.length === 0) {
            timeline.innerHTML = `<li class="empty-incident-state">No violations or incidents on record for this student.</li>`;
        } else {
            events.forEach((event) => {
                const li = document.createElement("li");
                li.className = `timeline-event event-${event.type}`;
                li.innerHTML = `
                    <span class="timeline-event-time">${new Date(event.timestamp).toLocaleDateString("en-PH", { month: "short", day: "numeric" })}</span>
                    <span class="timeline-marker"><span class="timeline-dot"></span><span class="timeline-line"></span></span>
                    <span class="timeline-content"><span class="timeline-event-title">${escapeHtml(event.message)}</span></span>
                `;
                timeline.appendChild(li);
            });
        }
    }
}

function ordinal(n) {
    if (n === 1) return "1st Offense";
    if (n === 2) return "2nd Offense";
    if (n === 3) return "3rd Offense";
    return `${n}th Offense`;
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
}
