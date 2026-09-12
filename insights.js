/* ==========================================================================
   RESCUEPRIORITY - ANALYTICS / GRAPHS
   ----------------------------------------------------------------------
   Reuses the existing `database` instance from script.js (so this does NOT
   initialize a second Firebase app). It DOES set up its own read-only
   onValue() listener on /incidents — deliberately, not via a cross-module
   live-binding import — because relying on script.js's internal `incidents`
   variable proved unreliable (the Incident Log, which reads that variable
   directly inside script.js, stayed in sync; this file, reading it through
   an ES import, did not always see updates). A dedicated listener here is
   simpler to reason about and guaranteed to match Firebase's actual state.
   /incidents already has ".read: true" in the Firebase rules, so this needs
   no rule changes.

   script.js dispatches one plain DOM event this file listens for:
     - "rp:analytics-view-activated" -> fired the moment the Analytics tab
                                         is opened (so charts are built with
                                         correct canvas dimensions the first
                                         time, instead of while hidden)
========================================================================== */

import { database, SCHOOL_FACILITIES, isClassroomFacility, displayFacilityName } from "./script.js";
import { sectionsState, computeSectionStats } from "./students.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const incidentsRootRef = ref(database, "incidents");
let incidents = [];

// Names of facilities that are actual classrooms (grade-level + section),
// as opposed to offices/support facilities (Faculty/Facility Room,
// Principal's Office, Clinic, Library, etc). Used to keep classroom-only
// visualizations (Classroom Activity, By Classroom) from being diluted by
// non-classroom facilities that happen to share the incident stream.
const CLASSROOM_NAMES = new Set(
    SCHOOL_FACILITIES.filter(isClassroomFacility).map(f => displayFacilityName(f.name))
);
function isClassroomIncident(inc) {
    return CLASSROOM_NAMES.has(safeClassroomName(inc));
}

function setupIncidentsListener() {
    onValue(
        incidentsRootRef,
        (snapshot) => {
            const data = snapshot.val() || {};
            incidents = Object.keys(data).map(key => ({ key, ...data[key] }));
            refreshAnalytics();
            buildOrUpdateHomeCharts();
            buildOrUpdateCommandCenterCharts();
        },
        (error) => {
            console.error("[analytics listener] Firebase read failed:", error.code, error.message);
        }
    );
}

/* Top Sections chart depends on sections/students/violations, not just
   incidents/ — those already have live listeners in students.js and
   violations.js (whose exported state this file reads), but nothing here
   was re-running buildOrUpdateCharts() when THEY changed without an
   incidents/ update too. These three thin listeners exist purely as a
   "something changed, re-render" trigger — they ignore their own snapshot
   and read sectionsState/computeSectionStats (already kept live by
   students.js) instead of keeping a second copy of the data. */
function setupSectionRiskRefreshTriggers() {
    ["sections", "students", "violations"].forEach((path) => {
        onValue(ref(database, path), () => refreshAnalytics());
    });
}

/* ==========================================================================
   CHART INSTANCES (created once, then updated in place)
========================================================================== */
const charts = {
    volume: null,
    activeResolved: null,
    classroom: null,
    resolution: null,
    timeOfDay: null,
    sectionRisk: null,
    homeClassroom: null,
    homeStatus: null,
    ccActivity: null
};

let chartsBuilt = false;
let homeChartsBuilt = false;
let ccChartsBuilt = false;
let currentPeriod = "daily";
let ccActivityPeriod = "daily";

// How many periods (days / weeks / months, depending on ccActivityPeriod)
// the Incident Trend window is shifted back from "now". 0 = the normal
// trailing window ending today. Lets the < / > controls scroll back to
// earlier dates instead of the chart being stuck on a fixed cutoff.
let ccActivityOffset = 0;

// When null, Daily/Weekly charts use their normal "trailing window ending
// today" behavior (unchanged). When set to a Date (first-of-month), Daily
// shows every day of that calendar month and Weekly shows the weeks that
// fall inside it, so the month navigator can jump to any past month —
// e.g. July — instead of only ever seeing the last 14 days.
let selectedMonthAnchor = null;

/* ==========================================================================
   THEME COLORS (read from the existing CSS variables in style.css so this
   file never hard-codes a palette that could drift from the rest of the app)
========================================================================== */
function themeColor(varName, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return value || fallback;
}

