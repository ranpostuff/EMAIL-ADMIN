#!/usr/bin/env node
/* ==========================================================================
   RESCUEPRIORITY — TREND TEST DATASET SEED SCRIPT (JUNE -> JULY)
   --------------------------------------------------------------------------
   Renamed from seed-trend-june-july-morning.mjs. Companion to
   seed-random.mjs. Same repeating daily-count cycle, same record shape,
   same safety model as before — but now rotates through ALL 55 campus
   facilities (every classroom AND every office/support facility:
   Facility Rooms, Comfort Rooms, Library, Clinic, Canteen, Home
   Economics, SSIG Office, Principal's Office, Science Lab, Computer Lab)
   instead of just 6 classrooms, so the deliberate rising/repeating
   pattern this script is built to demonstrate is visible campus-wide,
   not confined to a handful of rooms.

   NOTE ON THE NAME: this file was previously named "...-morning.mjs" but
   the code has always clustered submissions in the AFTERNOON window
   (12:00 PM - 3:00 PM) — that mismatch existed in the original file too.
   Left as-is here since only the location spread was asked to change;
   flag if you'd like the window itself adjusted to actually be morning.

   Two intentional tweaks carried over from the "-morning" variant so this
   dataset stays visibly DIFFERENT from a plain default trend run:
     1. RESOLUTION TIMES are shifted to 15-104 min (instead of 5-120 min),
        so the resolution-time trend line for this dataset doesn't overlap
        a default run's.
     2. TIME OF DAY is clustered into a tight ~3 hour window (12:00 PM -
        3:00 PM) instead of spread across the full school day, so most
        incidents bunch closely together in the afternoon.

   ~186 RECORDS, NOT EXACTLY 186
   With the default cycle [1,2,3,4,5] over the 61-day window, the natural
   total lands at 181. Pass --target=186 --top-up if you need the exact
   number (pads the final day only).

   What it does, in order:
     1. Reads the CURRENT /incidents node from Realtime Database.
     2. Writes it, verbatim, to a local JSON file under ./backups/ — this
        happens on every run, even a dry run, before anything else.
     3. Generates synthetic "Resolved" incident records across June 1 -
        July 31 (default), one cycle-controlled count per day, rotating
        through all 55 campus facilities so every facility gets a turn.
     4. Prints a dry-run summary and STOPS, unless you pass --confirm.
     5. Only with --confirm: deletes EVERYTHING currently under /incidents
        (regardless of which script wrote it — TEST_, TRND_, RAND_, or
        anything else) and writes only this run's fresh synthetic set, so
        the database always reflects just the one dataset you most
        recently seeded. Pass --keep-others to go back to the narrower
        behavior (delete only this script's own TRND_ keys, leave
        everything else alone) if you ever want to layer datasets.

   USAGE
     node seed-trend.mjs                   # dry run
     node seed-trend.mjs --confirm          # wipes /incidents,
                                             # writes fresh set
     node seed-trend.mjs --confirm --year=2027
     node seed-trend.mjs --confirm --cycle=1,2,3
     node seed-trend.mjs --confirm --target=186 --top-up
     node seed-trend.mjs --confirm --keep-others
                                             # don't touch
                                             # other scripts'
                                             # existing data

   IMPORTANT — READ BEFORE RUNNING
   This talks to the SAME Firebase Realtime Database the deployed student
   app and admin dashboard use (firebaseConfig below, copied from app.js /
   script.js). Before running with --confirm, confirm which project this is
   (school-alert-system-8f211) and whether it currently holds real incident
   reports. If there's any chance it does, point firebaseConfig at a
   separate test project instead. The backup step always runs first, but it
   only protects you if you check it before confirming.

   RECORD SHAPE — MUST MATCH database.rules.json EXACTLY
   This project's deployed rules validate incidents/$incidentKey with
   "$other": { ".validate": false } — meaning ANY field not explicitly
   listed in the rules gets the whole write rejected with PERMISSION_
   DENIED. The fields below are exactly the same set the original 6-room
   version used (nothing added or removed) — only the pool of facilities
   each record can land on has changed. Do not add extra fields here
   without adding them to database.rules.json first.

   DEFAULT DELETE SCOPE — FULL WIPE, LIKE seed-test-incidents.mjs
   On --confirm, this clears ALL of /incidents (not just its own TRND_
   keys) before writing, so each run leaves the database holding exactly
   one dataset — whichever you ran last. That includes real, non-test data
   if there's any in there, so double-check which Firebase project you're
   pointed at before confirming (see above). Pass --keep-others if you want
   this run to leave existing data (including the random script's) alone
   and only manage its own TRND_ keys.
========================================================================== */

