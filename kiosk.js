/* ==========================================================================
   RESCUEPRIORITY — KIOSK DISPLAY MODULE
   --------------------------------------------------------------------------
   Standalone page, meant to be opened full-screen on a separate monitor
   (e.g. mounted at the gate next to the scanning device). It does NOT run
   inside the main app-shell SPA in index.html — it's opened directly, or
   via the "Kiosk Display" sidebar link which does window.open("kiosk.html").

   Read-only. Never writes to Firebase — it only listens to the same
   students/, sections/ and attendance/ trees that students.js and
   scan-attendance.js already own, so this file keeps its own small
   Firebase connection rather than importing those modules (which assume
   the full dashboard DOM exists).

   Flow: scan-attendance.js writes a new attendance/{pushKey} record on
   every successful scan -> this page listens for the latest one via
   limitToLast(1) -> looks up the matching student/section -> displays a
   big result card -> reverts to the idle screen after a few seconds.
========================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
    getDatabase,
    ref,
    query,
    orderByChild,
    limitToLast,
    startAt,
    onValue
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

/* Same public client config used in script.js — this is a Firebase Web SDK
   config (not a secret; access is governed by Firebase security rules,
   same as every other page in this app), duplicated here on purpose so
   this page has zero dependency on the main dashboard's module graph. */
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

const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

const studentsRootRef = ref(database, "students");
const sectionsRootRef = ref(database, "sections");
const attendanceRootRef = ref(database, "attendance");
const latestAttendanceQuery = query(attendanceRootRef, orderByChild("timestamp"), limitToLast(1));

/* How long the result card stays on screen before the kiosk reverts to
   the idle "ready to scan" state. */
const RESULT_DISPLAY_MS = 8000;

/* Punctuality cutoffs (school-local time, hours/minutes in 24h form).
   A student's FIRST "in" scan of the day is what's judged against the
   late cutoff — a later re-entry (e.g. back from an errand) shouldn't
   retroactively mark them late. The checkout cutoff is display-only
   context (shown as a note on OUT scans after that time); it does not
   change how anything is stored. */
const LATE_CUTOFF = { hour: 7, minute: 15 };
const CHECKOUT_CUTOFF = { hour: 17, minute: 0 };

let studentsCache = {};
let sectionsCache = {};
let todayLogsByStudent = {}; // studentId -> [logs today, oldest -> newest], for "first scan" late-checking
let lastShownTimestamp = null;
let revertTimer = null;

function minutesSinceMidnight(date) {
    return date.getHours() * 60 + date.getMinutes();
}

function cutoffMinutes(cutoff) {
    return cutoff.hour * 60 + cutoff.minute;
}

/* A student is "late" if their FIRST "in" scan today happened after the
   cutoff. Looks at todayLogsByStudent (oldest -> newest) rather than the
   log currently being shown, so a student who checked in on time this
   morning and is now just re-scanning after lunch doesn't get flagged. */
function isStudentLateToday(studentId) {
    const entries = todayLogsByStudent[studentId] || [];
    const firstIn = entries.find((log) => log.direction === "in");
    if (!firstIn) return false;
    return minutesSinceMidnight(new Date(firstIn.timestamp)) > cutoffMinutes(LATE_CUTOFF);
}

/* ==========================================================================
   FULLSCREEN
   --------------------------------------------------------------------------
   Browsers only grant Fullscreen API access from a real user gesture — a
   page can never force itself fullscreen just by loading, so there's no
   way to skip the first tap entirely. What this does instead: the very
   first tap/click anywhere on the kiosk (which the idle screen already
   asks for) also requests fullscreen, so in practice staff just tap the
   screen once after opening the page and it takes over the whole monitor.
   The corner button is the fallback if that first tap was consumed by
   something else, or a browser policy blocked the auto-request.

   Note: this hides the browser's own chrome (tabs, address bar) and, on
   most desktop browsers, the OS taskbar too — that's genuinely as far as
   a web page can reach. True OS-level lockdown (disabling Alt+Tab, the
   Windows key, etc.) needs a browser kiosk flag or a dedicated kiosk app,
   not something achievable from inside the page itself.
========================================================================== */
function requestKioskFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) return;

    const el = document.documentElement;
    const request = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (!request) return;

    request.call(el).catch(() => {
        /* Blocked or dismissed — the corner button stays available to retry. */
    });
}