// Converts a theme hex color (e.g. "#FF66C4") to an rgba() string so charts
// can apply a subtle transparency without introducing a color outside the
// existing --accent-pink family.
function withAlpha(hex, alpha) {
    const clean = String(hex).replace("#", "");
    const full = clean.length === 3 ? clean.split("").map(c => c + c).join("") : clean;
    const value = parseInt(full, 16);
    if (!Number.isFinite(value)) return hex;
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getPalette() {
    return {
        pink: themeColor("--accent-pink", "#FF66C4"),
        pinkDark: themeColor("--accent-pink-dark", "#C2368F"),
        pinkSoft: themeColor("--accent-pink-soft", "#FFD6EC"),
        pinkLightest: themeColor("--accent-pink-lightest", "#FFF3FA"),
        safe: themeColor("--status-safe", "#0E8F4E"),
        warning: themeColor("--status-warning", "#A6720C"),
        emergency: themeColor("--status-emergency", "#D92D20"),
        textPrimary: themeColor("--text-primary", "#1C1720"),
        textSecondary: themeColor("--text-secondary", "#6B6470"),
        border: themeColor("--border-color", "#E4E1E6"),
        bgCard: themeColor("--bg-card", "#FFFFFF"),
        fontFamily: "'Inter', system-ui, sans-serif"
    };
}

/* ==========================================================================
   DATA ROBUSTNESS
   Filters raw incident records down to entries analytics can safely use.
   Never throws — a malformed record is simply excluded, not fatal.
========================================================================== */
function getValidIncidents() {
    if (!Array.isArray(incidents)) return [];

    return incidents.filter(inc => {
        if (!inc || typeof inc !== "object") return false;
        const ts = Number(inc.timestamp);
        return Number.isFinite(ts) && ts > 0;
    });
}

function safeClassroomName(inc) {
    const raw = (inc.classroom && String(inc.classroom).trim()) || "Unknown";
    return displayFacilityName(raw);
}

function safeStatus(inc) {
    return inc.status === "Active" || inc.status === "Resolved" ? inc.status : "Unknown";
}

/* ==========================================================================
   KPI CALCULATIONS
========================================================================== */
function computeKpis(validIncidents) {
    const total = validIncidents.length;
    const active = validIncidents.filter(inc => safeStatus(inc) === "Active").length;
    const resolved = validIncidents.filter(inc => safeStatus(inc) === "Resolved").length;

    const resolutionDurations = validIncidents
        .filter(inc => safeStatus(inc) === "Resolved" && Number.isFinite(Number(inc.resolvedAt)) && Number(inc.resolvedAt) > Number(inc.timestamp))
        .map(inc => Number(inc.resolvedAt) - Number(inc.timestamp));

    let avgResolutionLabel = "Not enough data";

    if (resolutionDurations.length > 0) {
        const avgMs = resolutionDurations.reduce((sum, d) => sum + d, 0) / resolutionDurations.length;
        const avgMinutes = avgMs / 60000;

        if (avgMinutes < 60) {
            avgResolutionLabel = `${avgMinutes.toFixed(1)} min`;
        } else {
            const hours = Math.floor(avgMinutes / 60);
            const mins = Math.round(avgMinutes % 60);
            avgResolutionLabel = `${hours}h ${mins}m`;
        }
    }

    return { total, active, resolved, avgResolutionLabel };
}

function renderKpis(kpis) {
    setText("kpi-total-incidents", kpis.total);
    setText("kpi-active-incidents", kpis.active);
    setText("kpi-resolved-incidents", kpis.resolved);
    setText("kpi-avg-resolution", kpis.avgResolutionLabel);
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

/* ==========================================================================
   ANALYTICS TIME BUCKETS (Daily / Weekly / Monthly)
   Shared by both time-series charts on the Analytics page — Incident Volume
   and Active vs. Resolved — so they always plot against identical x-axis
   buckets and stay visually comparable when the period control changes.
   (Independent from the Command Center's buildActivitySeries below, which
   intentionally uses its own shorter window — see the comment there.)
========================================================================== */
function buildAnalyticsPeriodBuckets(period) {
    const now = new Date();

    function dayKey(d) {
        return d.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }); // YYYY-MM-DD, sortable
    }
    function dayLabel(d) {
        return d.toLocaleDateString("en-PH", { month: "short", day: "numeric", timeZone: "Asia/Manila" });
    }
    function weekLabel(d) {
        return `Wk of ${d.toLocaleDateString("en-PH", { month: "short", day: "numeric", timeZone: "Asia/Manila" })}`;
    }
    function monthKey(d) {
        return d.toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", timeZone: "Asia/Manila" }).slice(0, 7);
    }
    function monthLabel(d) {
        return d.toLocaleDateString("en-PH", { month: "short", year: "numeric", timeZone: "Asia/Manila" });
    }

    if (period === "monthly") {
        const keys = [];
        const labels = [];
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            keys.push(monthKey(d));
            labels.push(monthLabel(d));
        }
        return { keys, labels, bucketKeyForTimestamp: (ts) => monthKey(new Date(ts)) };
    }

    if (period === "weekly") {
        const msPerWeek = 7 * 24 * 60 * 60 * 1000;

        if (selectedMonthAnchor) {
            // Every week that touches the selected calendar month, from the
            // Sunday on/before day 1 through the Sunday on/before the last day.
            const monthStart = new Date(selectedMonthAnchor.getFullYear(), selectedMonthAnchor.getMonth(), 1);
            const monthEnd = new Date(selectedMonthAnchor.getFullYear(), selectedMonthAnchor.getMonth() + 1, 0);
            const firstWeekStart = new Date(monthStart);
            firstWeekStart.setDate(firstWeekStart.getDate() - firstWeekStart.getDay());

            const keys = [];
            for (let t = firstWeekStart.getTime(); t <= monthEnd.getTime(); t += msPerWeek) {
                keys.push(t);
            }
            const labels = keys.map(k => weekLabel(new Date(k)));
            return {
                keys,
                labels,
                bucketKeyForTimestamp: (ts) => {
                    for (let i = keys.length - 1; i >= 0; i--) {
                        if (ts >= keys[i]) return keys[i];
                    }
                    return keys[0];
                }
            };
        }

        const startOfThisWeek = new Date(now);
        startOfThisWeek.setHours(0, 0, 0, 0);
        startOfThisWeek.setDate(startOfThisWeek.getDate() - startOfThisWeek.getDay());

        const keys = [];
        for (let i = 7; i >= 0; i--) {
            keys.push(startOfThisWeek.getTime() - i * msPerWeek);
        }
        const labels = keys.map(k => weekLabel(new Date(k)));
        return {
            keys,
            labels,
            bucketKeyForTimestamp: (ts) => {
                for (let i = keys.length - 1; i >= 0; i--) {
                    if (ts >= keys[i]) return keys[i];
                }
                return keys[0];
            }
        };
    }

    if (selectedMonthAnchor) {
        // daily — every day of the selected calendar month
        const year = selectedMonthAnchor.getFullYear();
        const month = selectedMonthAnchor.getMonth();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const keys = [];
        const labels = [];
        for (let day = 1; day <= daysInMonth; day++) {
            const d = new Date(year, month, day);
            keys.push(dayKey(d));
            labels.push(dayLabel(d));
        }
        return { keys, labels, bucketKeyForTimestamp: (ts) => dayKey(new Date(ts)) };
    }

    // daily — last 14 days
    const keys = [];
    const labels = [];
    for (let i = 13; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        keys.push(dayKey(d));
        labels.push(dayLabel(d));
    }
    return { keys, labels, bucketKeyForTimestamp: (ts) => dayKey(new Date(ts)) };
}

/* ==========================================================================
   INCIDENT VOLUME OVER TIME (Daily / Weekly / Monthly)
   Total incident count per bucket — the Analytics page's primary trend.
========================================================================== */
function buildVolumeSeries(validIncidents, period) {
    const buckets = buildAnalyticsPeriodBuckets(period);
    const counts = new Map(buckets.keys.map(k => [k, 0]));

    validIncidents.forEach(inc => {
        const key = buckets.bucketKeyForTimestamp(Number(inc.timestamp));
        if (counts.has(key)) counts.set(key, counts.get(key) + 1);
    });

    return { labels: buckets.labels, data: buckets.keys.map(k => counts.get(k)) };
}

