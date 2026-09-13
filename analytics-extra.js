/* ==========================================================================
   RESCUEPRIORITY — ANALYTICS EXTRAS
   --------------------------------------------------------------------------
   Adds the analytics the redesign asked for that the original Analytics
   tab didn't cover: Grade-Level Risk Distribution, Violation Category
   Breakdown, Offense Escalation Pattern, and Repeat Offender Analysis.
   Deliberately mirrors insights.js's approach (own onValue listeners
   rather than relying on another module's live-bound export staying in
   sync) — this file owns its own read of /incidents and /violations.
========================================================================== */

import { database, SCHOOL_FACILITIES } from "./script.js";
import { studentsState, sectionsState } from "./students.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const incidentsRootRef = ref(database, "incidents");
const violationsRootRef = ref(database, "violations");

let incidentsCache = [];
let violationsCache = {}; // studentId -> [{ type, offenseCount, timestamp }, ...]

const GRADE_ORDER = ["Grade 7", "Grade 8", "Grade 9", "Grade 10", "Grade 11", "Grade 12"];

const charts = { gradeRisk: null, violationCategories: null, escalation: null };
let chartsBuilt = false;

document.addEventListener("DOMContentLoaded", () => {
    onValue(incidentsRootRef, (snapshot) => {
        const data = snapshot.val() || {};
        incidentsCache = Object.keys(data).map((key) => ({ key, ...data[key] }));
        renderAll();
    }, (error) => console.error("[analytics-extra incidents listener] Firebase read failed:", error.code, error.message));

    onValue(violationsRootRef, (snapshot) => {
        const data = snapshot.val() || {};
        const next = {};
        Object.entries(data).forEach(([studentId, records]) => {
            next[studentId] = Object.values(records || {});
        });
        violationsCache = next;
        renderAll();
    }, (error) => console.error("[analytics-extra violations listener] Firebase read failed:", error.code, error.message));

    window.addEventListener("rp:analytics-view-activated", renderAll);
});

function themeColor(varName, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return value || fallback;
}

function isAnalyticsViewVisible() {
    const view = document.getElementById("analytics-view");
    return !!view && !view.classList.contains("hidden");
}

function toggleEmptyNote(id, isEmpty) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", !isEmpty);
}

function studentFullName(student) {
    return [student.firstName, student.middleName, student.lastName, student.extension].filter((v) => v && String(v).trim()).join(" ");
}

function normalizeGradeName(gradeName) {
    return (gradeName || "").trim() || "Ungrouped";
}

/* ==========================================================================
   GRADE-LEVEL RISK DISTRIBUTION
========================================================================== */
function buildGradeRiskSeries() {
    const totals = {};
    Object.entries(sectionsState).forEach(([sectionId, section]) => {
        const grade = normalizeGradeName(section.gradeName);
        if (!totals[grade]) totals[grade] = { violations: 0, incidents: 0 };

        const facility = SCHOOL_FACILITIES.find((f) => f.id === section.facilityId);
        const rosterIds = Object.entries(studentsState).filter(([, s]) => s.sectionId === sectionId).map(([id]) => id);

        totals[grade].violations += rosterIds.reduce((sum, id) => sum + (violationsCache[id] || []).length, 0);
        totals[grade].incidents += facility ? incidentsCache.filter((inc) => inc.classroom === facility.name).length : 0;
    });

    const labels = Object.keys(totals).sort(
        (a, b) => GRADE_ORDER.indexOf(a) - GRADE_ORDER.indexOf(b) || a.localeCompare(b)
    );

    return {
        labels,
        violations: labels.map((g) => totals[g].violations),
        incidents: labels.map((g) => totals[g].incidents)
    };
}

/* ==========================================================================
   VIOLATION CATEGORY BREAKDOWN
========================================================================== */
function buildViolationCategorySeries() {
    const counts = {};
    Object.values(violationsCache).forEach((records) => {
        records.forEach((record) => {
            const type = record.type || "Uncategorized";
            counts[type] = (counts[type] || 0) + 1;
        });
    });

    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { labels: entries.map((e) => e[0]), data: entries.map((e) => e[1]) };
}

/* ==========================================================================
   OFFENSE ESCALATION PATTERN
   How many distinct students have reached at least their 1st, 2nd, 3rd,
   and 4th-or-later violation — a funnel showing how often minor cases
   turn into repeat/escalated ones.
========================================================================== */
function buildEscalationSeries() {
    const buckets = [0, 0, 0, 0]; // 1st, 2nd, 3rd, 4th+
    Object.values(violationsCache).forEach((records) => {
        const maxOffense = records.reduce((max, r) => Math.max(max, r.offenseCount || 1), 0);
        if (maxOffense >= 1) buckets[0] += 1;
        if (maxOffense >= 2) buckets[1] += 1;
        if (maxOffense >= 3) buckets[2] += 1;
        if (maxOffense >= 4) buckets[3] += 1;
    });
    return {
        labels: ["Reached 1st Offense", "Escalated to 2nd", "Escalated to 3rd", "Escalated to 4th+"],
        data: buckets
    };
}

