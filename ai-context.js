/* ==========================================================================
   RESCUEPRIORITY — AI CONTEXT LAYER
   ----------------------------------------------------------------------
   Read-only data layer for the AI Assistant. Follows the same pattern
   insights.js already uses: reuses the existing `database` instance from
   script.js (no second Firebase app), but keeps its OWN dedicated onValue()
   listeners on /classrooms and /incidents rather than trusting a
   cross-module live binding (insights.js's own comment explains why that
   proved unreliable). This file never writes to Firebase — it cannot
   affect emergency records, classroom state, or incident history.

   Exports buildAIContext(), which packages a compact snapshot of current
   RescuePriority data for the AI backend to reason over. ai-assistant.js
   imports this and sends the result alongside each question.
========================================================================== */

import { database, SCHOOL_FACILITIES, isClassroomFacility, displayFacilityName } from "./script.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const classroomsRootRef = ref(database, "classrooms");
const incidentsRootRef = ref(database, "incidents");
const studentsRootRef = ref(database, "students");
const violationsRootRef = ref(database, "violations");

// classroomsState[facilityId] = { emergency: bool, activeIncidentKey: string|null }
let classroomsState = {};
let incidents = [];
let studentsState = {};
let violationsState = {};

function setupContextListeners() {
    onValue(
        classroomsRootRef,
        (snapshot) => { classroomsState = snapshot.val() || {}; },
        (error) => console.error("[ai-context] classrooms read failed:", error.code, error.message)
    );

    onValue(
        incidentsRootRef,
        (snapshot) => {
            const data = snapshot.val() || {};
            incidents = Object.keys(data).map(key => ({ key, ...data[key] }));
        },
        (error) => console.error("[ai-context] incidents read failed:", error.code, error.message)
    );

    onValue(
        studentsRootRef,
        (snapshot) => { studentsState = snapshot.val() || {}; },
        (error) => console.error("[ai-context] students read failed:", error.code, error.message)
    );

    onValue(
        violationsRootRef,
        (snapshot) => { violationsState = snapshot.val() || {}; },
        (error) => console.error("[ai-context] violations read failed:", error.code, error.message)
    );
}
setupContextListeners();

/* ==========================================================================
   DATA ROBUSTNESS (mirrors insights.js — never throws on a bad record)
========================================================================== */
function getValidIncidents() {
    if (!Array.isArray(incidents)) return [];
    return incidents.filter(inc => {
        if (!inc || typeof inc !== "object") return false;
        if (inc.isTestData) return false;
        const studentName = String(inc.studentName || "").trim().toLowerCase();
        const incidentType = String(inc.incidentType || "").trim().toLowerCase();
        if (/^(test|dummy)|test dummy|automated latency/.test(studentName)) return false;
        if (incidentType === "latency test" || incidentType === "facilities test") return false;
        const ts = Number(inc.timestamp);
        return Number.isFinite(ts) && ts > 0;
    });
}

function studentNameFromRecord(studentId, fallbackName) {
    const student = studentId ? studentsState[studentId] : null;
    if (student) {
        const fullName = [student.firstName, student.middleName, student.lastName]
            .filter(Boolean)
            .map(value => String(value).trim())
            .filter(Boolean)
            .join(" ");
        if (fullName) return fullName;
    }
    return fallbackName ? String(fallbackName).trim() : "Unknown student";
}

function safeClassroomName(inc) {
    return (inc.classroom && String(inc.classroom).trim()) || "Unknown";
}

function safeStatus(inc) {
    return inc.status === "Active" || inc.status === "Resolved" ? inc.status : "Unknown";
}

const CLASSROOM_NAMES = new Set(
    SCHOOL_FACILITIES.filter(isClassroomFacility).map(f => f.name)
);
function isClassroomIncident(inc) {
    return CLASSROOM_NAMES.has(safeClassroomName(inc));
}

/* ==========================================================================
   CONTEXT BUILDERS
========================================================================== */

// Facilities currently flagged emergency=true in /classrooms, with the
// zone/section/adviser info the AI needs to answer "which classrooms are
// in emergency right now" without inventing anything.
export function getActiveEmergencies() {
    return SCHOOL_FACILITIES
        .filter(f => classroomsState[f.id] && classroomsState[f.id].emergency)
        .map(f => ({
            name: displayFacilityName(f.name),
            zone: f.zone,
            section: f.section,
            adviser: f.adviser || null
        }));
}