/* ==========================================================================
   ACTIVE VS RESOLVED OVER TIME (Daily / Weekly / Monthly)
   Splits each bucket by the incident's CURRENT status, so the pair of lines
   shows whether resolution is keeping pace with incoming incidents rather
   than just repeating the total-volume count.
========================================================================== */
function buildActiveResolvedSeries(validIncidents, period) {
    const buckets = buildAnalyticsPeriodBuckets(period);
    const active = new Map(buckets.keys.map(k => [k, 0]));
    const resolved = new Map(buckets.keys.map(k => [k, 0]));

    validIncidents.forEach(inc => {
        const key = buckets.bucketKeyForTimestamp(Number(inc.timestamp));
        if (!active.has(key)) return;
        const status = safeStatus(inc);
        if (status === "Active") active.set(key, active.get(key) + 1);
        else if (status === "Resolved") resolved.set(key, resolved.get(key) + 1);
    });

    return {
        labels: buckets.labels,
        activeData: buckets.keys.map(k => active.get(k)),
        resolvedData: buckets.keys.map(k => resolved.get(k))
    };
}

/* ==========================================================================
   BY CLASSROOM
   Kept exactly as-is (sorted descending, top 12) — the Command Center's
   Classroom Activity list and the Dashboard's classroom chart both depend
   on this order and slice count, so it is not touched here.
========================================================================== */
function buildClassroomSeries(validIncidents) {
    const counts = new Map();
    validIncidents.filter(isClassroomIncident).forEach(inc => {
        const name = safeClassroomName(inc);
        counts.set(name, (counts.get(name) || 0) + 1);
    });

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    return {
        labels: sorted.map(([name]) => name),
        data: sorted.map(([, count]) => count)
    };
}

/* ==========================================================================
   TOP CLASSROOMS (Analytics — horizontal bar, top 5)
   Deliberately a separate builder from buildClassroomSeries above rather
   than a shared one with a `limit` argument: this one reverses the sorted
   order before returning, because Chart.js draws a horizontal bar's first
   array entry at the BOTTOM of the y-axis, and the reversed order is wrong
   for the Command Center's list (which expects highest-first).
========================================================================== */
function buildTopClassroomsSeries(validIncidents, limit = 5) {
    const counts = new Map();
    validIncidents.filter(isClassroomIncident).forEach(inc => {
        const name = safeClassroomName(inc);
        counts.set(name, (counts.get(name) || 0) + 1);
    });

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).reverse();
    return {
        labels: sorted.map(([name]) => name),
        data: sorted.map(([, count]) => count)
    };
}

/* ==========================================================================
   TIME OF DAY (grouped operational periods, Asia/Manila local hour)
   Grouped into Morning / Afternoon / Evening / Night rather than 24 raw
   hourly bars — easier to read at a glance and answers the operational
   question ("when do incidents happen?") without the noise of hour-by-hour
   granularity a school-hours dataset doesn't really need.
========================================================================== */
const TIME_OF_DAY_PERIODS = [
    { label: "Morning", start: 6, end: 11 },    // 6:00 AM – 11:59 AM
    { label: "Afternoon", start: 12, end: 16 }, // 12:00 PM – 4:59 PM
    { label: "Evening", start: 17, end: 20 },   // 5:00 PM – 8:59 PM
    { label: "Night", start: 21, end: 5 }       // 9:00 PM – 5:59 AM (wraps past midnight)
];

function buildTimeOfDaySeries(validIncidents) {
    const counts = new Array(TIME_OF_DAY_PERIODS.length).fill(0);

    validIncidents.forEach(inc => {
        const d = new Date(Number(inc.timestamp));
        const hourStr = d.toLocaleString("en-US", { hour: "2-digit", hour12: false, timeZone: "Asia/Manila" });
        const hour = parseInt(hourStr, 10) % 24;
        const index = TIME_OF_DAY_PERIODS.findIndex(p => p.start <= p.end
            ? (hour >= p.start && hour <= p.end)
            : (hour >= p.start || hour <= p.end));
        if (index >= 0) counts[index]++;
    });

    return { labels: TIME_OF_DAY_PERIODS.map(p => p.label), data: counts };
}

/* ==========================================================================
   RESOLUTION TIME DISTRIBUTION
   Buckets real (resolvedAt - timestamp) durations for Resolved incidents
   only — unresolved incidents have no duration and are excluded rather
   than guessed at. Colored bucket-by-bucket with the app's existing
   semantic status colors (fast = safe green, slow = emergency red) so the
   chart reads as a performance signal, not just another bar chart.
========================================================================== */
const RESOLUTION_BUCKETS = [
    { label: "< 5 min", max: 5 },
    { label: "5–10 min", max: 10 },
    { label: "10–20 min", max: 20 },
    { label: "20–30 min", max: 30 },
    { label: "30–60 min", max: 60 },
    { label: "> 60 min", max: Infinity }
];

function buildResolutionDistribution(validIncidents) {
    const counts = new Array(RESOLUTION_BUCKETS.length).fill(0);

    const durationsMinutes = validIncidents
        .filter(inc => safeStatus(inc) === "Resolved" && Number.isFinite(Number(inc.resolvedAt)) && Number(inc.resolvedAt) > Number(inc.timestamp))
        .map(inc => (Number(inc.resolvedAt) - Number(inc.timestamp)) / 60000);

    durationsMinutes.forEach(mins => {
        const idx = RESOLUTION_BUCKETS.findIndex(b => mins < b.max);
        counts[idx >= 0 ? idx : RESOLUTION_BUCKETS.length - 1]++;
    });

    return {
        labels: RESOLUTION_BUCKETS.map(b => b.label),
        data: counts,
        hasData: durationsMinutes.length > 0
    };
}

/* ==========================================================================
   STATUS DISTRIBUTION
   Still used by the Command Center's status doughnut/rows and the Dashboard
   status chart — the standalone Status chart on the Analytics page itself
   was removed (redundant with the KPI row + Active vs. Resolved trend), but
   this builder remains needed elsewhere.
========================================================================== */
function buildStatusSeries(validIncidents) {
    const active = validIncidents.filter(inc => safeStatus(inc) === "Active").length;
    const resolved = validIncidents.filter(inc => safeStatus(inc) === "Resolved").length;
    return { labels: ["Active", "Resolved"], data: [active, resolved] };
}

/* ==========================================================================
   TOP SECTIONS — INCIDENTS & VIOLATIONS (Analytics — grouped horizontal bar)
   Reads students.js's computeSectionStats() — the exact same per-section
   incident/violation counts used by the "Highest Incidents" / "Highest
   Violations" sort in Students & Sections — so this chart's ranking never
   disagrees with that sort. Sections with zero of both are left off rather
   than padding the chart with rows that carry no signal.
========================================================================== */
function buildSectionRiskSeries(limit = 8) {
    const rows = Object.entries(sectionsState).map(([id, section]) => ({
        label: (section && section.name) || "Unnamed",
        ...computeSectionStats(id)
    }));

    const sorted = rows
        .filter((r) => r.incidentCount > 0 || r.violationCount > 0)
        .sort((a, b) => (b.incidentCount + b.violationCount) - (a.incidentCount + a.violationCount))
        .slice(0, limit)
        .reverse(); // horizontal bar: first array entry draws at the BOTTOM of the y-axis

    return {
        labels: sorted.map((r) => r.label),
        incidentData: sorted.map((r) => r.incidentCount),
        violationData: sorted.map((r) => r.violationCount),
        hasData: sorted.length > 0
    };
}