import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, update } from "firebase/database";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* Same public client config used throughout the rest of the project
   (student app.js and admin script.js). Not a secret by itself — access is
   governed entirely by database.rules.json. */
const firebaseConfig = {
    apiKey: "AIzaSyDHPzeyaEtVvEvnH1Va81i24tpiCX8Gx-8",
    authDomain: "school-alert-system-8f211.firebaseapp.com",
    databaseURL: "https://school-alert-system-8f211-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "school-alert-system-8f211",
    storageBucket: "school-alert-system-8f211.firebasestorage.app",
    messagingSenderId: "568204675808",
    appId: "1:568204675808:web:1ca3536d31b7dc5db45e85",
    measurementId: "G-JT58NQCRMQ"
};

/* ==========================================================================
   DATASET DESIGN — ALL 55 campus facilities, copied verbatim from
   SCHOOL_FACILITIES in script.js (Top Wing, Left Wing, Right Wing, Bottom
   Wing, SHS Building 1, SHS Building 2). This intentionally includes
   non-classroom facilities (Facility Rooms, Comfort Rooms, Library,
   Clinic, Canteen, Home Economics, SSIG Office, Principal's Office,
   Science Lab, Computer Lab) — not just classrooms — per the campus-wide
   spread this script is meant to test.

   grade is DERIVED at runtime from each facility's `section` string (e.g.
   "Grade 11 Garnet" -> 11, "Grade 9-E" -> 9). Non-classroom facilities
   (section does NOT start with "Grade ") get grade: null, same as how
   description is already null for every record — the rules already
   accept null for optional fields.

   Order below is preserved from SCHOOL_FACILITIES on purpose: the trend
   script rotates through this array in order, so the fixed order is what
   makes the rotation move through the campus in a stable, repeatable
   sequence (wing by wing) rather than jumping around.
========================================================================== */
const FACILITIES = [
    // Top Wing
    { id: "top-fr-1", name: "F.R.", section: "Facility Room" },
    { id: "top-fr-2", name: "F.R.", section: "Facility Room" },
    { id: "top-9e", name: "9-E", section: "Grade 9-E" },
    { id: "top-10b", name: "10-B", section: "Grade 10-B" },
    { id: "top-10c", name: "10-C", section: "Grade 10-C" },
    { id: "top-10d", name: "10-D", section: "Grade 10-D" },
    { id: "top-cr-1", name: "C.R.", section: "Comfort Room" },
    { id: "top-fr-3", name: "F.R.", section: "Facility Room" },
    { id: "top-8f", name: "8-F", section: "Grade 8-F" },
    { id: "top-9c", name: "9-C", section: "Grade 9-C" },
    { id: "top-8b", name: "8-B", section: "Grade 8-B" },
    { id: "top-8d", name: "8-D", section: "Grade 8-D" },
    { id: "top-lib", name: "LIB.", section: "Library" },
    { id: "top-clinic", name: "CLINIC", section: "Medical Clinic" },
    { id: "top-fr-4", name: "F.R.", section: "Facility Room" },

    // Left Wing
    { id: "left-10e", name: "10-E", section: "Grade 10-E" },
    { id: "left-9b", name: "9-B", section: "Grade 9-B" },
    { id: "left-9d", name: "9-D", section: "Grade 9-D" },
    { id: "left-8e", name: "8-E", section: "Grade 8-E" },
    { id: "left-fr", name: "F.R.", section: "Facility Room" },
    { id: "left-canteen", name: "CANTEEN", section: "Food Services" },
    { id: "left-cr", name: "C.R.", section: "Comfort Room" },
    { id: "left-garnet", name: "11-GARNET", section: "Grade 11 Garnet" },
    { id: "left-fedorite", name: "12-FEDORITE", section: "Grade 12 Fedorite" },
    { id: "left-7a", name: "7-A", section: "Grade 7-A" },
    { id: "left-euclase", name: "12-EUCLASE", section: "Grade 12 Euclase" },
    { id: "left-ebony", name: "11-EBONY", section: "Grade 11 Ebony" },

    // Right Wing
    { id: "right-8c", name: "8-C", section: "Grade 8-C" },
    { id: "right-8a", name: "8-A", section: "Grade 8-A" },
    { id: "right-he", name: "H.E.", section: "Home Economics" },
    { id: "right-7f", name: "7-F", section: "Grade 7-F" },
    { id: "right-7c", name: "7-C", section: "Grade 7-C" },
    { id: "right-7e", name: "7-E", section: "Grade 7-E" },
    { id: "right-7b", name: "7-B", section: "Grade 7-B" },
    { id: "right-ssig", name: "SSIG OFFICE", section: "SSIG" },

    // Bottom Wing
    { id: "bottom-10a", name: "10-A", section: "Grade 10-A" },
    { id: "bottom-9a", name: "9-A OFFICE", section: "Grade 9-A" },
    { id: "bottom-po", name: "P. OFFICE", section: "Administration" },
    { id: "bottom-7d", name: "7-D", section: "Grade 7-D" },

    // SHS Building 1
    { id: "shs1-sapphire", name: "12-SAPPHIRE", section: "Grade 12 Sapphire" },
    { id: "shs1-sci", name: "SCIENCE LAB", section: "Laboratory" },
    { id: "shs1-amethyst", name: "12-AMETHYST", section: "Grade 12 Amethyst" },
    { id: "shs1-amaranth", name: "11-AMARANTH", section: "Grade 11 Amaranth" },
    { id: "shs1-complab", name: "COMP LAB", section: "Computer Laboratory" },
    { id: "shs1-obsidian", name: "12-OBSIDIAN", section: "Grade 12 Obsidian" },
    { id: "shs1-honeydew", name: "11-HONEYDEW", section: "Grade 11 Honeydew" },
    { id: "shs1-epidote", name: "12-EPIDOTE", section: "Grade 12 Epidote" },

    // SHS Building 2
    { id: "shs2-fuschia", name: "11-FUSCHIA", section: "Grade 11 Fuschia" },
    { id: "shs2-driftwood", name: "11-DRIFTWOOD", section: "Grade 11 Driftwood" },
    { id: "shs2-emerald", name: "12-EMERALD", section: "Grade 12 Emerald" },
    { id: "shs2-cr1", name: "C.R.", section: "Comfort Room" },
    { id: "shs2-burgundy", name: "11-BURGUNDY", section: "Grade 11 Burgundy" },
    { id: "shs2-bloodstone", name: "12-BLOODSTONE", section: "Grade 12 Bloodstone" },
    { id: "shs2-cerulean", name: "11-CERULEAN", section: "Grade 11 Cerulean" },
    { id: "shs2-cr2", name: "C.R.", section: "Comfort Room" }
];

