#!/usr/bin/env node
/* ==========================================================================
   RESCUEPRIORITY — TREND TEST DATASET SEED SCRIPT (JUNE -> JULY, VARIANT B)
   --------------------------------------------------------------------------
   Companion to seed-trend-june-july.mjs. Same everything — same rooms, same
   cycling daily-count trend, same record shape, same safety model — with
   two intentional tweaks so this dataset is visibly DIFFERENT from the
   original when compared side by side:

     1. RESOLUTION TIMES are shifted to a different range (15-104 min
        instead of 5-120 min), so the resolution-time trend line for this
        dataset doesn't overlap the original's.
     2. TIME OF DAY is clustered in the AFTERNOON instead of spread across
        the full school day — submissions now land within a tight ~3 hour
        window (12:00 PM - 3:00 PM) instead of 7:30 AM - 4:00 PM, so most
        incidents bunch closely together in the afternoon.

   Everything else — the [1,2,3,4,5]-repeating daily cycle, the 61-day
   June 1 - July 31 window, the 6 rotating rooms, incident types, key
   prefix, dry-run/--confirm/--keep-others/--top-up behavior — is unchanged
   from the original script.

   ~186 RECORDS, NOT EXACTLY 186
   Same as the original: with the default cycle [1,2,3,4,5] over the 61-day
   window, the natural total lands at 181. Pass --target=186 --top-up if you
   need the exact number (pads the final day only).

   What it does, in order:
     1. Reads the CURRENT /incidents node from Realtime Database.
     2. Writes it, verbatim, to a local JSON file under ./backups/ — this
        happens on every run, even a dry run, before anything else.
     3. Generates synthetic "Resolved" incident records across June 1 -
        July 31 (default), one cycle-controlled count per day, rotating
        through the 6 classrooms so every room gets a turn.
     4. Prints a dry-run summary and STOPS, unless you pass --confirm.
     5. Only with --confirm: deletes EVERYTHING currently under /incidents
        (regardless of which script wrote it — TEST_, TRND_, RAND_, or
        anything else) and writes only this run's fresh synthetic set, so
        the database always reflects just the one dataset you most
        recently seeded. Pass --keep-others to go back to the narrower
        behavior (delete only this script's own TRND_ keys, leave
        everything else alone) if you ever want to layer datasets.

   USAGE
     node seed-trend-june-july-morning.mjs                   # dry run
     node seed-trend-june-july-morning.mjs --confirm          # wipes /incidents,
                                                                # writes fresh set
     node seed-trend-june-july-morning.mjs --confirm --year=2027
     node seed-trend-june-july-morning.mjs --confirm --cycle=1,2,3
     node seed-trend-june-july-morning.mjs --confirm --target=186 --top-up
     node seed-trend-june-july-morning.mjs --confirm --keep-others
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
   DENIED. The fields below are exactly the set the rules allow. Do not
   add extra fields here without adding them to database.rules.json first.

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
   DATASET DESIGN — the 6 rooms, mapped to the REAL facility IDs from
   facilities.js (7-A, 8-A, 9-A OFFICE, 10-A, 11-AMARANTH, 12-SAPPHIRE).
========================================================================== */
const ROOMS = [
    { grade: 7, room: "7-A", facilityId: "left-7a" },
    { grade: 8, room: "8-A", facilityId: "right-8a" },
    { grade: 9, room: "9-A OFFICE", facilityId: "bottom-9a" },
    { grade: 10, room: "10-A", facilityId: "bottom-10a" },
    { grade: 11, room: "11-AMARANTH", facilityId: "shs1-amaranth" },
    { grade: 12, room: "12-SAPPHIRE", facilityId: "shs1-sapphire" }
];

const INCIDENT_TYPES = ["Medical", "Security", "Accident", "Fire/Smoke", "Other"];
const KEY_PREFIX = "TRND";

// TWEAK #2: instead of spreading submissions across the whole school day
// (7:30 AM - 4:00 PM), this variant clusters them into a tight ~3 hour
// afternoon window so most incidents land close together in time.
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

function roomSlug(room) {
    return room.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// Deterministic-ish pseudo-random in [0,1) seeded by a string, so re-running
// the script for the same date/room/day produces the same time-of-day.
// Salted differently from the original script (extra "-morning" suffix
// below) so this variant doesn't just reproduce the same numbers.
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
    let roomCursor = 0; // rotates across ALL days so the trend visibly moves
                         // through every classroom rather than always
                         // starting back at 7-A each day

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
            const roomDef = ROOMS[roomCursor % ROOMS.length];
            roomCursor += 1;

            const typeIndex = (dayIndex + i) % INCIDENT_TYPES.length;
            const incidentType = INCIDENT_TYPES[typeIndex];

            const seedBase = `${dateStr}-${roomDef.room}-${i}-morning`;

            // TWEAK #2: submission time now drawn from the tight afternoon
            // window instead of the full school day, so times cluster
            // closely together (within the ~3 hour band).
            const submitMinute =
                AFTERNOON_WINDOW_START_MIN +
                Math.floor(seededRandom(seedBase + "-t") * (AFTERNOON_WINDOW_END_MIN - AFTERNOON_WINDOW_START_MIN));
            const submittedHHMM = minutesToHHMM(submitMinute);
            const timestamp = buildManilaTimestamp(dateStr, submittedHHMM);

            // TWEAK #1: resolution time shifted to a different range
            // (15-104 min) than the original script (5-120 min), so this
            // dataset's resolution-time trend is visibly different.
            const resolutionMinutes = 15 + Math.floor(seededRandom(seedBase + "-r") * 90);
            const resolvedAt = timestamp + resolutionMinutes * 60 * 1000;

            const studentId = `TREND-STU-${pad(seq, 4)}`;
            const incidentNumber = `TREND #${pad(seq, 3)}`;
            const key = `${KEY_PREFIX}_${dateStr.replace(/-/g, "")}_${roomSlug(roomDef.room)}_${pad(i + 1)}`;

            // NOTE: field set below is exactly what database.rules.json
            // allows for incidents/$incidentKey — no extra fields.
            records[key] = {
                incidentNumber,
                timestamp,
                classroom: roomDef.room,
                grade: roomDef.grade,
                status: "Resolved",
                resolvedAt,
                studentId,
                studentName: "Test Student",
                incidentType,
                roomWide: false,
                description: null,
                reportedVia: "seed-script-trend-data",
                isTestData: true,
                facilityId: roomDef.facilityId,
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
    console.log(`RescuePriority TREND test-data seed script (June -> July, variant B)`);
    console.log(`Target DB: ${firebaseConfig.databaseURL}`);
    console.log(`Window: ${YEAR}-06-01 through ${YEAR}-07-31 (61 days, Asia/Manila)`);
    console.log(`Cycle: [${CYCLE.join(", ")}] incident(s)/day, repeating`);
    console.log(`Time of day: clustered 12:00 PM - 3:00 PM (afternoon, ~3hr spread)`);
    console.log(`Resolution time: 15-104 min (shifted from the original 5-120 min)`);
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
    const backupPath = path.join(backupsDir, `incidents-backup-trend-junejuly-morning-${nowIso}.json`);

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

    console.log(`Generated ${newCount} synthetic record(s) across ${dates.length} day(s) (target ~${TARGET_TOTAL}).`);
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
}

main().catch((err) => {
    console.error("Seed script failed:", err);
    process.exit(1);
});