/* ==========================================================================
   EMPTY-STATE HELPERS
========================================================================== */
function toggleEmptyNote(id, isEmpty) {
    const note = document.getElementById(id);
    if (note) note.classList.toggle("hidden", !isEmpty);
}

/* ==========================================================================
   CHART BUILD / UPDATE
   Charts are created once (chartsBuilt flag) and updated in place afterward
   — this keeps Firebase-driven re-renders cheap and avoids flicker.
========================================================================== */
function buildOrUpdateCharts() {
    const validIncidents = getValidIncidents();

    // KPIs never depend on Chart.js — render them first, unconditionally,
    // so a blocked/failed CDN never blanks out the numbers.
    renderKpis(computeKpis(validIncidents));

    if (typeof Chart === "undefined") {
        // Chart.js failed to load (e.g. CDN blocked on this network).
        // KPIs above still rendered; skip only the graphs themselves.
        return;
    }

    const palette = getPalette();

    const volume = buildVolumeSeries(validIncidents, currentPeriod);
    const activeResolved = buildActiveResolvedSeries(validIncidents, currentPeriod);
    const topClassrooms = buildTopClassroomsSeries(validIncidents);
    const resolution = buildResolutionDistribution(validIncidents);
    const timeOfDay = buildTimeOfDaySeries(validIncidents);
    const sectionRisk = buildSectionRiskSeries();

    toggleEmptyNote("chart-volume-empty", validIncidents.length === 0);
    toggleEmptyNote("chart-active-resolved-empty", validIncidents.length === 0);
    toggleEmptyNote("chart-classroom-empty", validIncidents.length === 0);
    toggleEmptyNote("chart-resolution-empty", !resolution.hasData);
    toggleEmptyNote("chart-timeofday-empty", validIncidents.length === 0);
    toggleEmptyNote("chart-section-risk-empty", !sectionRisk.hasData);

    Chart.defaults.font.family = palette.fontFamily;
    Chart.defaults.color = palette.textSecondary;

    if (!chartsBuilt) {
        // Defensive: if a chart instance somehow already exists on one of
        // these canvases (e.g. a duplicate build call slipped through),
        // destroy it first — Chart.js throws if you construct a new chart
        // on a canvas that's already in use.
        ["chart-volume", "chart-active-resolved", "chart-classroom", "chart-resolution", "chart-timeofday", "chart-section-risk"].forEach(id => {
            const canvas = document.getElementById(id);
            const existing = canvas && Chart.getChart(canvas);
            if (existing) existing.destroy();
        });

        charts.volume = new Chart(document.getElementById("chart-volume"), {
            type: "line",
            data: {
                labels: volume.labels,
                datasets: [{
                    label: "Incidents",
                    data: volume.data,
                    borderColor: palette.pink,
                    backgroundColor: withAlpha(palette.pink, 0.82),
                    borderWidth: 2,
                    fill: true,
                    tension: 0,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointHoverBackgroundColor: palette.pink,
                    pointHoverBorderColor: palette.bgCard,
                    pointHoverBorderWidth: 2
                }]
            },
            options: volumeAreaOptions(palette)
        });

        charts.activeResolved = new Chart(document.getElementById("chart-active-resolved"), {
            type: "line",
            data: {
                labels: activeResolved.labels,
                datasets: [
                    {
                        label: "Active",
                        data: activeResolved.activeData,
                        borderColor: palette.emergency,
                        backgroundColor: palette.emergency,
                        borderWidth: 2,
                        tension: 0.3,
                        pointRadius: 2.5,
                        pointBackgroundColor: palette.emergency
                    },
                    {
                        label: "Resolved",
                        data: activeResolved.resolvedData,
                        borderColor: palette.safe,
                        backgroundColor: palette.safe,
                        borderWidth: 2,
                        tension: 0.3,
                        pointRadius: 2.5,
                        pointBackgroundColor: palette.safe
                    }
                ]
            },
            options: activeResolvedLineOptions(palette)
        });

        charts.classroom = new Chart(document.getElementById("chart-classroom"), {
            type: "bar",
            data: {
                labels: topClassrooms.labels,
                datasets: [{ label: "Incidents", data: topClassrooms.data, backgroundColor: palette.pink, borderRadius: 4 }]
            },
            options: hBarOptions(palette)
        });

        charts.resolution = new Chart(document.getElementById("chart-resolution"), {
            type: "bar",
            data: {
                labels: resolution.labels,
                datasets: [{
                    label: "Resolved Incidents",
                    data: resolution.data,
                    backgroundColor: [palette.safe, palette.safe, palette.warning, palette.warning, palette.emergency, palette.emergency],
                    borderRadius: 4
                }]
            },
            options: baseBarOptions(palette, false)
        });

        charts.timeOfDay = new Chart(document.getElementById("chart-timeofday"), {
            type: "bar",
            data: {
                labels: timeOfDay.labels,
                datasets: [{ label: "Incidents", data: timeOfDay.data, backgroundColor: palette.pinkDark, borderRadius: 4 }]
            },
            options: baseBarOptions(palette, false)
        });

        charts.sectionRisk = new Chart(document.getElementById("chart-section-risk"), {
            type: "bar",
            data: {
                labels: sectionRisk.labels,
                datasets: [
                    { label: "Incidents", data: sectionRisk.incidentData, backgroundColor: palette.pink, borderRadius: 4 },
                    { label: "Violations", data: sectionRisk.violationData, backgroundColor: palette.warning, borderRadius: 4 }
                ]
            },
            options: sectionRiskBarOptions(palette)
        });

        chartsBuilt = true;
    } else {
        updateDataset(charts.volume, volume.labels, volume.data);
        updateMultiDataset(charts.activeResolved, activeResolved.labels, [activeResolved.activeData, activeResolved.resolvedData]);
        updateDataset(charts.classroom, topClassrooms.labels, topClassrooms.data);
        updateDataset(charts.resolution, resolution.labels, resolution.data);
        updateDataset(charts.timeOfDay, timeOfDay.labels, timeOfDay.data);
        updateMultiDataset(charts.sectionRisk, sectionRisk.labels, [sectionRisk.incidentData, sectionRisk.violationData]);
    }
}

