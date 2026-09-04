/* ==========================================================================
   RESCUEPRIORITY — STUDENTS & SECTIONS MODULE
   --------------------------------------------------------------------------
   Additive module. Does NOT touch classrooms/, incidents/, or counters/.
   Reuses the existing Firebase connection, SCHOOL_FACILITIES list, and the
   isClassroomFacility() helper already exported from script.js instead of
   opening a second connection or duplicating the facility list.

   New Firebase paths owned by this file:
     students/{studentId}  -> lrn, firstName, middleName?, lastName,
                               extension?, parentMobileNo, parentEmail?,
                               sectionId, facilityId (denormalized)
     sections/{sectionId}  -> name, gradeId, gradeName, assignedTeacherId?,
                               facilityId  (must match a SCHOOL_FACILITIES id)

   Field names/shapes and the "QR encodes LRN only" approach are carried
   over from the astig frontend (features/student/types/student.ts +
   StudentQrModal.tsx) as a reference — no astig code or backend is used.

   QR generation uses the `qrcode` UMD build loaded via <script> in
   index.html (exposes window.QRCode), the same API astig's
   StudentQrModal.tsx calls: QRCode.toCanvas(canvas, text, options).
========================================================================== */

import { database, SCHOOL_FACILITIES, isClassroomFacility, displayFacilityName } from "./script.js";
import { violationsState } from "./violations.js";
import {
    ref,
    push,
    set,
    update,
    remove,
    onValue,
    get,
    query,
    orderByChild,
    startAt
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const studentsRootRef = ref(database, "students");
const sectionsRootRef = ref(database, "sections");

/* Read-only ref onto the attendance/ tree already owned by
   scan-attendance.js. Just a pointer — no listener is attached until the
   Section Detail modal (below) is actually open, so this doesn't touch or
   duplicate scan-attendance.js's own always-on setupLiveStats() listener. */
const attendanceRootRef = ref(database, "attendance");

/* Read-only ref + own live listener onto incidents/, same reasoning as
   insights.js: importing script.js's internal `incidents` binding proved
   unreliable for downstream modules (it didn't always reflect the latest
   snapshot by the time this file re-rendered). A dedicated listener here
   guarantees the Incidents column on the Section Roster view, the per-
   student Incidents tab, and the "Highest Incidents" sort all agree with
   Firebase's actual state. */
const incidentsRootRef = ref(database, "incidents");
let incidentsCache = [];

/* Live in-memory caches, keyed by push id. Populated by onValue listeners
   set up once in initStudentsModule(). Exported so scan-attendance.js can
   reuse the same live student list instead of opening its own listener. */
export let studentsState = {};   // studentId -> student record
export let sectionsState = {};   // sectionId -> section record

const classroomFacilities = SCHOOL_FACILITIES.filter(isClassroomFacility);

/* ==========================================================================
   SECTION STATS (incident count / violation count / student count)
   Shared, single source of truth used by: the Sections-in-grade sort
   ("Alphabetically" / "Highest Incidents" / "Highest Violations"), the
   grade-folder counts, the Section Roster header, and the Analytics
   "Top Sections" chart (insights.js imports this rather than re-deriving
   its own numbers, so the sort order and the chart always agree).
   Incidents count = incidents individually tied to a student in this
   section (incident.studentId) PLUS room-wide incidents logged against
   the classroom this section is linked to (incident.classroom matching
   the linked facility's name) — this mirrors how the Section Detail /
   per-student Incidents tab already defines "involved in an incident".
========================================================================== */
export function computeSectionStats(sectionId) {
    const section = sectionsState[sectionId];
    const facility = section ? SCHOOL_FACILITIES.find((f) => f.id === section.facilityId) : null;
    const roomName = facility ? facility.name : null;

    const sectionStudentIds = Object.entries(studentsState)
        .filter(([, s]) => s.sectionId === sectionId)
        .map(([id]) => id);
    const studentIdSet = new Set(sectionStudentIds);

    const incidentCount = incidentsCache.filter((inc) => {
        if (inc.studentId && studentIdSet.has(inc.studentId)) return true;
        if (roomName && inc.roomWide && inc.classroom === roomName) return true;
        return false;
    }).length;

    const violationCount = sectionStudentIds.reduce(
        (sum, id) => sum + (violationsState[id] || []).length,
        0
    );

    return { studentCount: sectionStudentIds.length, incidentCount, violationCount };
}

/* ==========================================================================
   VALIDATION (mirrors astig's studentSchema.ts rules, re-implemented in
   plain JS since this project has no build step / no zod dependency)
========================================================================== */
function validateStudentForm(values) {
    const errors = {};

    if (!values.lrn || !values.lrn.trim()) errors.lrn = "LRN is required.";
    if (!values.firstName || !values.firstName.trim()) errors.firstName = "First name is required.";
    if (!values.lastName || !values.lastName.trim()) errors.lastName = "Last name is required.";
    if (!values.parentMobileNo || !values.parentMobileNo.trim()) errors.parentMobileNo = "Parent mobile number is required.";
    if (!values.sectionId) errors.sectionId = "Please select a section.";

    return errors;
}

function validateSectionForm(values) {
    const errors = {};

    if (!values.name || !values.name.trim()) errors.name = "Section name is required.";
    if (!values.gradeName || !values.gradeName.trim()) errors.gradeName = "Grade level is required.";
    if (!values.facilityId) errors.facilityId = "Please link a facility/room.";

    return errors;
}

function slugify(text) {
    return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/* ==========================================================================
   INITIALIZATION
   Self-initializes on load (same pattern as insights.js / weather.js) so
   the students/sections listeners are always live — scan-attendance.js
   imports studentsState as a live binding and depends on this having run.
========================================================================== */
document.addEventListener("DOMContentLoaded", () => {
    initStudentsModule();
});

export function initStudentsModule() {
    setupSubtabs();
    setupStudentsToolbar();
    setupSectionsToolbar();
    setupStudentModal();
    setupSectionModal();
    setupSectionsBrowser();
    setupSectionRosterView();
    setupStudentDetailModal();
    setupQrModal();
    setupEmailLateListButton();

    onValue(sectionsRootRef, (snapshot) => {
        sectionsState = snapshot.val() || {};
        renderSectionsBrowser();
        renderSectionRoster();
        populateSectionDropdown();
    });

    onValue(studentsRootRef, (snapshot) => {
        studentsState = snapshot.val() || {};
        renderStudentsTable();
        renderSectionsBrowser();
        renderSectionRoster();
    });

    onValue(incidentsRootRef, (snapshot) => {
        const data = snapshot.val() || {};
        incidentsCache = Object.keys(data).map((key) => ({ key, ...data[key] }));
        renderSectionsBrowser();
        renderSectionRoster();
    });
}

/* ==========================================================================
   SUB-TABS (Students <-> Sections)
========================================================================== */
function setupSubtabs() {
    document.querySelectorAll(".students-subtab-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".students-subtab-btn").forEach((b) => b.classList.toggle("active", b === btn));

            const target = btn.dataset.subtab;
            document.querySelectorAll(".students-subpanel").forEach((panel) => {
                panel.classList.toggle("hidden", panel.dataset.subpanel !== target);
            });
        });
    });
}