function setupFullscreenControls() {
    const btn = document.getElementById("kiosk-fullscreen-btn");

    document.body.addEventListener("click", requestKioskFullscreen, { once: true });

    if (btn) {
        btn.addEventListener("click", (event) => {
            event.stopPropagation();
            requestKioskFullscreen();
        });
    }

    const syncButtonVisibility = () => {
        const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
        if (btn) btn.classList.toggle("hidden", isFullscreen);
    };

    document.addEventListener("fullscreenchange", syncButtonVisibility);
    document.addEventListener("webkitfullscreenchange", syncButtonVisibility);
    syncButtonVisibility();
}

document.addEventListener("DOMContentLoaded", () => {
    // Respect the same ?hide=4 / ?hide=0 toggle used across the admin app
    // (see feature-flags.js, loaded before this file). When attendance
    // features are hidden, the kiosk shows a simple unavailable notice and
    // never opens any Firebase listeners or the camera-adjacent scan flow.
    if (window.rpAttendanceHidden) {
        showKioskUnavailable();
        return;
    }

    startClock();
    setupFullscreenControls();

    onValue(studentsRootRef, (snapshot) => {
        studentsCache = snapshot.val() || {};
    });

    onValue(sectionsRootRef, (snapshot) => {
        sectionsCache = snapshot.val() || {};
    });

    // Today-only log cache, purely to answer "was this student's first
    // check-in today late" — same startOfToday+startAt pattern used by
    // students.js, kept as its own small listener per this file's
    // read-only, self-contained convention.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayQuery = query(attendanceRootRef, orderByChild("timestamp"), startAt(startOfToday.getTime()));

    onValue(todayQuery, (snapshot) => {
        const logs = snapshot.val() || {};
        const grouped = {};
        Object.values(logs).forEach((log) => {
            if (!grouped[log.studentId]) grouped[log.studentId] = [];
            grouped[log.studentId].push(log);
        });
        Object.values(grouped).forEach((entries) => entries.sort((a, b) => a.timestamp - b.timestamp));
        todayLogsByStudent = grouped;
    });

    onValue(latestAttendanceQuery, (snapshot) => {
        const logs = snapshot.val() || {};
        const [latest] = Object.values(logs);
        if (!latest) return;

        // onValue fires immediately with whatever is already in the DB, so
        // this guard both (a) stops the very first page load from replaying
        // the last scan that happened before the kiosk was even open* and
        // (b) stops the same record firing this callback twice.
        // *shown once is fine and arguably useful (confirms the kiosk is
        // live), so we intentionally do NOT skip the very first fire.
        if (latest.timestamp === lastShownTimestamp) return;
        lastShownTimestamp = latest.timestamp;

        showResult(latest);
    });
});

function showKioskUnavailable() {
    const idleEl = document.getElementById("kiosk-idle");
    const resultEl = document.getElementById("kiosk-result");
    const fullscreenBtn = document.getElementById("kiosk-fullscreen-btn");
    if (resultEl) resultEl.classList.add("hidden");
    if (fullscreenBtn) fullscreenBtn.classList.add("hidden");
    if (idleEl) {
        idleEl.innerHTML = `
            <div class="kiosk-idle-mark">RP</div>
            <h1>Kiosk Unavailable</h1>
            <p>This display has been turned off by an administrator.</p>
        `;
    }
    startClock();
}

