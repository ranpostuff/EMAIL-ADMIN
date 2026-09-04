/* ==========================================================================
   RESCUEPRIORITY — FACILITIES TEST MODE
   --------------------------------------------------------------------------
   Purpose: a QA view for checking that the 55 campus facilities load and
   update correctly against Firebase when an incident happens — i.e. "does
   the facility that says it's in emergency actually correspond to a real
   incidents/ record, and does it update live."

   Activation: append ?facilitiestest=2 to the dashboard URL, e.g.
       https://your-deployment-url/index.html?facilitiestest=2
   That's the ONLY trigger — this module does nothing on a normal page load
   with no query string, so it can safely stay wired into index.html
   permanently without affecting the real dashboard.

   What it shows: a full-screen table over the app (does not touch the
   normal dashboard's markup/state) with one row per facility in
   SCHOOL_FACILITIES, live-bound to:
       classrooms/{facilityId}.emergency        -> current flag
       classrooms/{facilityId}.activeIncidentKey -> which incidents/ row
       incidents/{key}                           -> the actual record, so
                                                     the row can show the
                                                     incident's own
                                                     `classroom` name next
                                                     to the facility's own
                                                     name and flag a
                                                     MISMATCH if they ever
                                                     disagree.

   Exports: CSV built inline (no dependency), and Excel (.xlsx) via
   SheetJS, loaded from a CDN ONLY when the Export Excel button is first
   used (so normal page loads / even ?facilitiestest=2 loads that never
   export never pay for it).

   Test tools: "Simulate" writes a real classrooms/{id}.emergency=true and
   a real incidents/ record, but tagged isTestData:true (a field the
   database rules already allow — see database.rules.json) so it's
   filterable and never mistaken for a genuine emergency. "Clear" reverses
   it. "Reset All Test Data" wipes every isTestData incident + any
   emergency flags they set. Nothing here touches non-test data.
========================================================================== */