/* ==========================================================================
   STUDENTS TABLE
========================================================================== */
let studentSearchTerm = "";

function setupStudentsToolbar() {
    const searchInput = document.getElementById("students-search-input");
    const addButton = document.getElementById("btn-add-student");

    if (searchInput) {
        searchInput.addEventListener("input", () => {
            studentSearchTerm = searchInput.value.trim().toLowerCase();
            renderStudentsTable();
        });
    }

    if (addButton) {
        addButton.addEventListener("click", () => openStudentModal(null));
    }
}

function studentFullName(student) {
    return [student.firstName, student.middleName, student.lastName, student.extension]
        .filter((v) => v && String(v).trim())
        .join(" ");
}

function studentInitials(student) {
    const first = (student.firstName || "").trim().charAt(0);
    const last = (student.lastName || "").trim().charAt(0);
    return (first + last).toUpperCase() || "?";
}

function renderStudentsTable() {
    const tbody = document.getElementById("students-table-body");
    const emptyState = document.getElementById("students-table-empty");

    if (!tbody) return;

    const rows = Object.entries(studentsState)
        .map(([id, student]) => ({ id, ...student }))
        .filter((student) => {
            if (!studentSearchTerm) return true;
            const haystack = `${studentFullName(student)} ${student.lrn}`.toLowerCase();
            return haystack.includes(studentSearchTerm);
        })
        .sort((a, b) => studentFullName(a).localeCompare(studentFullName(b)));

    tbody.innerHTML = "";

    if (rows.length === 0) {
        if (emptyState) emptyState.classList.remove("hidden");
        return;
    }
    if (emptyState) emptyState.classList.add("hidden");

    rows.forEach((student) => {
        const section = sectionsState[student.sectionId];
        const tr = document.createElement("tr");

        const initials = studentInitials(student);
        const avatarHtml = student.photoUrl
            ? `<img src="${escapeHtml(student.photoUrl)}" alt="" class="student-row-avatar" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'student-row-avatar student-row-avatar-fallback',textContent:'${initials}'}))">`
            : `<span class="student-row-avatar student-row-avatar-fallback">${initials}</span>`;

        tr.innerHTML = `
            <td><div class="student-row-name">${avatarHtml}<span>${escapeHtml(studentFullName(student))}</span></div></td>
            <td><span class="pill-tag">${escapeHtml(student.lrn || "--")}</span></td>
            <td>${escapeHtml(section ? section.name : "Unassigned")}</td>
            <td>${escapeHtml(section ? section.gradeName : "--")}</td>
            <td>${escapeHtml(student.parentMobileNo || "--")}</td>
            <td>
                <div class="table-row-actions">
                    <button type="button" class="icon-btn btn-view-qr" data-id="${student.id}">QR</button>
                    <button type="button" class="icon-btn btn-edit-student" data-id="${student.id}">Edit</button>
                    <button type="button" class="icon-btn icon-btn-danger btn-delete-student" data-id="${student.id}">Delete</button>
                </div>
            </td>
        `;

        tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".btn-view-qr").forEach((btn) => {
        btn.addEventListener("click", () => openQrModal(btn.dataset.id));
    });
    tbody.querySelectorAll(".btn-edit-student").forEach((btn) => {
        btn.addEventListener("click", () => openStudentModal(btn.dataset.id));
    });
    tbody.querySelectorAll(".btn-delete-student").forEach((btn) => {
        btn.addEventListener("click", () => deleteStudent(btn.dataset.id));
    });
}

async function deleteStudent(studentId) {
    const student = studentsState[studentId];
    if (!student) return;

    const confirmed = window.confirm(`Remove ${studentFullName(student)} (LRN ${student.lrn}) from the student list?`);
    if (!confirmed) return;

    await remove(ref(database, `students/${studentId}`));
}

/* ==========================================================================
   STUDENT ADD / EDIT MODAL
========================================================================== */
let editingStudentId = null;

function setupStudentModal() {
    const modal = document.getElementById("student-modal");
    const closeBtn = document.getElementById("student-modal-close");
    const cancelBtn = document.getElementById("btn-student-cancel");
    const saveBtn = document.getElementById("btn-student-save");

    if (closeBtn) closeBtn.addEventListener("click", closeStudentModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeStudentModal);
    if (modal) {
        modal.addEventListener("click", (event) => {
            if (event.target === modal) closeStudentModal();
        });
    }
    if (saveBtn) saveBtn.addEventListener("click", handleStudentSave);
}

function populateSectionDropdown() {
    const select = document.getElementById("student-field-sectionId");
    if (!select) return;

    const currentValue = select.value;
    select.innerHTML = '<option value="">Select a section...</option>';

    Object.entries(sectionsState)
        .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""))
        .forEach(([id, section]) => {
            const opt = document.createElement("option");
            opt.value = id;
            opt.textContent = `${section.name} (${section.gradeName})`;
            select.appendChild(opt);
        });

    if (currentValue) select.value = currentValue;
}