function showResult(logEntry) {
    const student = studentsCache[logEntry.studentId];
    const section = student ? sectionsCache[student.sectionId] : null;

    const idleEl = document.getElementById("kiosk-idle");
    const resultEl = document.getElementById("kiosk-result");
    const directionBadge = document.getElementById("kiosk-direction-badge");
    const photoEl = document.getElementById("kiosk-photo");
    const photoFallbackEl = document.getElementById("kiosk-photo-fallback");
    const nameEl = document.getElementById("kiosk-name");
    const lrnEl = document.getElementById("kiosk-lrn");
    const sectionEl = document.getElementById("kiosk-section");
    const adviserEl = document.getElementById("kiosk-adviser");
    const roomEl = document.getElementById("kiosk-room");
    const timeEl = document.getElementById("kiosk-time");
    const badgeEl = document.getElementById("kiosk-punctuality-badge");

    const fullName = student
        ? [student.firstName, student.middleName, student.lastName, student.extension]
            .filter((v) => v && String(v).trim())
            .join(" ")
        : "Unknown Student";

    const isOut = logEntry.direction === "out";
    directionBadge.textContent = isOut ? "Checked OUT" : "Checked IN";
    directionBadge.classList.toggle("direction-out", isOut);

    nameEl.textContent = fullName;
    lrnEl.textContent = `LRN: ${student && student.lrn ? student.lrn : "--"}`;
    sectionEl.textContent = section ? `${section.gradeName || "--"} \u2013 ${section.name}` : "--";
    adviserEl.textContent = section && section.assignedTeacherId ? section.assignedTeacherId : "Unassigned";
    roomEl.textContent = section ? section.name : "--";
    timeEl.textContent = new Date(logEntry.timestamp).toLocaleTimeString("en-PH", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });

    // Punctuality badge: only meaningful for IN scans (checking whether
    // THIS scan was the late one) and only shown for OUT scans as a past-
    // cutoff note, not a judgment call ("late checkout" isn't a rule here).
    if (badgeEl) {
        if (!isOut) {
            const late = isStudentLateToday(logEntry.studentId);
            badgeEl.textContent = late ? "LATE" : "ON TIME";
            badgeEl.classList.toggle("kiosk-badge-late", late);
            badgeEl.classList.toggle("kiosk-badge-ontime", !late);
            badgeEl.classList.remove("hidden");
        } else {
            const minutesNow = minutesSinceMidnight(new Date(logEntry.timestamp));
            const pastCheckout = minutesNow >= cutoffMinutes(CHECKOUT_CUTOFF);
            badgeEl.textContent = pastCheckout ? "CHECKED OUT" : "EARLY CHECK-OUT";
            badgeEl.classList.remove("kiosk-badge-late", "kiosk-badge-ontime");
            badgeEl.classList.toggle("kiosk-badge-checkout", pastCheckout);
            badgeEl.classList.toggle("kiosk-badge-early", !pastCheckout);
            badgeEl.classList.remove("hidden");
        }
    }

    const initials = student
        ? ((student.firstName || "").charAt(0) + (student.lastName || "").charAt(0)).toUpperCase()
        : "?";
    photoFallbackEl.textContent = initials || "?";

    if (student && student.photoUrl) {
        photoEl.src = student.photoUrl;
        photoEl.classList.remove("hidden");
        photoFallbackEl.classList.add("hidden");
        photoEl.onerror = () => {
            photoEl.classList.add("hidden");
            photoFallbackEl.classList.remove("hidden");
        };
    } else {
        photoEl.classList.add("hidden");
        photoFallbackEl.classList.remove("hidden");
    }

    idleEl.classList.add("hidden");
    resultEl.classList.remove("hidden");

    clearTimeout(revertTimer);
    revertTimer = setTimeout(() => {
        resultEl.classList.add("hidden");
        idleEl.classList.remove("hidden");
    }, RESULT_DISPLAY_MS);
}

function startClock() {
    const clockEl = document.getElementById("kiosk-clock");
    if (!clockEl) return;

    const tick = () => {
        clockEl.textContent = new Date().toLocaleTimeString("en-PH", { hour12: true });
    };
    tick();
    setInterval(tick, 1000);
}
