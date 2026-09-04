#!/usr/bin/env node
/* ==========================================================================
   RESCUEPRIORITY — RANDOMIZED TEST DATASET SEED SCRIPT (JULY -> AUGUST)
   --------------------------------------------------------------------------
   Companion to seed-test-incidents.mjs and seed-trend-june-july.mjs. Where
   the trend script produces a deliberate, readable rising/repeating
   pattern, this one is the opposite on purpose: a fixed pool of --total
   incidents (default 186, EXACT — not "near") gets scattered onto RANDOM
   days across JULY 1 - AUGUST 31 (62 days) and RANDOM classrooms at RANDOM
   times. No visible pattern — some days get several incidents, some get
   none — closer to what noisy real-world data looks like.

   WHY THIS ONE HITS THE TOTAL EXACTLY (the trend script doesn't)
   The trend script fixes a COUNT PER DAY (a cycle) and lets the total fall
   out of that, which only lines up with a target total by coincidence.
   This script does the opposite: it fixes the TOTAL first (--total=186)
   and randomly assigns each of those incidents a day in the window — so
   the total is exact by construction, at the cost of not having a
   deliberate per-day shape.

   Reproducible on request: pass --seed=<anything> to get the exact same
   "random" dataset again later; omit it and a fresh seed is generated and
   printed each run.

   What it does, in order:
     1. Reads the CURRENT /incidents node from Realtime Database.
     2. Writes it, verbatim, to a local JSON file under ./backups/ — this
        happens on every run, even a dry run, before anything else.
     3. Generates exactly --total (default 186) synthetic "Resolved"
        incident records, each landing on a random day in July 1 - August
        31 and a random one of the 6 classrooms.
     4. Prints a dry-run summary and STOPS, unless you pass --confirm.
     5. Only with --confirm: deletes EVERYTHING currently under /incidents
        (regardless of which script wrote it — TEST_, TRND_, RAND_, or
        anything else) and writes only this run's fresh synthetic set, so
        the database always reflects just the one dataset you most
        recently seeded. Pass --keep-others to go back to the narrower
        behavior (delete only this script's own RAND_ keys, leave
        everything else alone) if you ever want to layer datasets.

   USAGE
     node seed-random-july-august.mjs                       # dry run
     node seed-random-july-august.mjs --confirm                # wipes
                                                                 # /incidents,
                                                                 # writes fresh
     node seed-random-july-august.mjs --confirm --year=2027
     node seed-random-july-august.mjs --confirm --total=200
     node seed-random-july-august.mjs --confirm --seed=demo1   # reproducible
     node seed-random-july-august.mjs --confirm --keep-others   # don't touch
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
   On --confirm, this clears ALL of /incidents (not just its own RAND_
   keys) before writing, so each run leaves the database holding exactly
   one dataset — whichever you ran last. That includes real, non-test data
   if there's any in there, so double-check which Firebase project you're
   pointed at before confirming (see above). Pass --keep-others if you want
   this run to leave existing data (including the trend script's) alone
   and only manage its own RAND_ keys.
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
const KEY_PREFIX = "RAND";

const SCHOOL_HOURS_START_MIN = 7 * 60 + 30; // 7:30 AM
const SCHOOL_HOURS_END_MIN = 16 * 60;       // 4:00 PM
const MANILA_UTC_OFFSET = "+08:00";         // no DST

/* ==========================================================================
   CLI ARGS
========================================================================== */
const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");
const KEEP_OTHERS = args.includes("--keep-others");

const yearArg = args.find((a) => a.startsWith("--year="));
const YEAR = yearArg ? parseInt(yearArg.split("=")[1], 10) : new Date().getFullYear();

const totalArg = args.find((a) => a.startsWith("--total="));
const TOTAL = totalArg ? parseInt(totalArg.split("=")[1], 10) : 186;

const seedArg = args.find((a) => a.startsWith("--seed="));
const RUN_SEED = seedArg ? seedArg.split("=")[1] : `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/* ==========================================================================
   HELPERS
========================================================================== */
function pad(n, width = 2) {
    return String(n).padStart(width, "0");
}

function roomSlug(room) {
    return room.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// mulberry32: small, fast seeded PRNG. Same seed -> same full sequence, so
// --seed=whatever reproduces an entire run.
function mulberry32(seedStr) {
    let h = 0;
    for (let i = 0; i < seedStr.length; i++) {
        h = Math.imul(h ^ seedStr.charCodeAt(i), 2654435761);
    }
    let state = h >>> 0;
    return function () {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const rand = mulberry32(RUN_SEED);

function randInt(min, max) {
    // inclusive of both ends
    return min + Math.floor(rand() * (max - min + 1));
}

function pick(arr) {
    return arr[Math.floor(rand() * arr.length)];
}

function minutesToHHMM(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${pad(h)}:${pad(m)}`;
}