function openStudentModal(studentId) {
    editingStudentId = studentId;
    const modal = document.getElementById("student-modal");
    const title = document.getElementById("student-modal-title");
    const student = studentId ? studentsState[studentId] : null;

    clearStudentFormErrors();

    document.getElementById("student-field-lrn").value = student?.lrn || "";
    document.getElementById("student-field-firstName").value = student?.firstName || "";
    document.getElementById("student-field-middleName").value = student?.middleName || "";
    document.getElementById("student-field-lastName").value = student?.lastName || "";
    document.getElementById("student-field-extension").value = student?.extension || "";
    document.getElementById("student-field-parentMobileNo").value = student?.parentMobileNo || "";
    document.getElementById("student-field-parentEmail").value = student?.parentEmail || "";
    document.getElementById("student-field-sectionId").value = student?.sectionId || "";
    document.getElementById("student-field-photoUrl").value = student?.photoUrl || "";

    if (title) title.textContent = student ? "Edit Student" : "Add Student";
    if (modal) modal.classList.remove("hidden");
}

function closeStudentModal() {
    const modal = document.getElementById("student-modal");
    if (modal) modal.classList.add("hidden");
    editingStudentId = null;
}

function clearStudentFormErrors() {
    document.querySelectorAll("#student-modal .field-error").forEach((el) => (el.textContent = ""));
    const generalError = document.getElementById("student-form-general-error");
    if (generalError) generalError.classList.add("hidden");
}

async function handleStudentSave() {
    const values = {
        lrn: document.getElementById("student-field-lrn").value.trim(),
        firstName: document.getElementById("student-field-firstName").value.trim(),
        middleName: document.getElementById("student-field-middleName").value.trim(),
        lastName: document.getElementById("student-field-lastName").value.trim(),
        extension: document.getElementById("student-field-extension").value.trim(),
        parentMobileNo: document.getElementById("student-field-parentMobileNo").value.trim(),
        parentEmail: document.getElementById("student-field-parentEmail").value.trim(),
        sectionId: document.getElementById("student-field-sectionId").value,
        photoUrl: document.getElementById("student-field-photoUrl").value.trim()
    };

    clearStudentFormErrors();
    const errors = validateStudentForm(values);

    if (Object.keys(errors).length > 0) {
        Object.entries(errors).forEach(([field, message]) => {
            const el = document.getElementById(`student-error-${field}`);
            if (el) el.textContent = message;
        });
        return;
    }

    // Duplicate-LRN guard (LRN is the QR payload and the scan-time lookup
    // key, so it must be unique across students).
    const duplicate = Object.entries(studentsState).find(
        ([id, s]) => s.lrn === values.lrn && id !== editingStudentId
    );
    if (duplicate) {
        const generalError = document.getElementById("student-form-general-error");
        if (generalError) {
            generalError.textContent = "That LRN is already registered to another student.";
            generalError.classList.remove("hidden");
        }
        return;
    }

    const section = sectionsState[values.sectionId];
    const payload = {
        lrn: values.lrn,
        firstName: values.firstName,
        middleName: values.middleName || null,
        lastName: values.lastName,
        extension: values.extension || null,
        parentMobileNo: values.parentMobileNo,
        parentEmail: values.parentEmail || null,
        sectionId: values.sectionId,
        facilityId: section ? section.facilityId : null,  // denormalized for fast scan-time lookup
        photoUrl: values.photoUrl || null                 // shown on Kiosk Display at scan time
    };

    if (editingStudentId) {
        await update(ref(database, `students/${editingStudentId}`), payload);
    } else {
        await set(push(studentsRootRef), payload);
    }

    closeStudentModal();
}

/* ==========================================================================
   SECTIONS BROWSER — Grade folders -> Sections-in-grade (sortable)
   --------------------------------------------------------------------------
   Two-level drill-down instead of one flat table: the Sections subpanel
   opens on a grid of grade-level "folders" (Grade 7, Grade 8, ...); opening
   one shows just that grade's sections, sortable by name / incident count /
   violation count. Opening a section itself hands off to the full-screen
   Section Roster view further down this file (not a modal).
========================================================================== */
let sectionsBrowseLevel = "grades"; // "grades" | "sections"
let currentGradeId = null;
let sectionsSortMode = "alpha"; // "alpha" | "incidents" | "violations"

function setupSectionsToolbar() {
    const addButton = document.getElementById("btn-add-section");
    if (addButton) addButton.addEventListener("click", () => openSectionModal(null));
}

function setupSectionsBrowser() {
    const sortSelect = document.getElementById("sections-sort-select");
    if (sortSelect) {
        sortSelect.addEventListener("change", () => {
            sectionsSortMode = sortSelect.value;
            renderSectionsBrowser();
        });
    }

    const backButton = document.getElementById("btn-back-to-grades");
    if (backButton) {
        backButton.addEventListener("click", () => {
            sectionsBrowseLevel = "grades";
            currentGradeId = null;
            renderSectionsBrowser();
        });
    }
}

// Groups sections by gradeId (falls back to a slug of gradeName for any
// legacy record saved before gradeId existed), sorted numerically-aware so
// "Grade 2" sorts before "Grade 10".
function getGradeGroups() {
    const groups = new Map();

    Object.entries(sectionsState).forEach(([id, section]) => {
        const gradeId = section.gradeId || slugify(section.gradeName || "ungraded");
        if (!groups.has(gradeId)) {
            groups.set(gradeId, { gradeId, gradeName: section.gradeName || "Ungraded", sectionIds: [] });
        }
        groups.get(gradeId).sectionIds.push(id);
    });

    return [...groups.values()].sort((a, b) =>
        a.gradeName.localeCompare(b.gradeName, undefined, { numeric: true })
    );
}

function renderSectionsBrowser() {
    const gradesView = document.getElementById("grade-folders-view");
    const sectionsView = document.getElementById("sections-in-grade-view");
    if (!gradesView || !sectionsView) return;

    if (sectionsBrowseLevel === "sections" && currentGradeId && getGradeGroups().some((g) => g.gradeId === currentGradeId)) {
        gradesView.classList.add("hidden");
        sectionsView.classList.remove("hidden");
        renderSectionsInGrade();
    } else {
        sectionsBrowseLevel = "grades";
        currentGradeId = null;
        gradesView.classList.remove("hidden");
        sectionsView.classList.add("hidden");
        renderGradeFolders();
    }
}