/* ==========================================================================
   HOME DASHBOARD CHARTS
   A small preview pair (Incidents by Classroom + Status Overview) shown on
   the Home/Dashboard view, in the same style as the reference screenshot.
   The Dashboard is visible on page load (unlike Analytics), so these are
   built immediately rather than waiting for a "view activated" event.
========================================================================== */
function isDashboardViewVisible() {
    const view = document.getElementById("dashboard-view");
    return !!view && !view.classList.contains("hidden");
}

function buildOrUpdateHomeCharts() {
    if (typeof Chart === "undefined") return;

    // Dashboard is no longer the view visible on page load (Command Center
    // is). Chart.js sizes a new chart to its canvas's current pixel
    // dimensions, so building it for the first time while the canvas is
    // display:none would leave it permanently 0x0 — same issue already
    // solved for Analytics via isAnalyticsViewVisible(). Once built, later
    // updates are just data swaps and are safe to run while hidden.
    if (!homeChartsBuilt && !isDashboardViewVisible()) return;

    const validIncidents = getValidIncidents();
    const palette = getPalette();

    const classroom = buildClassroomSeries(validIncidents);
    const status = buildStatusSeries(validIncidents);

    toggleEmptyNote("chart-home-classroom-empty", validIncidents.length === 0);
    toggleEmptyNote("chart-home-status-empty", validIncidents.length === 0);

    Chart.defaults.font.family = palette.fontFamily;
    Chart.defaults.color = palette.textSecondary;

    if (!homeChartsBuilt) {
        ["chart-home-classroom", "chart-home-status"].forEach(id => {
            const canvas = document.getElementById(id);
            const existing = canvas && Chart.getChart(canvas);
            if (existing) existing.destroy();
        });

        const classroomCanvas = document.getElementById("chart-home-classroom");
        if (classroomCanvas) {
            charts.homeClassroom = new Chart(classroomCanvas, {
                type: "bar",
                data: {
                    labels: classroom.labels,
                    datasets: [{ label: "Incidents", data: classroom.data, backgroundColor: palette.pink, borderRadius: 4 }]
                },
                options: baseBarOptions(palette, true)
            });
        }

        const statusCanvas = document.getElementById("chart-home-status");
        if (statusCanvas) {
            charts.homeStatus = new Chart(statusCanvas, {
                type: "doughnut",
                data: {
                    labels: status.labels,
                    datasets: [{
                        data: status.data,
                        backgroundColor: [palette.emergency, palette.safe],
                        borderColor: palette.border,
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: "62%",
                    plugins: {
                        legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } }
                    }
                }
            });
        }

        homeChartsBuilt = true;
    } else {
        updateDataset(charts.homeClassroom, classroom.labels, classroom.data);
        updateDataset(charts.homeStatus, status.labels, status.data);
    }
}

function updateDataset(chart, labels, data) {
    if (!chart) return;
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.update();
}

// Same as updateDataset, but for charts with more than one dataset (e.g.
// Active vs. Resolved) — dataArrays[i] replaces chart.data.datasets[i].data.
function updateMultiDataset(chart, labels, dataArrays) {
    if (!chart) return;
    chart.data.labels = labels;
    dataArrays.forEach((data, i) => {
        if (chart.data.datasets[i]) chart.data.datasets[i].data = data;
    });
    chart.update();
}

/* ==========================================================================
   COMMAND CENTER — HERO CHARTS
   "Incident Activity" (Active vs Resolved, grouped rounded bars) and
   "Incident Status" (doughnut) live on the Command Center view, which is
   the view visible by default on page load (unlike Dashboard/Analytics).
   That means the very first build already has correct canvas dimensions,
   so no visibility gating is needed before the first paint — the guard
   below only protects against the (rare) case of a snapshot arriving
   while the user has already navigated to another view.
========================================================================== */
function isCommandCenterViewVisible() {
    const view = document.getElementById("command-center-view");
    return !!view && !view.classList.contains("hidden");
}

/* Independent bucket logic from buildAnalyticsPeriodBuckets — deliberately
   not shared, so tuning the hero chart's window (fewer, thicker bars) never
   risks changing the Analytics page's "Incident Volume" / "Active vs.
   Resolved" time buckets. */
function buildActivitySeries(validIncidents, period, offset = 0) {
    const now = new Date();
    const buckets = new Map();

    function dayKey(d) { return d.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }); }
    function dayLabel(d) { return d.toLocaleDateString("en-PH", { month: "short", day: "numeric", timeZone: "Asia/Manila" }); }
    function weekLabel(d) { return d.toLocaleDateString("en-PH", { month: "short", day: "numeric", timeZone: "Asia/Manila" }); }
    function monthKey(d) { return d.toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", timeZone: "Asia/Manila" }).slice(0, 7); }
    function monthLabel(d) { return d.toLocaleDateString("en-PH", { month: "short", year: "numeric", timeZone: "Asia/Manila" }); }

    if (period === "monthly") {
        // offset shifts the whole 6-month window back in whole months —
        // offset 0 is the normal "last 6 months ending this month" window.
        const anchorMonth = new Date(now.getFullYear(), now.getMonth() - offset, 1);
        for (let i = 5; i >= 0; i--) {
            const d = new Date(anchorMonth.getFullYear(), anchorMonth.getMonth() - i, 1);
            buckets.set(monthKey(d), { label: monthLabel(d), active: 0, resolved: 0 });
        }
        validIncidents.forEach(inc => {
            const key = monthKey(new Date(Number(inc.timestamp)));
            if (!buckets.has(key)) return;
            const bucket = buckets.get(key);
            const status = safeStatus(inc);
            if (status === "Active") bucket.active++;
            else if (status === "Resolved") bucket.resolved++;
        });
    } else if (period === "weekly") {
        const msPerWeek = 7 * 24 * 60 * 60 * 1000;
        const startOfThisWeek = new Date(now);
        startOfThisWeek.setHours(0, 0, 0, 0);
        startOfThisWeek.setDate(startOfThisWeek.getDate() - startOfThisWeek.getDay());
        // offset shifts the 6-week window back by whole weeks.
        const anchorWeekStart = new Date(startOfThisWeek.getTime() - offset * msPerWeek);

        const weekStarts = [];
        for (let i = 5; i >= 0; i--) {
            weekStarts.push(new Date(anchorWeekStart.getTime() - i * msPerWeek));
        }
        weekStarts.forEach(ws => buckets.set(ws.getTime(), { label: weekLabel(ws), active: 0, resolved: 0 }));

        validIncidents.forEach(inc => {
            const ts = Number(inc.timestamp);
            for (let i = weekStarts.length - 1; i >= 0; i--) {
                if (ts >= weekStarts[i].getTime()) {
                    const bucket = buckets.get(weekStarts[i].getTime());
                    const status = safeStatus(inc);
                    if (status === "Active") bucket.active++;
                    else if (status === "Resolved") bucket.resolved++;
                    break;
                }
            }
        });
    } else {
        // daily — 7 days, thicker/fewer bars to match the reference
        // proportions. offset shifts the window back by whole days, so
        // scrolling can reach any past date instead of being capped at
        // the last 7 days.
        const anchorDay = new Date(now);
        anchorDay.setDate(anchorDay.getDate() - offset);
        for (let i = 6; i >= 0; i--) {
            const d = new Date(anchorDay);
            d.setDate(d.getDate() - i);
            buckets.set(dayKey(d), { label: dayLabel(d), active: 0, resolved: 0 });
        }
        validIncidents.forEach(inc => {
            const key = dayKey(new Date(Number(inc.timestamp)));
            if (!buckets.has(key)) return;
            const bucket = buckets.get(key);
            const status = safeStatus(inc);
            if (status === "Active") bucket.active++;
            else if (status === "Resolved") bucket.resolved++;
        });
    }

    const entries = [...buckets.values()];
    return {
        labels: entries.map(e => e.label),
        activeData: entries.map(e => e.active),
        resolvedData: entries.map(e => e.resolved),
        rangeLabel: entries.length ? `${entries[0].label} \u2013 ${entries[entries.length - 1].label}` : "\u2014"
    };
}