function buildManilaTimestamp(dateStr, hhmm) {
    return new Date(`${dateStr}T${hhmm}:00${MANILA_UTC_OFFSET}`).getTime();
}

function daysInJulyAugust(year) {
    // July 1 inclusive .. August 31 inclusive = 62 days.
    const out = [];
    for (let d = 1; d <= 31; d++) out.push(`${year}-07-${pad(d)}`);
    for (let d = 1; d <= 31; d++) out.push(`${year}-08-${pad(d)}`);
    return out;
}

/* ==========================================================================
   DATASET GENERATION
========================================================================== */
function generateDataset(year, total) {
    const dates = daysInJulyAugust(year);
    const records = {};
    const dailyCounts = new Array(dates.length).fill(0);
    // Track how many incidents have already landed on a given (date, room)
    // pair, purely so generated keys stay unique.
    const seenPerDayRoom = {};

    for (let seq = 1; seq <= total; seq++) {
        const dayIndex = randInt(0, dates.length - 1);
        const dateStr = dates[dayIndex];
        const roomDef = pick(ROOMS);
        const incidentType = pick(INCIDENT_TYPES);

        dailyCounts[dayIndex] += 1;

        const dayRoomKey = `${dateStr}-${roomDef.room}`;
        const occurrence = (seenPerDayRoom[dayRoomKey] || 0) + 1;
        seenPerDayRoom[dayRoomKey] = occurrence;

        const submitMinute = randInt(SCHOOL_HOURS_START_MIN, SCHOOL_HOURS_END_MIN - 1);
        const submittedHHMM = minutesToHHMM(submitMinute);
        const timestamp = buildManilaTimestamp(dateStr, submittedHHMM);

        const resolutionMinutes = randInt(5, 119);
        const resolvedAt = timestamp + resolutionMinutes * 60 * 1000;

        const studentId = `RAND-STU-${pad(seq, 4)}`;
        const incidentNumber = `RAND #${pad(seq, 3)}`;
        const key = `${KEY_PREFIX}_${dateStr.replace(/-/g, "")}_${roomSlug(roomDef.room)}_${pad(occurrence)}`;

        // NOTE: field set below is exactly what database.rules.json allows
        // for incidents/$incidentKey — no extra fields.
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
            reportedVia: "seed-script-random-data",
            isTestData: true,
            facilityId: roomDef.facilityId,
            locationOverridden: false
        };
    }

    return { records, dates, dailyCounts };
}

/* ==========================================================================
   MAIN
========================================================================== */
async function main() {
    console.log(`RescuePriority RANDOM test-data seed script (July -> August)`);
    console.log(`Target DB: ${firebaseConfig.databaseURL}`);
    console.log(`Window: ${YEAR}-07-01 through ${YEAR}-08-31 (62 days, Asia/Manila)`);
    console.log(`Total incidents: exactly ${TOTAL}, randomly scattered across the window and rooms`);
    console.log(`Run seed: ${RUN_SEED}  (pass --seed=${RUN_SEED} later to reproduce this exact dataset)`);
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
    const backupPath = path.join(backupsDir, `incidents-backup-random-julyaug-${nowIso}.json`);

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
    const { records: dataset, dates, dailyCounts } = generateDataset(YEAR, TOTAL);
    const newCount = Object.keys(dataset).length;
    const byDay = dates
        .map((d, i) => `${d}: ${dailyCounts[i]}`)
        .filter((_, i) => dailyCounts[i] > 0);
    const byRoom = {};
    Object.values(dataset).forEach((r) => {
        byRoom[r.classroom] = (byRoom[r.classroom] || 0) + 1;
    });

    console.log(`Generated ${newCount} synthetic record(s) across ${dates.length}-day window (${byDay.length} day(s) had at least 1).`);
    console.log("Days with incidents:", byDay.join(" | ") || "(none)");
    console.log("Breakdown by classroom:", byRoom);
    console.log("Sample record:", newCount ? JSON.stringify(Object.values(dataset)[0], null, 2) : "(none)");
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
    console.log(`  New record count: ${newCount} (${YEAR}-07-01 to ${YEAR}-08-31, seed "${RUN_SEED}")`);
    console.log(`  All new records: status "Resolved", reportedVia "seed-script-random-data", isTestData: true`);
}

main().catch((err) => {
    console.error("Seed script failed:", err);
    process.exit(1);
});