function renderGradeFolders() {
    const grid = document.getElementById("grade-folders-grid");
    const emptyState = document.getElementById("grade-folders-empty");
    if (!grid) return;

    const groups = getGradeGroups();
    grid.innerHTML = "";

    if (groups.length === 0) {
        if (emptyState) emptyState.classList.remove("hidden");
        return;
    }
    if (emptyState) emptyState.classList.add("hidden");

    groups.forEach((group) => {
        let incidentTotal = 0;
        let violationTotal = 0;
        let studentTotal = 0;

        group.sectionIds.forEach((id) => {
            const stats = computeSectionStats(id);
            incidentTotal += stats.incidentCount;
            violationTotal += stats.violationCount;
            studentTotal += stats.studentCount;
        });

        const card = document.createElement("button");
        card.type = "button";
        card.className = "grade-folder-card";
        card.dataset.gradeId = group.gradeId;
        card.innerHTML = `
            <span class="grade-folder-icon" aria-hidden="true">&#128193;</span>
            <span class="grade-folder-name">${escapeHtml(group.gradeName)}</span>
            <span class="grade-folder-meta">${group.sectionIds.length} section${group.sectionIds.length === 1 ? "" : "s"} &middot; ${studentTotal} student${studentTotal === 1 ? "" : "s"}</span>
            <span class="grade-folder-stats">
                <span class="grade-folder-stat stat-incidents">${incidentTotal} incident${incidentTotal === 1 ? "" : "s"}</span>
                <span class="grade-folder-stat stat-violations">${violationTotal} violation${violationTotal === 1 ? "" : "s"}</span>
            </span>
        `;
        card.addEventListener("click", () => {
            currentGradeId = group.gradeId;
            sectionsBrowseLevel = "sections";
            renderSectionsBrowser();
        });
        grid.appendChild(card);
    });
}

function renderSectionsInGrade() {
    const list = document.getElementById("sections-in-grade-list");
    const emptyState = document.getElementById("sections-in-grade-empty");
    const titleEl = document.getElementById("sections-in-grade-title");
    if (!list) return;

    const group = getGradeGroups().find((g) => g.gradeId === currentGradeId);
    if (!group) {
        sectionsBrowseLevel = "grades";
        currentGradeId = null;
        renderSectionsBrowser();
        return;
    }

    if (titleEl) titleEl.textContent = group.gradeName;

    const sortSelect = document.getElementById("sections-sort-select");
    if (sortSelect && sortSelect.value !== sectionsSortMode) sortSelect.value = sectionsSortMode;

    const rows = group.sectionIds.map((id) => ({
        id,
        section: sectionsState[id],
        stats: computeSectionStats(id)
    }));

    if (sectionsSortMode === "incidents") {
        rows.sort((a, b) => b.stats.incidentCount - a.stats.incidentCount || a.section.name.localeCompare(b.section.name));
    } else if (sectionsSortMode === "violations") {
        rows.sort((a, b) => b.stats.violationCount - a.stats.violationCount || a.section.name.localeCompare(b.section.name));
    } else {
        rows.sort((a, b) => (a.section.name || "").localeCompare(b.section.name || ""));
    }

    list.innerHTML = "";

    if (rows.length === 0) {
        if (emptyState) emptyState.classList.remove("hidden");
        return;
    }
    if (emptyState) emptyState.classList.add("hidden");

    rows.forEach(({ id, section, stats }) => {
        const facility = SCHOOL_FACILITIES.find((f) => f.id === section.facilityId);

        const card = document.createElement("div");
        card.className = "section-folder-card";
        card.innerHTML = `
            <button type="button" class="section-folder-open" data-id="${id}">
                <span class="section-folder-icon" aria-hidden="true">&#128194;</span>
                <span class="section-folder-body">
                    <span class="section-folder-name">${escapeHtml(section.name)}</span>
                    <span class="section-folder-meta">${escapeHtml(section.assignedTeacherId || "Unassigned adviser")} &middot; ${escapeHtml(facility ? displayFacilityName(facility.name) : "Not linked")}</span>
                </span>
                <span class="section-folder-stats">
                    <span class="section-folder-stat">${stats.studentCount} student${stats.studentCount === 1 ? "" : "s"}</span>
                    <span class="section-folder-stat stat-incidents">${stats.incidentCount} incident${stats.incidentCount === 1 ? "" : "s"}</span>
                    <span class="section-folder-stat stat-violations">${stats.violationCount} violation${stats.violationCount === 1 ? "" : "s"}</span>
                </span>
            </button>
            <div class="table-row-actions section-folder-actions">
                <button type="button" class="icon-btn btn-edit-section" data-id="${id}">Edit</button>
                <button type="button" class="icon-btn icon-btn-danger btn-delete-section" data-id="${id}">Delete</button>
            </div>
        `;
        list.appendChild(card);
    });

    list.querySelectorAll(".section-folder-open").forEach((btn) => {
        btn.addEventListener("click", () => openSectionRosterView(btn.dataset.id));
    });
    list.querySelectorAll(".btn-edit-section").forEach((btn) => {
        btn.addEventListener("click", () => openSectionModal(btn.dataset.id));
    });
    list.querySelectorAll(".btn-delete-section").forEach((btn) => {
        btn.addEventListener("click", () => deleteSection(btn.dataset.id));
    });
}

async function deleteSection(sectionId) {
    const section = sectionsState[sectionId];
    if (!section) return;

    const studentCount = Object.values(studentsState).filter((s) => s.sectionId === sectionId).length;
    if (studentCount > 0) {
        window.alert(`Can't delete "${section.name}" — ${studentCount} student(s) are still assigned to it. Reassign them first.`);
        return;
    }

    const confirmed = window.confirm(`Delete section "${section.name}"?`);
    if (!confirmed) return;

    await remove(ref(database, `sections/${sectionId}`));
}

/* ==========================================================================
   SECTION ADD / EDIT MODAL
========================================================================== */
let editingSectionId = null;

function setupSectionModal() {
    const modal = document.getElementById("section-modal");
    const closeBtn = document.getElementById("section-modal-close");
    const cancelBtn = document.getElementById("btn-section-cancel");
    const saveBtn = document.getElementById("btn-section-save");

    if (closeBtn) closeBtn.addEventListener("click", closeSectionModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeSectionModal);
    if (modal) {
        modal.addEventListener("click", (event) => {
            if (event.target === modal) closeSectionModal();
        });
    }
    if (saveBtn) saveBtn.addEventListener("click", handleSectionSave);

    populateFacilityDropdown();
}

