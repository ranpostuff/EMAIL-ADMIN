/* ==========================================================================
   RESCUEPRIORITY — SITE-WIDE EMERGENCY ALERT
   --------------------------------------------------------------------------
   Additive module, read-only. Turns the whole admin app into an unmissable
   alert state the moment any classroom emergency goes active — no matter
   which sidebar view (Dashboard, Students, Analytics, Violations, ...) the
   admin currently has open — because the overlay it controls
   (#emergency-alert-overlay, #emergency-toast-stack) lives outside every
   .app-view in index.html, as a direct <body> child.

   Source of truth (already exists elsewhere in the app; this module just
   adds its own read-only listener rather than importing a live binding,
   matching the reliability reasoning already used by insights.js and
   students.js's own incidents/ listener):
     classrooms/{facilityId}.emergency  -> boolean (the same flag that
                                            drives the pulsing room cards
                                            and the Command Center KPIs)

   What it does when the active set is non-empty:
     - Keeps a pulsing red border + a persistent top banner visible on every
       page (CSS in emergency-alert.css) for as long as anything is active.
     - Pops a dismissible toast (+ a short beep, + a browser Notification if
       the tab isn't focused and permission was granted) for each NEWLY
       started emergency, so re-renders of already-known emergencies don't
       spam repeat toasts.
     - Clicking the banner or a toast's "View" button jumps to the Campus
       Map view via script.js's switchView(), which this module can call
       because switchView is exported.
========================================================================== */

import { database, SCHOOL_FACILITIES, switchView, displayFacilityName } from "./script.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const classroomsRootRef = ref(database, "classrooms");

let classroomsCache = {}; // facilityId -> { emergency, activeIncidentKey }

// facilityId -> { type: "emergency" } for everything currently active,
// kept across renders so re-firing onValue snapshots (which happen on
// every unrelated field change too) don't create duplicate toasts.
let knownActiveIds = new Set();

let notificationPermissionAsked = false;

document.addEventListener("DOMContentLoaded", () => {
    setupBannerButton();

    onValue(classroomsRootRef, (snapshot) => {
        classroomsCache = snapshot.val() || {};
        recomputeAlertState();
    });
});

function facilityName(facilityId) {
    const facility = SCHOOL_FACILITIES.find((f) => f.id === facilityId);
    return displayFacilityName(facility ? facility.name : facilityId);
}

/* ==========================================================================
   CORE STATE RECOMPUTE
========================================================================== */
function getActiveAlerts() {
    const alerts = []; // { facilityId, type }

    Object.entries(classroomsCache).forEach(([facilityId, entry]) => {
        if (entry && entry.emergency) alerts.push({ facilityId, type: "emergency" });
    });

    return alerts;
}

function recomputeAlertState() {
    const alerts = getActiveAlerts();
    const activeIds = new Set(alerts.map((a) => `${a.type}:${a.facilityId}`));

    // Anything in activeIds that wasn't in knownActiveIds a moment ago is a
    // brand-new emergency -> gets its own toast (+ sound + notification).
    const newAlerts = alerts.filter((a) => !knownActiveIds.has(`${a.type}:${a.facilityId}`));
    newAlerts.forEach((alert) => announceNewAlert(alert));

    knownActiveIds = activeIds;

    renderPersistentAlertUI(alerts);
}

/* ==========================================================================
   PERSISTENT OVERLAY (border pulse + banner) — visible on every page
========================================================================== */
function renderPersistentAlertUI(alerts) {
    const overlay = document.getElementById("emergency-alert-overlay");
    const bannerText = document.getElementById("emergency-alert-banner-text");
    if (!overlay) return;

    if (alerts.length === 0) {
        overlay.classList.add("hidden");
        document.body.classList.remove("emergency-alert-active");
        return;
    }

    overlay.classList.remove("hidden");
    document.body.classList.add("emergency-alert-active");

    if (bannerText) {
        const names = alerts.map((a) => facilityName(a.facilityId));
        const label = alerts.length === 1 ? "Active Emergency" : `${alerts.length} Active Emergencies`;
        const roomList = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3} more` : "");
        bannerText.textContent = `${label} \u2014 ${roomList}`;
    }
}

function setupBannerButton() {
    const btn = document.getElementById("emergency-alert-banner-view");
    if (btn) btn.addEventListener("click", () => switchView("campus-map-view"));
}

/* ==========================================================================
   NEW-ALERT ANNOUNCEMENT — toast + sound + optional OS notification
========================================================================== */
function announceNewAlert(alert) {
    showToast(alert);
    playAlertBeep();
    maybeShowBrowserNotification(alert);
}

function showToast(alert) {
    const stack = document.getElementById("emergency-toast-stack");
    if (!stack) return;

    const roomName = facilityName(alert.facilityId);
    const title = "New Emergency";

    const toast = document.createElement("div");
    toast.className = "emergency-toast";
    toast.innerHTML = `
        <div class="emergency-toast-header">
            <span class="emergency-toast-title">${escapeHtml(title)}</span>
            <button type="button" class="emergency-toast-close" aria-label="Dismiss">&times;</button>
        </div>
        <div class="emergency-toast-body">${escapeHtml(roomName)}</div>
        <div class="emergency-toast-actions">
            <button type="button" class="emergency-toast-view-btn">View on Campus Map</button>
        </div>
    `;

    toast.querySelector(".emergency-toast-close").addEventListener("click", () => toast.remove());
    toast.querySelector(".emergency-toast-view-btn").addEventListener("click", () => {
        switchView("campus-map-view");
        toast.remove();
    });

    stack.appendChild(toast);
    setTimeout(() => toast.remove(), 15000); // auto-dismiss; the persistent banner keeps the state visible regardless
}

/* Short two-tone beep via Web Audio — no external audio file needed.
   Browsers block audio before any user gesture on the page; that's fine,
   this silently no-ops in that case rather than throwing. */
function playAlertBeep() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        [880, 660].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "square";
            osc.frequency.value = freq;
            gain.gain.value = 0.06;
            osc.connect(gain);
            gain.connect(ctx.destination);
            const start = ctx.currentTime + i * 0.18;
            osc.start(start);
            osc.stop(start + 0.16);
        });
        setTimeout(() => ctx.close(), 800);
    } catch (error) {
        // Autoplay restrictions or no Web Audio support — the visual alert
        // still covers it, so this is safe to ignore.
    }
}

/* Browser-level Notification, only when the tab is in the background (so
   an admin looking away from the tab still gets pinged) and only if
   permission has already been granted or can be silently requested. Never
   blocks or throws if unsupported/denied. */
function maybeShowBrowserNotification(alert) {
    if (!("Notification" in window)) return;
    if (document.visibilityState === "visible") return; // in-page banner/toast already covers this case

    const roomName = facilityName(alert.facilityId);
    const title = "RescuePriority: Active Emergency";

    if (Notification.permission === "granted") {
        new Notification(title, { body: roomName });
        return;
    }

    if (Notification.permission === "default" && !notificationPermissionAsked) {
        notificationPermissionAsked = true;
        Notification.requestPermission().then((permission) => {
            if (permission === "granted") new Notification(title, { body: roomName });
        }).catch(() => { /* ignore — visual alert still covers it */ });
    }
}

function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
}