function parseGrade(section) {
    const match = /^Grade\s+(\d+)/.exec(section || "");
    return match ? parseInt(match[1], 10) : null;
}

const INCIDENT_TYPES = ["Medical", "Security", "Accident", "Fire/Smoke", "Other"];
const KEY_PREFIX = "TRND";

// Submissions clustered into a tight ~3 hour window instead of spread
// across the whole school day (7:30 AM - 4:00 PM), so most incidents
// bunch closely together in time. (See NOTE ON THE NAME above — this is
// labeled AFTERNOON because that's what the window actually is.)
const AFTERNOON_WINDOW_START_MIN = 12 * 60;      // 12:00 PM
const AFTERNOON_WINDOW_END_MIN = 12 * 60 + 3 * 60; // 3:00 PM (3-hour spread)
const MANILA_UTC_OFFSET = "+08:00";              // no DST

/* ==========================================================================
   CLI ARGS
========================================================================== */
const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");
const KEEP_OTHERS = args.includes("--keep-others");
const TOP_UP = args.includes("--top-up");

const yearArg = args.find((a) => a.startsWith("--year="));
const YEAR = yearArg ? parseInt(yearArg.split("=")[1], 10) : new Date().getFullYear();

const cycleArg = args.find((a) => a.startsWith("--cycle="));
const CYCLE = cycleArg
    ? cycleArg
          .split("=")[1]
          .split(",")
          .map((n) => parseInt(n, 10))
          .filter((n) => Number.isFinite(n) && n > 0)
    : [1, 2, 3, 4, 5]; // 1, 2, 3, 4, 5 incidents/day, then repeats

const targetArg = args.find((a) => a.startsWith("--target="));
const TARGET_TOTAL = targetArg ? parseInt(targetArg.split("=")[1], 10) : 186;

/* ==========================================================================
   HELPERS
========================================================================== */
function pad(n, width = 2) {
    return String(n).padStart(width, "0");
}

// Deterministic-ish pseudo-random in [0,1) seeded by a string, so re-running
// the script for the same date/facility/day produces the same time-of-day.
function seededRandom(seedStr) {
    let h = 0;
    for (let i = 0; i < seedStr.length; i++) {
        h = (h << 5) - h + seedStr.charCodeAt(i);
        h |= 0;
    }
    const x = Math.sin(h) * 10000;
    return x - Math.floor(x);
}