// Two overlapping bubbles (Active / Resolved), sized by share of total,
// plus a legend with proportional bars — replaces the earlier concentric
// SVG rings with a "track by location"-style bubble cluster. Still driven
// by the same buildStatusSeries() data, so it stays tied to the live
// Firebase incident stream — nothing here is hardcoded.
function renderStatusRings(status) {
    const activeBubble = document.getElementById("cc-bubble-active");
    const resolvedBubble = document.getElementById("cc-bubble-resolved");
    const activeValueEl = document.getElementById("cc-bubble-active-value");
    const resolvedValueEl = document.getElementById("cc-bubble-resolved-value");
    const legend = document.getElementById("cc-status-rings-legend");
    if (!activeBubble || !resolvedBubble || !activeValueEl || !resolvedValueEl || !legend) return;

    const [activeCount, resolvedCount] = status.data;
    const total = activeCount + resolvedCount;

    const activePct = total > 0 ? Math.round((activeCount / total) * 100) : 0;
    const resolvedPct = total > 0 ? Math.round((resolvedCount / total) * 100) : 0;

    // Bubble diameter scales with sqrt(share) so AREA (not just radius)
    // tracks the count — the same convention real bubble charts use.
    const MIN_D = 64;
    const MAX_D = 132;
    const maxCount = Math.max(activeCount, resolvedCount, 1);
    const sizeFor = count => {
        const fraction = Math.sqrt(count / maxCount);
        return Math.round(MIN_D + (MAX_D - MIN_D) * fraction);
    };

    const activeD = sizeFor(activeCount);
    const resolvedD = sizeFor(resolvedCount);

    activeBubble.style.width = `${activeD}px`;
    activeBubble.style.height = `${activeD}px`;
    resolvedBubble.style.width = `${resolvedD}px`;
    resolvedBubble.style.height = `${resolvedD}px`;

    activeValueEl.textContent = activeCount;
    resolvedValueEl.textContent = resolvedCount;

    legend.innerHTML = `
        <div class="cc-bubble-legend-row">
            <span class="cc-bubble-legend-dot dot-active"></span>
            <span class="cc-bubble-legend-label">Active</span>
            <span class="cc-bubble-legend-bar-track"><span class="cc-bubble-legend-bar-fill fill-active" style="width:${activePct}%"></span></span>
            <span class="cc-bubble-legend-value">${activeCount}</span>
        </div>
        <div class="cc-bubble-legend-row">
            <span class="cc-bubble-legend-dot dot-resolved"></span>
            <span class="cc-bubble-legend-label">Resolved</span>
            <span class="cc-bubble-legend-bar-track"><span class="cc-bubble-legend-bar-fill fill-resolved" style="width:${resolvedPct}%"></span></span>
            <span class="cc-bubble-legend-value">${resolvedCount}</span>
        </div>
    `;
}

function renderFacilityActivity(validIncidents) {
    const container = document.getElementById("cc-facility-activity-list");
    if (!container) return;

    const classroom = buildClassroomSeries(validIncidents);
    const top = classroom.labels.map((label, i) => ({ label, count: classroom.data[i] })).slice(0, 5);

    if (top.length === 0) {
        container.innerHTML = `<p class="analytics-empty-note">No incident data available.</p>`;
        return;
    }

    const maxCount = Math.max(...top.map(f => f.count));
    container.innerHTML = top.map(facility => {
        const pct = maxCount > 0 ? Math.round((facility.count / maxCount) * 100) : 0;
        return `
            <div class="cc-facility-row">
                <div class="cc-facility-row-top">
                    <span class="cc-facility-name">${facility.label}</span>
                    <span class="cc-facility-count">${facility.count}</span>
                </div>
                <div class="cc-facility-bar-track"><div class="cc-facility-bar-fill" style="width:${pct}%"></div></div>
            </div>
        `;
    }).join("");
}

function buildOrUpdateCommandCenterCharts() {
    const validIncidents = getValidIncidents();
    const palette = getPalette();

    // Facility Activity and the Incident Status rings are plain DOM/SVG,
    // not Chart.js — safe to update regardless of Chart.js load state or
    // canvas visibility.
    renderFacilityActivity(validIncidents);
    const status = buildStatusSeries(validIncidents);
    renderStatusRings(status);
    const ringsWrap = document.getElementById("cc-status-rings-wrap");
    if (ringsWrap) ringsWrap.classList.toggle("hidden", validIncidents.length === 0);
    toggleEmptyNote("cc-status-empty", validIncidents.length === 0);

    if (typeof Chart === "undefined") return;
    if (!ccChartsBuilt && !isCommandCenterViewVisible()) return;

    const activity = buildActivitySeries(validIncidents, ccActivityPeriod, ccActivityOffset);
    const trendData = activity.activeData.map((a, i) => a + activity.resolvedData[i]);

    toggleEmptyNote("chart-cc-activity-empty", validIncidents.length === 0);
    updateCcTrendRangeLabel(activity.rangeLabel);

    Chart.defaults.font.family = palette.fontFamily;
    Chart.defaults.color = palette.textSecondary;

    if (!ccChartsBuilt) {
        const activityCanvas = document.getElementById("chart-cc-activity");
        if (activityCanvas) {
            const existing = Chart.getChart(activityCanvas);
            if (existing) existing.destroy();

            charts.ccActivity = new Chart(activityCanvas, {
                type: "line",
                data: {
                    labels: activity.labels,
                    datasets: [{
                        label: "Incidents",
                        data: trendData,
                        borderColor: palette.pink,
                        backgroundColor: "rgba(255, 102, 196, 0.16)",
                        borderWidth: 2.5,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 3,
                        pointHoverRadius: 5,
                        pointBackgroundColor: palette.pink,
                        pointBorderColor: palette.bgCard,
                        pointBorderWidth: 2
                    }]
                },
                options: trendAreaOptions(palette)
            });
        }

        ccChartsBuilt = true;
    } else {
        charts.ccActivity.data.labels = activity.labels;
        charts.ccActivity.data.datasets[0].data = trendData;
        charts.ccActivity.update();
    }
}