import { database, SCHOOL_FACILITIES, displayFacilityName } from "./script.js";
import {
    ref,
    onValue,
    set,
    update,
    push,
    remove,
    get
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { triggerIncidentAlert } from "./notify-incident.js";

function isTestModeRequested() {
    try {
        return new URLSearchParams(window.location.search).get("facilitiestest") === "2";
    } catch (error) {
        return false;
    }
}

if (isTestModeRequested()) {
    document.addEventListener("DOMContentLoaded", initFacilitiesTestMode);
}

/* ==========================================================================
   STATE
========================================================================== */
let classroomsCache = {};
let incidentsCache = {}; // key -> incident record
let sheetJsLoadPromise = null;

const classroomsRootRef = ref(database, "classrooms");
const incidentsRootRef = ref(database, "incidents");

function initFacilitiesTestMode() {
    document.body.classList.add("facilities-test-active");
    mountOverlay();

    onValue(classroomsRootRef, (snapshot) => {
        classroomsCache = snapshot.val() || {};
        renderTable();
    });

    onValue(incidentsRootRef, (snapshot) => {
        const data = snapshot.val() || {};
        incidentsCache = data;
        renderTable();
    });
}

/* ==========================================================================
   MARKUP
========================================================================== */
function mountOverlay() {
    const overlay = document.createElement("div");
    overlay.id = "facilities-test-overlay";
    overlay.innerHTML = `
        <div class="ft-bar">
            <div class="ft-bar-title">
                <strong>Facilities Test Mode</strong>
                <span class="ft-bar-sub">?facilitiestest=2 &mdash; live view of every facility vs. its incident data</span>
            </div>
            <div class="ft-bar-actions">
                <span class="ft-live-dot" title="Live Firebase connection"></span>
                <button type="button" id="ft-export-csv">Export CSV</button>
                <button type="button" id="ft-export-xlsx">Export Excel</button>
                <button type="button" id="ft-reset-test-data" class="ft-danger">Reset All Test Data</button>
                <a href="${window.location.pathname}" class="ft-exit">Exit Test Mode</a>
            </div>
        </div>
        <div class="ft-summary" id="ft-summary"></div>
        <div class="ft-table-wrap">
            <table class="ft-table">
                <thead>
                    <tr>
                        <th>Zone</th>
                        <th>Facility</th>
                        <th>Facility ID</th>
                        <th>Adviser</th>
                        <th>Live Status</th>
                        <th>Active Incident</th>
                        <th>Incident Type</th>
                        <th>Reported At</th>
                        <th>Corresponds?</th>
                        <th>Test Tools</th>
                    </tr>
                </thead>
                <tbody id="ft-table-body"></tbody>
            </table>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById("ft-export-csv").addEventListener("click", exportCsv);
    document.getElementById("ft-export-xlsx").addEventListener("click", exportXlsx);
    document.getElementById("ft-reset-test-data").addEventListener("click", resetAllTestData);
}

/* ==========================================================================
   ROW MODEL
========================================================================== */
function buildRows() {
    return SCHOOL_FACILITIES.map((facility) => {
        const classroom = classroomsCache[facility.id] || {};
        const emergency = !!classroom.emergency;
        const activeIncidentKey = classroom.activeIncidentKey || null;
        const incident = activeIncidentKey ? incidentsCache[activeIncidentKey] : null;

        // "Corresponds" check: if the facility is flagged emergency, there
        // MUST be a real incident record pointed at by activeIncidentKey,
        // and that incident's own `classroom` name should match this
        // facility's display name. Any break in that chain is exactly the
        // kind of bug this test view exists to catch.
        let corresponds = "n/a";
        if (emergency) {
            if (!activeIncidentKey || !incident) {
                corresponds = "MISMATCH (no incident record)";
            } else if (incident.classroom !== displayFacilityName(facility.name)) {
                corresponds = `MISMATCH (incident says "${incident.classroom}")`;
            } else {
                corresponds = "OK";
            }
        }

        return {
            facility,
            emergency,
            activeIncidentKey,
            incident,
            corresponds
        };
    });
}

/* ==========================================================================
   RENDER
========================================================================== */
function renderTable() {
    const rows = buildRows();
    const tbody = document.getElementById("ft-table-body");
    if (!tbody) return;

    const activeCount = rows.filter((r) => r.emergency).length;
    const mismatchCount = rows.filter((r) => r.corresponds.startsWith("MISMATCH")).length;
    const testCount = rows.filter((r) => r.incident && r.incident.isTestData).length;

    const summary = document.getElementById("ft-summary");
    if (summary) {
        summary.innerHTML = `
            <span>${rows.length} facilities</span>
            <span class="${activeCount ? "ft-flag-warn" : ""}">${activeCount} currently in emergency</span>
            <span class="${mismatchCount ? "ft-flag-bad" : "ft-flag-good"}">${mismatchCount} mismatch${mismatchCount === 1 ? "" : "es"}</span>
            <span>${testCount} active test incident${testCount === 1 ? "" : "s"}</span>
        `;
    }

    tbody.innerHTML = rows.map((row) => rowToHtml(row)).join("");

    rows.forEach((row) => {
        const simBtn = tbody.querySelector(`[data-sim="${row.facility.id}"]`);
        const clearBtn = tbody.querySelector(`[data-clear="${row.facility.id}"]`);
        if (simBtn) simBtn.addEventListener("click", () => simulateIncident(row.facility));
        if (clearBtn) clearBtn.addEventListener("click", () => clearIncident(row));
    });
}

function rowToHtml(row) {
    const f = row.facility;
    const name = displayFacilityName(f.name);
    const reportedAt = row.incident && row.incident.timestamp
        ? new Date(row.incident.timestamp).toLocaleString()
        : "--";
    const incidentLabel = row.incident
        ? `${row.incident.incidentNumber || row.activeIncidentKey}${row.incident.isTestData ? " (TEST)" : ""}`
        : (row.activeIncidentKey || "--");
    const statusClass = row.emergency ? "ft-status-emergency" : "ft-status-safe";
    const correspondsClass = row.corresponds === "OK" ? "ft-flag-good"
        : row.corresponds.startsWith("MISMATCH") ? "ft-flag-bad" : "";

    return `
        <tr>
            <td>${escapeHtml(f.zone)}</td>
            <td>${escapeHtml(name)} <span class="ft-muted">(${escapeHtml(f.section || "")})</span></td>
            <td class="ft-mono">${escapeHtml(f.id)}</td>
            <td>${escapeHtml(f.adviser || "--")}</td>
            <td><span class="ft-badge ${statusClass}">${row.emergency ? "EMERGENCY" : "Safe"}</span></td>
            <td>${escapeHtml(incidentLabel)}</td>
            <td>${escapeHtml((row.incident && row.incident.incidentType) || "--")}</td>
            <td>${escapeHtml(reportedAt)}</td>
            <td class="${correspondsClass}">${escapeHtml(row.corresponds)}</td>
            <td class="ft-test-tools">
                ${row.emergency
                    ? `<button type="button" data-clear="${f.id}">Clear</button>`
                    : `<button type="button" data-sim="${f.id}">Simulate</button>`}
            </td>
        </tr>
    `;
}

function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
}

/* ==========================================================================
   TEST TOOLS — writes are ALWAYS tagged isTestData: true
========================================================================== */
async function simulateIncident(facility) {
    const facilityName = displayFacilityName(facility.name);
    const newIncidentRef = push(incidentsRootRef);

    await set(newIncidentRef, {
        incidentNumber: `TEST-${newIncidentRef.key.slice(-6)}`,
        timestamp: Date.now(),
        classroom: facilityName,
        status: "Active",
        incidentType: "Facilities Test",
        facilityId: facility.id,
        reportedVia: "facilities-test-mode",
        isTestData: true
    });

    await update(ref(database, `classrooms/${facility.id}`), {
        emergency: true,
        activeIncidentKey: newIncidentRef.key
    });

    triggerIncidentAlert(newIncidentRef.key);
}

async function clearIncident(row) {
    const facility = row.facility;

    if (row.activeIncidentKey) {
        const incidentRef = ref(database, `incidents/${row.activeIncidentKey}`);
        const snap = await get(incidentRef);
        const data = snap.val();
        if (data && data.isTestData) {
            // Test incident: just delete it outright.
            await remove(incidentRef);
        } else if (data) {
            // Real incident: don't destroy history, just resolve it.
            await update(incidentRef, { status: "Resolved", resolvedAt: Date.now() });
        }
    }

    await update(ref(database, `classrooms/${facility.id}`), {
        emergency: false,
        activeIncidentKey: null
    });
}

async function resetAllTestData() {
    const confirmed = window.confirm(
        "This removes every incident tagged isTestData and clears the emergency flag on any facility it set. Continue?"
    );
    if (!confirmed) return;

    const snap = await get(incidentsRootRef);
    const data = snap.val() || {};
    const testEntries = Object.entries(data).filter(([, inc]) => inc && inc.isTestData);

    for (const [key, inc] of testEntries) {
        await remove(ref(database, `incidents/${key}`));
        if (inc.facilityId) {
            await update(ref(database, `classrooms/${inc.facilityId}`), {
                emergency: false,
                activeIncidentKey: null
            });
        }
    }
}

/* ==========================================================================
   EXPORT — CSV (no dependency)
========================================================================== */
function rowsToAoa() {
    const header = [
        "Zone", "Facility", "Section", "Facility ID", "Adviser",
        "Live Status", "Active Incident", "Incident Type", "Reported At", "Corresponds?"
    ];
    const rows = buildRows().map((row) => [
        row.facility.zone,
        displayFacilityName(row.facility.name),
        row.facility.section || "",
        row.facility.id,
        row.facility.adviser || "",
        row.emergency ? "EMERGENCY" : "Safe",
        row.incident ? (row.incident.incidentNumber || row.activeIncidentKey) : (row.activeIncidentKey || ""),
        (row.incident && row.incident.incidentType) || "",
        row.incident && row.incident.timestamp ? new Date(row.incident.timestamp).toLocaleString() : "",
        row.corresponds
    ]);
    return [header, ...rows];
}

function exportCsv() {
    const aoa = rowsToAoa();
    const csv = aoa.map((line) => line.map(csvEscape).join(",")).join("\r\n");
    downloadBlob(csv, "facilities-test-export.csv", "text/csv;charset=utf-8;");
}

function csvEscape(value) {
    const str = String(value == null ? "" : value);
    if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
}

function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/* ==========================================================================
   EXPORT — Excel (.xlsx) via SheetJS, lazy-loaded from CDN on first use
========================================================================== */
function loadSheetJs() {
    if (window.XLSX) return Promise.resolve();
    if (sheetJsLoadPromise) return sheetJsLoadPromise;

    sheetJsLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Could not load the Excel export library (offline?)."));
        document.head.appendChild(script);
    });
    return sheetJsLoadPromise;
}

async function exportXlsx() {
    const btn = document.getElementById("ft-export-xlsx");
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Loading...";
    try {
        await loadSheetJs();
        const aoa = rowsToAoa();
        const worksheet = window.XLSX.utils.aoa_to_sheet(aoa);
        const workbook = window.XLSX.utils.book_new();
        window.XLSX.utils.book_append_sheet(workbook, worksheet, "Facilities Test");
        window.XLSX.writeFile(workbook, "facilities-test-export.xlsx");
    } catch (error) {
        window.alert(error.message || "Excel export failed.");
    } finally {
        btn.disabled = false;
        btn.textContent = originalLabel;
    }
}