function populateFacilityDropdown() {
    const select = document.getElementById("section-field-facilityId");
    if (!select) return;

    select.innerHTML = '<option value="">Select a room on the campus map...</option>';

    classroomFacilities.forEach((facility) => {
        const opt = document.createElement("option");
        opt.value = facility.id;
        opt.textContent = `${displayFacilityName(facility.name)} — ${facility.section} (${facility.zone})`;
        select.appendChild(opt);
    });
}

function openSectionModal(sectionId) {
    editingSectionId = sectionId;
    const modal = document.getElementById("section-modal");
    const title = document.getElementById("section-modal-title");
    const section = sectionId ? sectionsState[sectionId] : null;

    clearSectionFormErrors();

    document.getElementById("section-field-name").value = section?.name || "";
    document.getElementById("section-field-gradeName").value = section?.gradeName || "";
    document.getElementById("section-field-assignedTeacherId").value = section?.assignedTeacherId || "";
    document.getElementById("section-field-facilityId").value = section?.facilityId || "";

    if (title) title.textContent = section ? "Edit Section" : "Add Section";
    if (modal) modal.classList.remove("hidden");
}

function closeSectionModal() {
    const modal = document.getElementById("section-modal");
    if (modal) modal.classList.add("hidden");
    editingSectionId = null;
}

function clearSectionFormErrors() {
    document.querySelectorAll("#section-modal .field-error").forEach((el) => (el.textContent = ""));
}

async function handleSectionSave() {
    const values = {
        name: document.getElementById("section-field-name").value.trim(),
        gradeName: document.getElementById("section-field-gradeName").value.trim(),
        assignedTeacherId: document.getElementById("section-field-assignedTeacherId").value.trim(),
        facilityId: document.getElementById("section-field-facilityId").value
    };

    clearSectionFormErrors();
    const errors = validateSectionForm(values);

    if (Object.keys(errors).length > 0) {
        Object.entries(errors).forEach(([field, message]) => {
            const el = document.getElementById(`section-error-${field}`);
            if (el) el.textContent = message;
        });
        return;
    }

    const payload = {
        name: values.name,
        gradeName: values.gradeName,
        gradeId: slugify(values.gradeName),
        assignedTeacherId: values.assignedTeacherId || null,
        facilityId: values.facilityId
    };

    if (editingSectionId) {
        await update(ref(database, `sections/${editingSectionId}`), payload);

        // Keep denormalized facilityId in sync on every student in this
        // section, so scan-time lookups never point at a stale room.
        const affected = Object.entries(studentsState).filter(([, s]) => s.sectionId === editingSectionId);
        await Promise.all(
            affected.map(([id]) => update(ref(database, `students/${id}`), { facilityId: values.facilityId }))
        );
    } else {
        await set(push(sectionsRootRef), payload);
    }

    closeSectionModal();
}

/* ==========================================================================
   SECTION ROSTER VIEW (full-screen, replaces the old floating modal)
   --------------------------------------------------------------------------
   Opening a section (from the Sections-in-grade list) hands off to a
   full-screen/full-tab view — #section-roster-view, toggled the same way
   the sidebar's .app-view panels are, not a .modal-overlay — listing every
   student in that section as real <table> rows: Name, LRN, live check-in
   status (green/red dot, same rule as before), Late/On-time, Violations
   count, Incidents count, Last scan, and an Actions column whose "View"
   button opens the per-student detail (tabs: Overview / Violations /
   Incidents / Timeline) in a small modal — that's the one appropriate use
   of a floating window here, since it's a drill-down on a single row, not
   the whole roster.

   Presence is derived from today's attendance/{logId} logs using the exact
   same rule scan-attendance.js's setupLiveStats() uses for its header
   counters: query today's logs only, keep the latest log per studentId,
   and treat direction === "in" as present. That logic lives in a private,
   unexported function inside scan-attendance.js, so it's re-implemented
   here rather than duplicated via import.

   The attendance listener here is scoped to the roster view only: it's
   attached with onValue() when the view opens and detached when it closes,
   so it never competes with or duplicates the always-on students/sections
   listeners set up once in initStudentsModule(), or scan-attendance.js's
   own always-on listener.
========================================================================== */
/* ==========================================================================
   EMAIL TODAY'S LATE LIST
   --------------------------------------------------------------------------
   One-off read of today's attendance (not a live listener — this only runs
   when the button is clicked), finds every student whose FIRST "in" scan
   today was after the 7:15 cutoff, and opens a pre-filled email via a
   mailto: link (no backend/email-service account needed). Swap the
   window.location.href assignment for an EmailJS/Cloud Function send later
   if you'd rather it go out silently without opening a mail client.
   Placed here (rather than up near setupStudentsToolbar) because it needs
   isLogEntryLate(), defined just below.
========================================================================== */
function setupEmailLateListButton() {
    const btn = document.getElementById("btn-email-late-list");
    if (!btn) return;

    btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
            const startOfToday = new Date();
            startOfToday.setHours(0, 0, 0, 0);
            const todayQuery = query(attendanceRootRef, orderByChild("timestamp"), startAt(startOfToday.getTime()));

            const snapshot = await get(todayQuery);
            const logs = Object.values(snapshot.val() || {});

            const firstInByStudent = {};
            logs
                .filter((log) => log.direction === "in")
                .sort((a, b) => a.timestamp - b.timestamp)
                .forEach((log) => {
                    if (!firstInByStudent[log.studentId]) firstInByStudent[log.studentId] = log;
                });

            const lateEntries = Object.values(firstInByStudent).filter((log) => isLogEntryLate(log.timestamp));

            if (lateEntries.length === 0) {
                alert("No late check-ins recorded today \u2014 nothing to email.");
                return;
            }

            lateEntries.sort((a, b) => a.timestamp - b.timestamp);

            const todayLabel = new Date().toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" });
            const lines = lateEntries.map((log) => {
                const student = studentsState[log.studentId];
                const section = student ? sectionsState[student.sectionId] : null;
                const name = student ? studentFullName(student) : "Unknown student";
                const sectionLabel = section ? `${section.gradeName || "--"} - ${section.name}` : "No section on file";
                return `- ${name} (${sectionLabel}) \u2014 checked in ${formatLogTime(log.timestamp)}`;
            });

            const subject = `Late Students Report \u2014 ${todayLabel}`;
            const body = `The following ${lateEntries.length} student(s) checked in after 7:15 AM on ${todayLabel}:\n\n${lines.join("\n")}\n\n\u2014 Sent from RescuePriority`;

            window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        } catch (error) {
            console.error("Failed to build late list email:", error);
            alert("Couldn't pull today's attendance. Check your connection and try again.");
        } finally {
            btn.disabled = false;
        }
    });
}