/* ==========================================================================
   INCIDENT TREND — large area-chart options
   Single-series total-incident trend (the Command Center centerpiece).
   Kept separate from baseActivityBarOptions since this chart needs a
   custom tooltip (no raw timestamps, "AUG 15 / 5 INCIDENTS" styling) and
   no legend (it's one series).
========================================================================== */
function trendAreaOptions(palette) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: palette.textPrimary,
                titleColor: palette.pink,
                bodyColor: "#ffffff",
                titleFont: { size: 11, weight: "700" },
                bodyFont: { size: 12, weight: "700" },
                padding: 10,
                cornerRadius: 8,
                displayColors: false,
                callbacks: {
                    title: (items) => items.length ? items[0].label.toUpperCase() : "",
                    label: (item) => `${item.parsed.y} INCIDENT${item.parsed.y === 1 ? "" : "S"}`
                }
            }
        },
        scales: {
            x: { grid: { display: false }, ticks: { font: { size: 10 } } },
            y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, grid: { color: palette.border } }
        }
    };
}

/* ==========================================================================
   INCIDENT VOLUME — area-chart options
   Styled after a clean "simple area chart" reference: no gridlines, no
   visible axis border, just quiet tick labels. Kept separate from the
   Command Center's trendAreaOptions (same tooltip idea, different look)
   since the two charts serve different visual roles.
========================================================================== */
function volumeAreaOptions(palette) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: palette.textPrimary,
                titleColor: palette.pink,
                bodyColor: "#ffffff",
                titleFont: { size: 11, weight: "700" },
                bodyFont: { size: 12, weight: "700" },
                padding: 10,
                cornerRadius: 8,
                displayColors: false,
                callbacks: {
                    title: (items) => items.length ? items[0].label.toUpperCase() : "",
                    label: (item) => `${item.parsed.y} INCIDENT${item.parsed.y === 1 ? "" : "S"}`
                }
            }
        },
        scales: {
            x: {
                grid: { display: false },
                border: { display: false },
                ticks: { font: { size: 10 }, color: palette.textSecondary }
            },
            y: {
                beginAtZero: true,
                grid: { display: false },
                border: { display: false },
                ticks: { precision: 0, font: { size: 10 }, color: palette.textSecondary }
            }
        }
    };
}

function setupCcActivityPeriodControl() {
    const select = document.getElementById("cc-activity-period-select");
    if (select) {
        select.value = ccActivityPeriod;
        select.addEventListener("change", () => {
            ccActivityPeriod = select.value;
            // A different period has a different-sized window, so start it
            // back at "now" rather than carrying over an offset that meant
            // something different under the old period.
            ccActivityOffset = 0;
            buildOrUpdateCommandCenterCharts();
        });
    }

    setupCcTrendScrollControls();
}

/* ==========================================================================
   INCIDENT TREND — SCROLL TO PREVIOUS DATES
   The trend chart only ever showed a fixed trailing window (last 7 days /
   6 weeks / 6 months). These controls page that window backward/forward
   by one period at a time so earlier activity is reachable, and the
   currently-shown range is labeled above the chart.
========================================================================== */
function setupCcTrendScrollControls() {
    const prevBtn = document.getElementById("cc-trend-prev");
    const nextBtn = document.getElementById("cc-trend-next");
    if (!prevBtn || !nextBtn) return;

    prevBtn.addEventListener("click", () => {
        ccActivityOffset += 1;
        nextBtn.disabled = ccActivityOffset <= 0;
        buildOrUpdateCommandCenterCharts();
    });

    nextBtn.addEventListener("click", () => {
        if (ccActivityOffset <= 0) return;
        ccActivityOffset -= 1;
        nextBtn.disabled = ccActivityOffset <= 0;
        buildOrUpdateCommandCenterCharts();
    });
}

function updateCcTrendRangeLabel(rangeLabel) {
    const label = document.getElementById("cc-trend-range-label");
    const nextBtn = document.getElementById("cc-trend-next");
    if (label) label.textContent = rangeLabel;
    if (nextBtn) nextBtn.disabled = ccActivityOffset <= 0;
}

/* ==========================================================================
   ACTIVE VS RESOLVED — two-line options
   The legend lives in the surrounding HTML (matching the dot colors used
   everywhere else in the app for these two statuses), so the in-chart
   legend stays off. The tooltip uses "index" mode so hovering any point
   along the x-axis shows both series at once, each labeled by dataset name
   so they're never ambiguous.
========================================================================== */
function activeResolvedLineOptions(palette) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: palette.textPrimary,
                titleColor: "#ffffff",
                bodyColor: "#ffffff",
                titleFont: { size: 11, weight: "700" },
                bodyFont: { size: 11, weight: "600" },
                padding: 10,
                cornerRadius: 8,
                callbacks: {
                    title: (items) => items.length ? items[0].label.toUpperCase() : "",
                    label: (item) => `${item.dataset.label}: ${item.parsed.y}`
                }
            }
        },
        scales: {
            x: { grid: { display: false }, ticks: { font: { size: 10 } } },
            y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, grid: { color: palette.border } }
        }
    };
}

/* ==========================================================================
   TOP CLASSROOMS — horizontal bar options
========================================================================== */
function hBarOptions(palette) {
    return {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
            x: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, grid: { color: palette.border } },
            y: { grid: { display: false }, ticks: { font: { size: 10 } } }
        }
    };
}