// Most recent incidents (any status), newest first.
export function getRecentIncidents(limit = 10) {
    return getValidIncidents()
        .slice()
        .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
        .slice(0, limit)
        .map(inc => ({
            incidentNumber: inc.incidentNumber || null,
            classroom: displayFacilityName(safeClassroomName(inc)),
            studentName: studentNameFromRecord(inc.studentId, inc.studentName),
            incidentType: inc.incidentType || "Unspecified",
            status: safeStatus(inc),
            timestamp: Number(inc.timestamp),
            resolvedAt: Number.isFinite(Number(inc.resolvedAt)) ? Number(inc.resolvedAt) : null
        }));
}

// Overall counts — same definitions insights.js uses for its KPI row, so
// the AI's numbers always match what's on screen.
export function getIncidentStatistics() {
    const valid = getValidIncidents();
    const total = valid.length;
    const active = valid.filter(inc => safeStatus(inc) === "Active").length;
    const resolved = valid.filter(inc => safeStatus(inc) === "Resolved").length;
    return { total, active, resolved };
}

// Top classrooms/areas by incident count, both by individual classroom and
// rolled up by zone/wing — this is what lets the AI answer "which area has
// the most incidents" (zone-level) as well as "which classroom" (room-level).
export function getTopClassrooms(limit = 5) {
    const valid = getValidIncidents().filter(isClassroomIncident);

    const byClassroom = new Map();
    const byZone = new Map();

    valid.forEach(inc => {
        const name = displayFacilityName(safeClassroomName(inc));
        byClassroom.set(name, (byClassroom.get(name) || 0) + 1);

        const facility = SCHOOL_FACILITIES.find(f => f.name === safeClassroomName(inc));
        const zone = facility ? facility.zone : "Unknown";
        byZone.set(zone, (byZone.get(zone) || 0) + 1);
    });

    const topClassrooms = [...byClassroom.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([name, count]) => ({ name, count }));

    const topZones = [...byZone.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([zone, count]) => ({ zone, count }));

    return { topClassrooms, topZones };
}

// Student-level aggregation is calculated before the model is called. This
// gives the assistant exact rankings instead of asking an LLM to count rows.
export function getStudentIncidentStatistics(limit = 10) {
    const byStudent = new Map();

    getValidIncidents().forEach(inc => {
        if (!inc.studentId && !inc.studentName) return;
        const key = inc.studentId || `name:${String(inc.studentName).trim().toLowerCase()}`;
        if (!byStudent.has(key)) {
            byStudent.set(key, {
                studentId: inc.studentId || null,
                name: studentNameFromRecord(inc.studentId, inc.studentName),
                incidentCount: 0,
                activeCount: 0,
                resolvedCount: 0,
                lastIncidentAt: 0,
                classrooms: new Set(),
                incidentTypes: new Map()
            });
        }

        const row = byStudent.get(key);
        row.incidentCount += 1;
        if (safeStatus(inc) === "Active") row.activeCount += 1;
        if (safeStatus(inc) === "Resolved") row.resolvedCount += 1;
        row.lastIncidentAt = Math.max(row.lastIncidentAt, Number(inc.timestamp));
        row.classrooms.add(displayFacilityName(safeClassroomName(inc)));
        const type = inc.incidentType || "Unspecified";
        row.incidentTypes.set(type, (row.incidentTypes.get(type) || 0) + 1);
    });

    const ranked = [...byStudent.values()]
        .sort((a, b) => b.incidentCount - a.incidentCount || b.lastIncidentAt - a.lastIncidentAt)
        .slice(0, limit)
        .map(row => ({
            studentId: row.studentId,
            name: row.name,
            incidentCount: row.incidentCount,
            activeCount: row.activeCount,
            resolvedCount: row.resolvedCount,
            lastIncidentAt: row.lastIncidentAt,
            classrooms: [...row.classrooms].slice(0, 3),
            topIncidentTypes: [...row.incidentTypes.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([type, count]) => ({ type, count }))
        }));

    return { studentsWithIncidents: byStudent.size, topStudents: ranked };
}

export function getIncidentTypeStatistics(limit = 8) {
    const counts = new Map();
    getValidIncidents().forEach(inc => {
        const type = inc.incidentType || "Unspecified";
        counts.set(type, (counts.get(type) || 0) + 1);
    });
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([type, count]) => ({ type, count }));
}