function minutesToHHMM(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${pad(h)}:${pad(m)}`;
}

function buildManilaTimestamp(dateStr, hhmm) {
    return new Date(`${dateStr}T${hhmm}:00${MANILA_UTC_OFFSET}`).getTime();
}

function daysInJuneJuly(year) {
    // June 1 inclusive .. July 31 inclusive = 61 days.
    const out = [];
    for (let d = 1; d <= 30; d++) out.push(`${year}-06-${pad(d)}`);
    for (let d = 1; d <= 31; d++) out.push(`${year}-07-${pad(d)}`);
    return out;
}

/* ==========================================================================
   DATASET GENERATION
========================================================================== */
function generateDataset(year, cycle, targetTotal, topUp) {
    const dates = daysInJuneJuly(year);
    const records = {};
    let seq = 0;
    let facilityCursor = 0; // rotates across ALL days so the trend visibly
                             // moves through every campus facility rather
                             // than always starting back at the first one
                             // each day

    // Base daily counts, straight from the repeating cycle.
    const dailyCounts = dates.map((_, dayIndex) => cycle[dayIndex % cycle.length]);

    // Optional exact top-up: pad the LAST day only, so the trend shape for
    // every other day stays untouched.
    let toppedUp = false;
    if (topUp) {
        const naturalTotal = dailyCounts.reduce((a, b) => a + b, 0);
        const deficit = targetTotal - naturalTotal;
        if (deficit !== 0) {
            const lastIdx = dailyCounts.length - 1;
            dailyCounts[lastIdx] = Math.max(0, dailyCounts[lastIdx] + deficit);
            toppedUp = true;
        }
    }

    dates.forEach((dateStr, dayIndex) => {
        const countToday = dailyCounts[dayIndex];

        for (let i = 0; i < countToday; i++) {
            seq += 1;
            const facility = FACILITIES[facilityCursor % FACILITIES.length];
            facilityCursor += 1;
            const grade = parseGrade(facility.section);

            const typeIndex = (dayIndex + i) % INCIDENT_TYPES.length;
            const incidentType = INCIDENT_TYPES[typeIndex];

            const seedBase = `${dateStr}-${facility.id}-${i}`;

            // Submission time drawn from the tight afternoon window so
            // times cluster closely together (within the ~3 hour band).
            const submitMinute =
                AFTERNOON_WINDOW_START_MIN +
                Math.floor(seededRandom(seedBase + "-t") * (AFTERNOON_WINDOW_END_MIN - AFTERNOON_WINDOW_START_MIN));
            const submittedHHMM = minutesToHHMM(submitMinute);
            const timestamp = buildManilaTimestamp(dateStr, submittedHHMM);

            // Resolution time shifted to 15-104 min (instead of a wider
            // 5-120 min range), so this dataset's resolution-time trend
            // is visibly different from a plain default run.
            const resolutionMinutes = 15 + Math.floor(seededRandom(seedBase + "-r") * 90);
            const resolvedAt = timestamp + resolutionMinutes * 60 * 1000;

            const studentId = `TREND-STU-${pad(seq, 4)}`;
            const incidentNumber = `TREND #${pad(seq, 3)}`;
            const key = `${KEY_PREFIX}_${dateStr.replace(/-/g, "")}_${facility.id}_${pad(i + 1)}`;

            // NOTE: field set below is exactly what database.rules.json
            // allows for incidents/$incidentKey — no extra fields.
            records[key] = {
                incidentNumber,
                timestamp,
                classroom: facility.name,
                grade,
                status: "Resolved",
                resolvedAt,
                studentId,
                studentName: "Test Student",
                incidentType,
                roomWide: false,
                description: null,
                reportedVia: "seed-script-trend-data",
                isTestData: true,
                facilityId: facility.id,
                locationOverridden: false
            };
        }
    });

    return { records, dates, dailyCounts, toppedUp };
}