// Grouped horizontal bar (Incidents + Violations side by side per section),
// with a legend disabled here since the surrounding HTML already renders
// matching-colored legend dots (same convention as Active vs. Resolved).
function sectionRiskBarOptions(palette) {
    return {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: palette.textPrimary,
                titleColor: "#ffffff",
                bodyColor: "#ffffff",
                titleFont: { size: 11, weight: "700" },
                bodyFont: { size: 11, weight: "600" },
                padding: 10,
                cornerRadius: 8,
                callbacks: {
                    label: (item) => `${item.dataset.label}: ${item.parsed.x}`
                }
            }
        },
        scales: {
            x: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, grid: { color: palette.border } },
            y: { grid: { display: false }, ticks: { font: { size: 10 } } }
        }
    };
}

function baseBarOptions(palette, horizontalLabelsOnly) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
            x: {
                grid: { display: false },
                ticks: { font: { size: 10 }, autoSkip: horizontalLabelsOnly, maxRotation: horizontalLabelsOnly ? 45 : 0 }
            },
            y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, grid: { color: palette.border } }
        }
    };
}

/* ==========================================================================
   VISIBILITY GUARD
   Chart.js sizes a new chart to its canvas's current pixel dimensions. If a
   chart is first created while the Analytics tab is hidden (display:none),
   the canvas is 0x0 and the chart stays invisible forever, even after the
   tab is opened. So: never build charts for the first time while hidden —
   only update KPI text (cheap, no layout needed) until the tab is actually
   visible.
========================================================================== */
function isAnalyticsViewVisible() {
    const view = document.getElementById("analytics-view");
    return !!view && !view.classList.contains("hidden");
}

function refreshAnalytics() {
    if (!chartsBuilt && !isAnalyticsViewVisible()) {
        renderKpis(computeKpis(getValidIncidents()));
        return;
    }
    buildOrUpdateCharts();
}

function setupPeriodControl() {
    const select = document.getElementById("analytics-period-select");
    if (!select) return;

    select.value = currentPeriod;
    select.addEventListener("change", () => {
        currentPeriod = select.value;
        refreshMonthNavUI();
        buildOrUpdateCharts();
    });
}

/* ==========================================================================
   MONTH NAVIGATOR
   Lets Daily/Weekly step back to any past calendar month (e.g. July) instead
   of only ever showing a trailing window ending today. Monthly mode already
   covers the last 12 months in one chart, so the navigator is disabled there.
========================================================================== */
function monthNavLabel(anchor) {
    if (!anchor) return "Live";
    return anchor.toLocaleDateString("en-PH", { month: "long", year: "numeric", timeZone: "Asia/Manila" });
}

function isSameMonth(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function refreshMonthNavUI() {
    const label = document.getElementById("analytics-month-label");
    const prevBtn = document.getElementById("analytics-month-prev");
    const nextBtn = document.getElementById("analytics-month-next");
    const todayBtn = document.getElementById("analytics-month-today");
    const nav = document.getElementById("analytics-month-nav");
    if (!label || !prevBtn || !nextBtn || !todayBtn || !nav) return;

    const disabled = currentPeriod === "monthly";
    nav.classList.toggle("analytics-month-nav-disabled", disabled);
    prevBtn.disabled = disabled;
    nextBtn.disabled = disabled;
    todayBtn.disabled = disabled;

    label.textContent = disabled ? "Last 12 months" : monthNavLabel(selectedMonthAnchor);

    const now = new Date();
    const atCurrentMonth = !selectedMonthAnchor || isSameMonth(selectedMonthAnchor, now);
    nextBtn.disabled = disabled || atCurrentMonth;
    todayBtn.disabled = disabled || !selectedMonthAnchor;
}

function setupMonthNavControl() {
    const prevBtn = document.getElementById("analytics-month-prev");
    const nextBtn = document.getElementById("analytics-month-next");
    const todayBtn = document.getElementById("analytics-month-today");
    if (!prevBtn || !nextBtn || !todayBtn) return;

    prevBtn.addEventListener("click", () => {
        const base = selectedMonthAnchor || new Date();
        selectedMonthAnchor = new Date(base.getFullYear(), base.getMonth() - 1, 1);
        refreshMonthNavUI();
        buildOrUpdateCharts();
    });

    nextBtn.addEventListener("click", () => {
        if (!selectedMonthAnchor) return;
        const now = new Date();
        const next = new Date(selectedMonthAnchor.getFullYear(), selectedMonthAnchor.getMonth() + 1, 1);
        selectedMonthAnchor = isSameMonth(next, now) ? null : next;
        refreshMonthNavUI();
        buildOrUpdateCharts();
    });

    todayBtn.addEventListener("click", () => {
        selectedMonthAnchor = null;
        refreshMonthNavUI();
        buildOrUpdateCharts();
    });

    refreshMonthNavUI();
}

function setupRefreshButton() {
    const button = document.getElementById("btn-analytics-refresh");
    if (button) {
        button.addEventListener("click", refreshAnalytics);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    setupPeriodControl();
    setupMonthNavControl();
    setupCcActivityPeriodControl();
    setupRefreshButton();
    setupIncidentsListener();
    setupSectionRiskRefreshTriggers();

    // Chart.js (loaded in index.html) tries three CDNs in sequence — that
    // can finish loading AFTER this module has already run once with Chart
    // undefined. If/when it does finish, build the charts at that point.
    window.addEventListener("rp:chartjs-loaded", () => {
        buildOrUpdateCharts();
        buildOrUpdateHomeCharts();
        buildOrUpdateCommandCenterCharts();
    });

    // Build charts (with correct canvas size) the first time the tab is opened,
    // and force a resize on every subsequent open — a hidden -> visible CSS
    // flip doesn't fire a window resize event, so Chart.js won't notice its
    // canvas now has real dimensions unless told explicitly.
    window.addEventListener("rp:analytics-view-activated", () => {
        refreshAnalytics();
        requestAnimationFrame(() => {
            Object.values(charts).forEach(chart => chart && chart.resize());
        });
    });

    window.addEventListener("rp:dashboard-view-activated", () => {
        buildOrUpdateHomeCharts();
        requestAnimationFrame(() => {
            if (charts.homeClassroom) charts.homeClassroom.resize();
            if (charts.homeStatus) charts.homeStatus.resize();
        });
    });

    // Command Center is already visible on first load, so the very first
    // buildOrUpdateCommandCenterCharts() call (fired from the incidents
    // listener above) already builds with correct canvas dimensions. This
    // listener only handles returning to the view after navigating away.
    window.addEventListener("rp:command-center-view-activated", () => {
        buildOrUpdateCommandCenterCharts();
        requestAnimationFrame(() => {
            if (charts.ccActivity) charts.ccActivity.resize();
        });
    });
});