export function getViolationStatistics(limit = 8) {
    const typeCounts = new Map();
    const studentRows = [];
    let total = 0;

    Object.entries(violationsState || {}).forEach(([studentId, records]) => {
        const list = Object.values(records || {}).filter(record => record && typeof record === "object");
        total += list.length;
        list.forEach(record => {
            const type = record.type || "Unspecified";
            typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
        });
        if (list.length) {
            studentRows.push({
                studentId,
                name: studentNameFromRecord(studentId, null),
                violationCount: list.length,
                latestViolationAt: Math.max(...list.map(record => Number(record.timestamp) || 0))
            });
        }
    });

    return {
        total,
        topViolationTypes: [...typeCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([type, count]) => ({ type, count })),
        topStudents: studentRows
            .sort((a, b) => b.violationCount - a.violationCount || b.latestViolationAt - a.latestViolationAt)
            .slice(0, limit)
    };
}

export function getDailyIncidentTrend(days = 30) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
    const counts = new Map();

    for (let offset = 0; offset < days; offset += 1) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
        counts.set(date.toISOString().slice(0, 10), 0);
    }

    getValidIncidents().forEach(inc => {
        const key = new Date(Number(inc.timestamp)).toISOString().slice(0, 10);
        if (counts.has(key)) counts.set(key, counts.get(key) + 1);
    });

    return [...counts.entries()].map(([date, count]) => ({ date, count }));
}

// Average resolution time + how many resolved incidents that average is
// based on, so the AI can say "not enough data" instead of guessing.
export function getResolutionStatistics() {
    const durations = getValidIncidents()
        .filter(inc => safeStatus(inc) === "Resolved" && Number.isFinite(Number(inc.resolvedAt)) && Number(inc.resolvedAt) > Number(inc.timestamp))
        .map(inc => Number(inc.resolvedAt) - Number(inc.timestamp));

    if (durations.length === 0) {
        return { sampleSize: 0, avgResolutionMinutes: null };
    }

    const avgMs = durations.reduce((sum, d) => sum + d, 0) / durations.length;
    return {
        sampleSize: durations.length,
        avgResolutionMinutes: Math.round((avgMs / 60000) * 10) / 10
    };
}

// Same Morning/Afternoon/Evening/Night buckets as insights.js's time-of-day
// chart (Asia/Manila), so the AI's answer matches the chart on screen.
const TIME_OF_DAY_PERIODS = [
    { label: "Morning", start: 6, end: 11 },
    { label: "Afternoon", start: 12, end: 16 },
    { label: "Evening", start: 17, end: 20 },
    { label: "Night", start: 21, end: 5 }
];

export function getTimeOfDayStatistics() {
    const counts = new Map(TIME_OF_DAY_PERIODS.map(p => [p.label, 0]));

    getValidIncidents().forEach(inc => {
        const d = new Date(Number(inc.timestamp));
        const hourStr = d.toLocaleString("en-US", { hour: "2-digit", hour12: false, timeZone: "Asia/Manila" });
        const hour = parseInt(hourStr, 10) % 24;
        const period = TIME_OF_DAY_PERIODS.find(p => p.start <= p.end
            ? (hour >= p.start && hour <= p.end)
            : (hour >= p.start || hour <= p.end));
        if (period) counts.set(period.label, counts.get(period.label) + 1);
    });

    return TIME_OF_DAY_PERIODS.map(p => ({ period: p.label, count: counts.get(p.label) }));
}

// Everything above, packaged into one compact object sent with each
// question. Kept intentionally small (top 5s / last 10, not full history)
// to stay well inside Gemini's free-tier token limits.
export function buildAIContext() {
    return {
        generatedAt: new Date().toISOString(),
        scope: "Current live RescuePriority administrative data. Test incidents are excluded.",
        activeEmergencies: getActiveEmergencies(),
        incidentStatistics: getIncidentStatistics(),
        recentIncidents: getRecentIncidents(20),
        topClassroomsAndZones: getTopClassrooms(5),
        studentIncidentStatistics: getStudentIncidentStatistics(10),
        incidentTypeStatistics: getIncidentTypeStatistics(8),
        violationStatistics: getViolationStatistics(8),
        dailyIncidentTrend: getDailyIncidentTrend(30),
        resolutionStatistics: getResolutionStatistics(),
        timeOfDayStatistics: getTimeOfDayStatistics()
    };
}