/* ==========================================================================
   MAIN
========================================================================== */
async function main() {
    console.log(`RescuePriority TREND test-data seed script (June -> July)`);
    console.log(`Target DB: ${firebaseConfig.databaseURL}`);
    console.log(`Window: ${YEAR}-06-01 through ${YEAR}-07-31 (61 days, Asia/Manila)`);
    console.log(`Cycle: [${CYCLE.join(", ")}] incident(s)/day, repeating`);
    console.log(`Rotating through all ${FACILITIES.length} campus-wide facilities (classrooms + offices/support facilities)`);
    console.log(`Time of day: clustered 12:00 PM - 3:00 PM (afternoon, ~3hr spread)`);
    console.log(`Resolution time: 15-104 min (shifted from a wider 5-120 min default)`);
    console.log(TOP_UP ? `Top-up: ON — final day padded to hit exactly ${TARGET_TOTAL}` : `Top-up: off — natural cycle total, no padding`);
    console.log(CONFIRM ? "Mode: LIVE — will write to /incidents" : "Mode: DRY RUN — no writes, backup only");
    console.log(KEEP_OTHERS ? `Delete scope: only this script's own keys (prefix "${KEY_PREFIX}_")` : "Delete scope: ALL existing /incidents keys (default — see --keep-others)");
    console.log("");

    const app = initializeApp(firebaseConfig);
    const db = getDatabase(app);
    const incidentsRef = ref(db, "incidents");

    // --- 1 & 2: read + back up current data, always, no matter what ---
    console.log("Reading current /incidents ...");
    const snapshot = await get(incidentsRef);
    const currentData = snapshot.val() || {};
    const currentCount = Object.keys(currentData).length;

    const backupsDir = path.join(__dirname, "backups");
    if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true });

    const nowIso = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupsDir, `incidents-backup-trend-junejuly-${nowIso}.json`);

    writeFileSync(
        backupPath,
        JSON.stringify(
            {
                exportedAt: new Date().toISOString(),
                sourcePath: "incidents",
                sourceDatabase: firebaseConfig.databaseURL,
                recordCount: currentCount,
                data: currentData
            },
            null,
            2
        )
    );

    console.log(`Backed up ${currentCount} existing incident record(s) to:`);
    console.log(`  ${backupPath}`);
    console.log("");

    // --- 3: generate the new dataset ---
    const { records: dataset, dates, dailyCounts, toppedUp } = generateDataset(YEAR, CYCLE, TARGET_TOTAL, TOP_UP);
    const newCount = Object.keys(dataset).length;
    const byDay = dates.map((d, i) => `${d}: ${dailyCounts[i]}`);
    const facilitiesTouched = Object.keys(
        Object.values(dataset).reduce((acc, r) => {
            acc[r.facilityId] = true;
            return acc;
        }, {})
    ).length;

    console.log(`Generated ${newCount} synthetic record(s) across ${dates.length} day(s) (target ~${TARGET_TOTAL}).`);
    console.log(`Facilities touched: ${facilitiesTouched} of ${FACILITIES.length} campus-wide facilities.`);
    if (toppedUp) console.log(`Top-up applied: final day (${dates[dates.length - 1]}) adjusted to close the gap.`);
    console.log("Daily counts:", byDay.join(" | "));
    console.log("Sample record:", JSON.stringify(Object.values(dataset)[0], null, 2));
    console.log("");

    // --- 4 / 5: dry run vs confirmed write ---
    if (!CONFIRM) {
        console.log("Dry run complete. Nothing was written to Firebase.");
        console.log("Review the backup file above, then re-run with --confirm to write these records.");
        return;
    }

    console.log(`Writing ${newCount} synthetic record(s) ...`);

    const fanOutUpdate = {};
    if (KEEP_OTHERS) {
        Object.keys(currentData)
            .filter((key) => key.startsWith(`${KEY_PREFIX}_`))
            .forEach((key) => {
                fanOutUpdate[key] = null; // delete only this script's own prior keys
            });
    } else {
        Object.keys(currentData).forEach((key) => {
            fanOutUpdate[key] = null; // delete everything (default)
        });
    }
    Object.entries(dataset).forEach(([key, record]) => {
        fanOutUpdate[key] = record;
    });

    await update(incidentsRef, fanOutUpdate);
    console.log("Done.");
    console.log("");
    console.log("SUMMARY");
    console.log(`  Wrote to: /incidents at ${firebaseConfig.databaseURL}`);
    console.log(`  Previous ${currentCount} record(s) backed up to: ${backupPath}`);
    console.log(`  New record count: ${newCount} (${YEAR}-06-01 to ${YEAR}-07-31, cycle [${CYCLE.join(",")}])`);
    console.log(`  All new records: status "Resolved", reportedVia "seed-script-trend-data", isTestData: true`);
    console.log(`  Spread across ${facilitiesTouched} of ${FACILITIES.length} campus-wide facilities`);
}

main().catch((err) => {
    console.error("Seed script failed:", err);
    process.exit(1);
});