/* ==========================================================================
   REPEAT OFFENDER ANALYSIS (ranked list, not a chart)
========================================================================== */
function renderRepeatOffenders() {
    const list = document.getElementById("repeat-offender-list");
    if (!list) return;

    const rows = Object.entries(studentsState).map(([studentId, student]) => {
        const violationCount = (violationsCache[studentId] || []).length;
        const incidentCount = incidentsCache.filter((inc) => inc.studentId === studentId).length;
        return { studentId, student, violationCount, incidentCount, total: violationCount + incidentCount };
    }).filter((row) => row.total > 0).sort((a, b) => b.total - a.total).slice(0, 8);

    toggleEmptyNote("repeat-offender-empty", rows.length === 0);
    list.innerHTML = "";

    rows.forEach((row, i) => {
        const section = sectionsState[row.student.sectionId];
        const el = document.createElement("div");
        el.className = "section-folder-row";
        el.innerHTML = `
            <span class="section-folder-rank">#${i + 1}</span>
            <span class="section-folder-icon">&#128100;</span>
            <span class="section-folder-info">
                <span class="section-folder-name">${escapeHtml(studentFullName(row.student))}</span>
                <span class="section-folder-sub">${section ? `${escapeHtml(section.gradeName || "--")} \u2013 ${escapeHtml(section.name)}` : "No section on file"}</span>
            </span>
            <span class="section-folder-stats">
                <span class="section-folder-stat">${row.incidentCount} incident${row.incidentCount === 1 ? "" : "s"}</span>
                <span class="section-folder-stat">${row.violationCount} violation${row.violationCount === 1 ? "" : "s"}</span>
            </span>
        `;
        list.appendChild(el);
    });
}

function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
}

/* ==========================================================================
   RENDER — charts + list together
========================================================================== */
function renderAll() {
    renderRepeatOffenders();

    if (typeof Chart === "undefined") return;
    if (!chartsBuilt && !isAnalyticsViewVisible()) return;

    const pink = themeColor("--accent-pink", "#FF66C4");
    const pinkDark = themeColor("--accent-pink-dark", "#C2368F");
    const mauve = themeColor("--accent-mauve", "#8C4870");
    const emergency = themeColor("--status-emergency", "#D92D20");
    const warning = themeColor("--status-warning", "#A6720C");
    const textSecondary = themeColor("--text-secondary", "#555");

    const gradeRisk = buildGradeRiskSeries();
    const violationCategories = buildViolationCategorySeries();
    const escalation = buildEscalationSeries();

    toggleEmptyNote("chart-grade-risk-empty", gradeRisk.labels.length === 0);
    toggleEmptyNote("chart-violation-categories-empty", violationCategories.labels.length === 0);
    toggleEmptyNote("chart-escalation-empty", escalation.data.every((v) => v === 0));

    const commonScales = {
        x: { grid: { display: false }, ticks: { color: textSecondary } },
        y: { beginAtZero: true, ticks: { precision: 0, color: textSecondary }, grid: { color: "rgba(0,0,0,0.05)" } }
    };

    if (!chartsBuilt) {
        ["chart-grade-risk", "chart-violation-categories", "chart-escalation"].forEach((id) => {
            const canvas = document.getElementById(id);
            const existing = canvas && Chart.getChart(canvas);
            if (existing) existing.destroy();
        });

        charts.gradeRisk = new Chart(document.getElementById("chart-grade-risk"), {
            type: "bar",
            data: {
                labels: gradeRisk.labels,
                datasets: [
                    { label: "Incidents", data: gradeRisk.incidents, backgroundColor: pinkDark, borderRadius: 4 },
                    { label: "Violations", data: gradeRisk.violations, backgroundColor: mauve, borderRadius: 4 }
                ]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: "bottom" } }, scales: commonScales }
        });

        charts.violationCategories = new Chart(document.getElementById("chart-violation-categories"), {
            type: "bar",
            data: {
                labels: violationCategories.labels,
                datasets: [{ label: "Occurrences", data: violationCategories.data, backgroundColor: pink, borderRadius: 4 }]
            },
            options: { responsive: true, maintainAspectRatio: false, indexAxis: "y", plugins: { legend: { display: false } }, scales: commonScales }
        });

        charts.escalation = new Chart(document.getElementById("chart-escalation"), {
            type: "bar",
            data: {
                labels: escalation.labels,
                datasets: [{
                    label: "Students",
                    data: escalation.data,
                    backgroundColor: [pink, warning, warning, emergency],
                    borderRadius: 4
                }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: commonScales }
        });

        chartsBuilt = true;
    } else {
        charts.gradeRisk.data.labels = gradeRisk.labels;
        charts.gradeRisk.data.datasets[0].data = gradeRisk.incidents;
        charts.gradeRisk.data.datasets[1].data = gradeRisk.violations;
        charts.gradeRisk.update();

        charts.violationCategories.data.labels = violationCategories.labels;
        charts.violationCategories.data.datasets[0].data = violationCategories.data;
        charts.violationCategories.update();

        charts.escalation.data.labels = escalation.labels;
        charts.escalation.data.datasets[0].data = escalation.data;
        charts.escalation.update();
    }
}