let rosterSectionId = null;
let rosterUnsubscribe = null;
let rosterPresentMap = {};
let rosterLogsByStudent = {};
let rosterSearchTerm = "";

let studentDetailId = null;
let studentDetailTab = "overview";

/* Same cutoff as kiosk.js — a student is "late" if their first "in" scan
   today happened after 7:15 AM. Duplicated locally (rather than shared)
   to keep this file's only dependency on scan data the attendanceRootRef
   pointer already declared above, matching this project's convention of
   small self-contained additive modules. */
const LATE_CUTOFF_MINUTES = 7 * 60 + 15;

function isLogEntryLate(timestamp) {
    const d = new Date(timestamp);
    return (d.getHours() * 60 + d.getMinutes()) > LATE_CUTOFF_MINUTES;
}

function setupSectionRosterView() {
    const backButton = document.getElementById("btn-back-to-sections");
    if (backButton) backButton.addEventListener("click", closeSectionRosterView);

    const searchInput = document.getElementById("section-roster-search-input");
    if (searchInput) {
        searchInput.addEventListener("input", () => {
            rosterSearchTerm = searchInput.value.trim().toLowerCase();
            renderSectionRoster();
        });
    }
}

function openSectionRosterView(sectionId) {
    const section = sectionsState[sectionId];
    if (!section) return;

    rosterSectionId = sectionId;
    rosterSearchTerm = "";
    const searchInput = document.getElementById("section-roster-search-input");
    if (searchInput) searchInput.value = "";

    const view = document.getElementById("section-roster-view");
    const title = document.getElementById("section-roster-title");
    const subtitle = document.getElementById("section-roster-subtitle");
    const facility = SCHOOL_FACILITIES.find((f) => f.id === section.facilityId);

    if (title) title.textContent = section.name;
    if (subtitle) {
        subtitle.textContent = `${section.gradeName || "--"} \u00b7 ${facility ? displayFacilityName(facility.name) : "Not linked"} \u00b7 ${section.assignedTeacherId || "Unassigned adviser"}`;
    }

    // Draw rows immediately so the table isn't empty while the presence
    // query resolves; status dots fill in (and then stay live) once it does.
    renderSectionRoster();
    if (view) view.classList.remove("hidden");
    document.body.classList.add("rp-fullscreen-open"); // locks page scroll behind the full-screen view

    if (rosterUnsubscribe) {
        rosterUnsubscribe();
        rosterUnsubscribe = null;
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayQuery = query(attendanceRootRef, orderByChild("timestamp"), startAt(startOfToday.getTime()));

    rosterUnsubscribe = onValue(todayQuery, (snapshot) => {
        const logs = snapshot.val() || {};

        // Group every log today by student (oldest -> newest) so the
        // student detail modal can show the full in/out timeline, not
        // just the latest scan.
        const logsByStudent = {};
        Object.values(logs).forEach((log) => {
            if (!logsByStudent[log.studentId]) logsByStudent[log.studentId] = [];
            logsByStudent[log.studentId].push(log);
        });
        Object.values(logsByStudent).forEach((entries) => entries.sort((a, b) => a.timestamp - b.timestamp));

        // Latest log per studentId today -> direction "in" means present.
        // Mirrors scan-attendance.js's setupLiveStats() reduction exactly.
        const presentMap = {};
        Object.entries(logsByStudent).forEach(([studentId, entries]) => {
            const latest = entries[entries.length - 1];
            presentMap[studentId] = latest.direction === "in";
        });

        rosterLogsByStudent = logsByStudent;
        rosterPresentMap = presentMap;
        renderSectionRoster();

        if (studentDetailId) renderStudentDetailModal(); // keep an open detail modal live too
    });
}

function closeSectionRosterView() {
    const view = document.getElementById("section-roster-view");
    if (view) view.classList.add("hidden");
    document.body.classList.remove("rp-fullscreen-open");

    if (rosterUnsubscribe) {
        rosterUnsubscribe(); // detach the presence listener — view is closed, no need to keep it live
        rosterUnsubscribe = null;
    }
    rosterSectionId = null;
    rosterPresentMap = {};
    rosterLogsByStudent = {};
    closeStudentDetailModal();
}

function renderSectionRoster() {
    const tbody = document.getElementById("section-roster-table-body");
    const emptyState = document.getElementById("section-roster-empty");
    const countEl = document.getElementById("section-roster-count");
    if (!tbody || !rosterSectionId) return;

    const rows = Object.entries(studentsState)
        .filter(([, student]) => student.sectionId === rosterSectionId)
        .map(([id, student]) => ({ id, ...student }))
        .filter((student) => {
            if (!rosterSearchTerm) return true;
            const haystack = `${studentFullName(student)} ${student.lrn}`.toLowerCase();
            return haystack.includes(rosterSearchTerm);
        })
        .sort((a, b) => studentFullName(a).localeCompare(studentFullName(b)));

    if (countEl) countEl.textContent = `${rows.length} student${rows.length === 1 ? "" : "s"}`;

    tbody.innerHTML = "";

    if (rows.length === 0) {
        if (emptyState) emptyState.classList.remove("hidden");
        return;
    }
    if (emptyState) emptyState.classList.add("hidden");

    rows.forEach((student) => {
        const isPresent = !!rosterPresentMap[student.id];
        const entries = rosterLogsByStudent[student.id] || [];
        const firstIn = entries.find((log) => log.direction === "in");
        const isLate = firstIn ? isLogEntryLate(firstIn.timestamp) : false;
        const violationCount = (violationsState[student.id] || []).length;
        const studentIncidentCount = incidentsCache.filter((i) => i.studentId === student.id).length;

        const initials = studentInitials(student);
        const avatarHtml = student.photoUrl
            ? `<img src="${escapeHtml(student.photoUrl)}" alt="" class="student-row-avatar" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'student-row-avatar student-row-avatar-fallback',textContent:'${initials}'}))">`
            : `<span class="student-row-avatar student-row-avatar-fallback">${initials}</span>`;

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><div class="student-row-name">${avatarHtml}<span>${escapeHtml(studentFullName(student))}</span></div></td>
            <td><span class="pill-tag">${escapeHtml(student.lrn || "--")}</span></td>
            <td>
                <span class="roster-status-cell">
                    <span class="status-dot ${isPresent ? "status-dot-present" : "status-dot-absent"}" title="${isPresent ? "Checked in" : "Not checked in"}"></span>
                    ${isPresent ? "Checked in" : "Not checked in"}
                </span>
            </td>
            <td>${firstIn ? `<span class="section-detail-late-tag ${isLate ? "is-late" : "is-ontime"}">${isLate ? "Late" : "On time"}</span>` : "--"}</td>
            <td>${violationCount}</td>
            <td>${studentIncidentCount}</td>
            <td>${entries.length ? describeLog(entries[entries.length - 1]) : "No scans today"}</td>
            <td>
                <div class="table-row-actions">
                    <button type="button" class="icon-btn btn-primary-action btn-view-student-detail" data-id="${student.id}">View</button>
                    <button type="button" class="icon-btn btn-view-qr" data-id="${student.id}">QR</button>
                    <button type="button" class="icon-btn btn-edit-student" data-id="${student.id}">Edit</button>
                    <button type="button" class="icon-btn icon-btn-danger btn-delete-student" data-id="${student.id}">Delete</button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".btn-view-student-detail").forEach((btn) => {
        btn.addEventListener("click", () => openStudentDetailModal(btn.dataset.id));
    });
    tbody.querySelectorAll(".btn-view-qr").forEach((btn) => {
        btn.addEventListener("click", () => openQrModal(btn.dataset.id));
    });
    tbody.querySelectorAll(".btn-edit-student").forEach((btn) => {
        btn.addEventListener("click", () => openStudentModal(btn.dataset.id));
    });
    tbody.querySelectorAll(".btn-delete-student").forEach((btn) => {
        btn.addEventListener("click", () => deleteStudent(btn.dataset.id));
    });
}

/* ==========================================================================
   STUDENT DETAIL MODAL (Overview / Violations / Incidents / Timeline tabs)
   --------------------------------------------------------------------------
   Opened via the Section Roster's "View" button. Reuses the same tab
   renderers (renderTabButton / renderTabPanelContent, below) that used to
   live inside the old accordion-in-a-modal Section Detail view.
========================================================================== */
function setupStudentDetailModal() {
    const modal = document.getElementById("student-detail-modal");
    const closeBtn = document.getElementById("student-detail-modal-close");

    if (closeBtn) closeBtn.addEventListener("click", closeStudentDetailModal);
    if (modal) {
        modal.addEventListener("click", (event) => {
            if (event.target === modal) closeStudentDetailModal();
        });
    }
}

function openStudentDetailModal(studentId) {
    const student = studentsState[studentId];
    if (!student) return;

    studentDetailId = studentId;
    studentDetailTab = "overview";

    const modal = document.getElementById("student-detail-modal");
    if (modal) modal.classList.remove("hidden");

    renderStudentDetailModal();
}

function closeStudentDetailModal() {
    const modal = document.getElementById("student-detail-modal");
    if (modal) modal.classList.add("hidden");
    studentDetailId = null;
}

function renderStudentDetailModal() {
    if (!studentDetailId) return;
    const student = studentsState[studentDetailId];
    if (!student) {
        closeStudentDetailModal();
        return;
    }

    const titleEl = document.getElementById("student-detail-title");
    const subtitleEl = document.getElementById("student-detail-subtitle");
    const section = sectionsState[student.sectionId];

    if (titleEl) titleEl.textContent = studentFullName(student);
    if (subtitleEl) {
        subtitleEl.textContent = section ? `${section.gradeName || "--"} \u00b7 ${section.name}` : "No section on file";
    }

    // Timeline data comes from the roster view's live listener (the only
    // entry point to this modal), so it's already in sync for this student.
    const entries = rosterSectionId === student.sectionId ? (rosterLogsByStudent[studentDetailId] || []) : [];
    const firstIn = entries.find((log) => log.direction === "in");
    const isLate = firstIn ? isLogEntryLate(firstIn.timestamp) : false;
    const violationCount = (violationsState[studentDetailId] || []).length;
    const studentIncidents = incidentsCache.filter((i) => i.studentId === studentDetailId);

    const tabsEl = document.getElementById("student-detail-tabs");
    const panelEl = document.getElementById("student-detail-tab-panel");

    if (tabsEl) {
        tabsEl.innerHTML = `
            ${renderTabButton("overview", "Overview", null, studentDetailTab)}
            ${renderTabButton("violations", "Violations", violationCount, studentDetailTab)}
            ${renderTabButton("incidents", "Incidents", studentIncidents.length, studentDetailTab)}
            ${renderTabButton("timeline", "Timeline", entries.length, studentDetailTab)}
        `;
        tabsEl.querySelectorAll(".section-detail-tab").forEach((tabBtn) => {
            tabBtn.addEventListener("click", () => {
                studentDetailTab = tabBtn.dataset.tab;
                renderStudentDetailModal();
            });
        });
    }

    if (panelEl) {
        panelEl.innerHTML = renderTabPanelContent(studentDetailTab, { student, firstIn, isLate, violationCount, studentIncidents, entries });
    }
}

function renderTabButton(tabId, label, count, activeTab) {
    const hasCount = typeof count === "number";
    return `
        <button type="button" class="section-detail-tab ${activeTab === tabId ? "active" : ""}" data-tab="${tabId}">
            ${label}${hasCount ? ` <span class="tab-count">${count}</span>` : ""}
        </button>
    `;
}

function renderTabPanelContent(activeTab, data) {
    const { student, firstIn, isLate, violationCount, studentIncidents, entries } = data;

    if (activeTab === "violations") {
        if (!violationCount) return '<p class="section-detail-history-empty">No violations logged for this student.</p>';
        return violationsState[student.id].slice().reverse().map(renderViolationRow).join("");
    }

    if (activeTab === "incidents") {
        if (!studentIncidents.length) return '<p class="section-detail-history-empty">No incidents on record for this student.</p>';
        return studentIncidents.slice().reverse().map(renderIncidentRow).join("");
    }

    if (activeTab === "timeline") {
        if (!entries.length) return '<p class="section-detail-history-empty">No check-ins or check-outs logged today.</p>';
        return entries.map(renderHistoryRow).reverse().join("");
    }

    // "overview" (default)
    return `
        <div class="section-detail-profile-grid">
            <p><strong>LRN:</strong> ${escapeHtml(student.lrn || "--")}</p>
            <p><strong>Grade &amp; Section:</strong> ${escapeHtml((sectionsState[student.sectionId] || {}).name || "--")}</p>
            <p><strong>Parent Mobile:</strong> ${escapeHtml(student.parentMobileNo || "--")}</p>
            <p><strong>Parent Email:</strong> ${escapeHtml(student.parentEmail || "--")}</p>
            <p><strong>Check-in Today:</strong> ${firstIn ? `${formatLogTime(firstIn.timestamp)} ${isLate ? "(Late)" : "(On time)"}` : "Not checked in yet"}</p>
            <p><strong>Violations:</strong> ${violationCount} logged</p>
            <p><strong>Incidents Involved:</strong> ${studentIncidents.length} on record</p>
        </div>
    `;
}

function renderViolationRow(record) {
    return `
        <div class="section-detail-history-item is-violation">
            <span class="section-detail-history-dot"></span>
            <span class="section-detail-history-label">${escapeHtml(record.type)} \u2014 ${ordinalOffense(record.offenseCount)}</span>
            <span class="section-detail-history-time">${formatLogTime(record.timestamp)}</span>
        </div>
    `;
}

function renderIncidentRow(incident) {
    const label = incident.roomWide
        ? `Room-wide: ${incident.incidentType || "Emergency"}`
        : (incident.incidentType || "Reported emergency");
    return `
        <div class="section-detail-history-item ${incident.status === "Resolved" ? "is-resolved" : "is-active"}">
            <span class="section-detail-history-dot"></span>
            <span class="section-detail-history-label">${escapeHtml(label)} \u00b7 ${escapeHtml(incident.status || "--")}</span>
            <span class="section-detail-history-time">${formatLogTime(incident.timestamp)}</span>
        </div>
    `;
}

function ordinalOffense(n) {
    if (n === 1) return "1st Offense";
    if (n === 2) return "2nd Offense";
    if (n === 3) return "3rd Offense";
    return `${n}th Offense`;
}

function renderHistoryRow(log) {
    const isOut = log.direction === "out";
    return `
        <div class="section-detail-history-item ${isOut ? "is-out" : "is-in"}">
            <span class="section-detail-history-dot"></span>
            <span class="section-detail-history-label">${isOut ? "Checked OUT" : "Checked IN"}</span>
            <span class="section-detail-history-time">${formatLogTime(log.timestamp)}</span>
        </div>
    `;
}

function describeLog(log) {
    return `${log.direction === "out" ? "Out" : "In"} \u00b7 ${formatLogTime(log.timestamp)}`;
}

function formatLogTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/* ==========================================================================
   QR MODAL (LRN-only payload, matches astig's StudentQrModal.tsx approach —
   ported to plain JS + the qrcode UMD build instead of npm/React)
========================================================================== */
function setupQrModal() {
    const modal = document.getElementById("student-qr-modal");
    const closeBtn = document.getElementById("qr-modal-close");
    const downloadBtn = document.getElementById("btn-qr-download");

    if (closeBtn) closeBtn.addEventListener("click", closeQrModal);
    if (modal) {
        modal.addEventListener("click", (event) => {
            if (event.target === modal) closeQrModal();
        });
    }
    if (downloadBtn) downloadBtn.addEventListener("click", downloadCurrentQr);
}

let currentQrDataUrl = null;
let currentQrStudent = null;

async function openQrModal(studentId) {
    const student = studentsState[studentId];
    if (!student) return;

    currentQrStudent = student;
    currentQrDataUrl = null;

    document.getElementById("qr-modal-student-name").textContent = studentFullName(student);
    document.getElementById("qr-modal-student-lrn").textContent = `LRN: ${student.lrn}`;

    const frame = document.getElementById("qr-canvas-frame");
    frame.innerHTML = '<p class="qr-status-text">Generating QR code...</p>';

    document.getElementById("student-qr-modal").classList.remove("hidden");

    if (typeof window.QRCode === "undefined") {
        frame.innerHTML = '<p class="qr-status-text">QR library failed to load.</p>';
        return;
    }

    try {
        const canvas = document.createElement("canvas");
        await window.QRCode.toCanvas(canvas, student.lrn, {
            width: 500,
            margin: 2,
            errorCorrectionLevel: "H"
        });

        // qrcode's toCanvas() sets its own inline width/height style on the
        // canvas (to keep it crisp at the pixel size it just drew), which
        // beats the .qr-canvas-frame canvas rule in students.css since
        // inline styles win over stylesheets. Clear that inline sizing so
        // the stylesheet's 240x240 display size (the actual 500x500 canvas
        // stays intentionally full-res for the downloaded file) takes over.
        canvas.style.width = "";
        canvas.style.height = "";

        frame.innerHTML = "";
        frame.appendChild(canvas);
        currentQrDataUrl = canvas.toDataURL("image/jpeg", 0.95);
    } catch (error) {
        console.error("Failed to generate student QR code:", error);
        frame.innerHTML = '<p class="qr-status-text">Unable to generate the QR code.</p>';
    }
}

function closeQrModal() {
    document.getElementById("student-qr-modal").classList.add("hidden");
    currentQrDataUrl = null;
    currentQrStudent = null;
}

function downloadCurrentQr() {
    if (!currentQrDataUrl || !currentQrStudent) return;

    const namePart = [currentQrStudent.firstName, currentQrStudent.middleName, currentQrStudent.lastName, currentQrStudent.extension]
        .filter((v) => v && String(v).trim())
        .map((v) => String(v).trim().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-]/g, ""))
        .join("-");

    const link = document.createElement("a");
    link.href = currentQrDataUrl;
    link.download = `${namePart || currentQrStudent.lrn}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/* ==========================================================================
   UTIL
========================================================================== */
function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
