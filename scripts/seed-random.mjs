#!/usr/bin/env node
/* ==========================================================================
   RESCUEPRIORITY — RANDOMIZED TEST DATASET SEED SCRIPT (JULY -> AUGUST)
   --------------------------------------------------------------------------
   Renamed from seed-random-july-august.mjs. Companion to seed-trend.mjs.
   Where the trend script produces a deliberate, readable rising/repeating
   pattern, this one is the opposite on purpose: a fixed pool of --total
   incidents (default 186, EXACT — not "near") gets scattered onto RANDOM
   days across JULY 1 - AUGUST 31 (62 days), RANDOM FACILITIES across the
   WHOLE CAMPUS (all 55 facilities — every classroom AND every office/
   support facility: Facility Rooms, Comfort Rooms, Library, Clinic,
   Canteen, Home Economics, SSIG Office, Principal's Office, Science Lab,
   Computer Lab — not just a handful of classrooms), and at RANDOM times.
   No visible pattern — some days get several incidents, some get none,
   some facilities get many, some get none — closer to what noisy
   real-world data looks like.

   WHY THIS ONE HITS THE TOTAL EXACTLY (the trend script doesn't)
   The trend script fixes a COUNT PER DAY (a cycle) and lets the total fall
   out of that, which only lines up with a target total by coincidence.
   This script does the opposite: it fixes the TOTAL first (--total=186)
   and randomly assigns each of those incidents a day and facility in the
   window — so the total is exact by construction, at the cost of not
   having a deliberate per-day or per-facility shape.

   Reproducible on request: pass --seed=<anything> to get the exact same
   "random" dataset again later; omit it and a fresh seed is generated and
   printed each run.

   What it does, in order:
     1. Reads the CURRENT /incidents node from Realtime Database.
     2. Writes it, verbatim, to a local JSON file under ./backups/ — this
        happens on every run, even a dry run, before anything else.
     3. Generates exactly --total (default 186) synthetic "Resolved"
        incident records, each landing on a random day in July 1 - August
        31 and a random one of the 55 campus facilities.
     4. Prints a dry-run summary and STOPS, unless you pass --confirm.
     5. Only with --confirm: deletes EVERYTHING currently under /incidents
        (regardless of which script wrote it — TEST_, TRND_, RAND_, or
        anything else) and writes only this run's fresh synthetic set, so
        the database always reflects just the one dataset you most
        recently seeded. Pass --keep-others to go back to the narrower
        behavior (delete only this script's own RAND_ keys, leave
        everything else alone) if you ever want to layer datasets.

   USAGE
     node seed-random.mjs                       # dry run
     node seed-random.mjs --confirm                # wipes
                                                     # /incidents,
                                                     # writes fresh
     node seed-random.mjs --confirm --year=2027
     node seed-random.mjs --confirm --total=200
     node seed-random.mjs --confirm --seed=demo1   # reproducible
     node seed-random.mjs --confirm --keep-others   # don't touch
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
    // Track how many incidents have already landed on a given (date, facility)
    // pair, purely so generated keys stay unique.
    const seenPerDayFacility = {};

    for (let seq = 1; seq <= total; seq++) {
        const dayIndex = randInt(0, dates.length - 1);
        const dateStr = dates[dayIndex];
        const facility = pick(FACILITIES);
        const grade = parseGrade(facility.section);
        const incidentType = pick(INCIDENT_TYPES);

        dailyCounts[dayIndex] += 1;

        const dayFacilityKey = `${dateStr}-${facility.id}`;
        const occurrence = (seenPerDayFacility[dayFacilityKey] || 0) + 1;
        seenPerDayFacility[dayFacilityKey] = occurrence;

        const submitMinute = randInt(SCHOOL_HOURS_START_MIN, SCHOOL_HOURS_END_MIN - 1);
        const submittedHHMM = minutesToHHMM(submitMinute);
        const timestamp = buildManilaTimestamp(dateStr, submittedHHMM);

        const resolutionMinutes = randInt(5, 119);
        const resolvedAt = timestamp + resolutionMinutes * 60 * 1000;

        const studentId = `RAND-STU-${pad(seq, 4)}`;
        const incidentNumber = `RAND #${pad(seq, 3)}`;
        const key = `${KEY_PREFIX}_${dateStr.replace(/-/g, "")}_${facility.id}_${pad(occurrence)}`;

        // NOTE: field set below is exactly what database.rules.json allows
        // for incidents/$incidentKey — no extra fields.
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
            reportedVia: "seed-script-random-data",
            isTestData: true,
            facilityId: facility.id,
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
    console.log(`Total incidents: exactly ${TOTAL}, randomly scattered across the window and ${FACILITIES.length} campus-wide facilities`);
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
    const byFacility = {};
    Object.values(dataset).forEach((r) => {
        byFacility[r.classroom] = (byFacility[r.classroom] || 0) + 1;
    });
    const facilitiesTouched = Object.keys(
        Object.values(dataset).reduce((acc, r) => {
            acc[r.facilityId] = true;
            return acc;
        }, {})
    ).length;

    console.log(`Generated ${newCount} synthetic record(s) across ${dates.length}-day window (${byDay.length} day(s) had at least 1).`);
    console.log(`Facilities touched: ${facilitiesTouched} of ${FACILITIES.length} campus-wide facilities.`);
    console.log("Days with incidents:", byDay.join(" | ") || "(none)");
    console.log("Breakdown by facility display name (note: some names like F.R./C.R. are shared by multiple distinct facilityIds):", byFacility);
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
    console.log(`  Spread across ${facilitiesTouched} of ${FACILITIES.length} campus-wide facilities`);
}

main().catch((err) => {
    console.error("Seed script failed:", err);
    process.exit(1);
});
