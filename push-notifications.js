/* ==========================================================================
   RESCUEPRIORITY — PUSH NOTIFICATION OPT-IN
   --------------------------------------------------------------------------
   Wires up the "Send me emergency push notifications on this device"
   checkbox in Settings. This is the piece that makes notifications work
   even when the browser isn't open (unlike emergency-alert.js's
   `new Notification(...)`, which only fires while a tab is actually
   loaded) — but it ONLY gets an admin's device ready to RECEIVE a push.
   Something still has to SEND one when an incident happens: that's the
   Cloud Function in /functions (see functions/index.js and
   SETUP-NOTIFICATIONS.md at the project root for the one-time setup this
   needs on Firebase's side, including a VAPID key you must paste in below).

   Flow when the checkbox is turned on:
     1. Register /firebase-messaging-sw.js as a service worker (required —
        this is the part that can wake up and show a notification with no
        tab open).
     2. Ask the browser for Notification permission (a real permission
        prompt; the user can always say no, and this never re-prompts if
        they already denied it once — that's the browser's own rule, not
        this code's).
     3. Ask Firebase Cloud Messaging for a token tied to this
        browser+device+site.
     4. Save that token under fcmTokens/{token} in the Realtime Database so
        the Cloud Function knows where to send pushes. Saving your own
        device's token is all this page ever writes here — see
        database.rules.json for the exact (narrow) write shape allowed.

   Turning the checkbox back off deletes this device's token from
   fcmTokens/ and revokes it with FCM, so it stops receiving pushes.
========================================================================== */

import { database } from "./script.js";
import { ref, set, remove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getMessaging, getToken, deleteToken } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js";

/* --------------------------------------------------------------------------
   ONE THING YOU MUST FILL IN: the VAPID key from your Firebase project.
   Firebase Console -> Project settings -> Cloud Messaging -> "Web Push
   certificates" -> Generate key pair (if you don't have one yet) -> copy
   the "Key pair" value here. Without this, getToken() below will fail and
   the checkbox will show an error instead of turning on. Full walkthrough
   in SETUP-NOTIFICATIONS.md.
-------------------------------------------------------------------------- */
const VAPID_KEY = "PASTE-YOUR-FIREBASE-VAPID-KEY-HERE";

const firebaseConfig = {
    apiKey: "AIzaSyDHPzeyaEtVvEvnH1Va81i24tpiCX8Gx-8",
    authDomain: "school-alert-system-8f211.firebaseapp.com",
    databaseURL: "https://school-alert-system-8f211-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "school-alert-system-8f211",
    storageBucket: "school-alert-system-8f211.firebasestorage.app",
    messagingSenderId: "568204675808",
    appId: "1:568204675808:web:1ca3536d31b7dc5db45e85"
};

let messaging = null;
let currentToken = null;

document.addEventListener("DOMContentLoaded", () => {
    const toggle = document.getElementById("push-notif-toggle");
    const status = document.getElementById("push-notif-status");
    if (!toggle || !status) return; // Settings view not on this page

    if (!("serviceWorker" in navigator) || !("Notification" in window)) {
        toggle.disabled = true;
        status.textContent = "Status: not supported on this browser/device.";
        return;
    }

    // Reflect current real-world state on load, without prompting anything.
    if (Notification.permission === "denied") {
        toggle.disabled = true;
        status.textContent = "Status: blocked — notifications were denied for this site in your browser settings.";
    } else {
        status.textContent = Notification.permission === "granted"
            ? "Status: checking this device's saved token..."
            : "Status: off.";
        toggle.checked = false; // token presence, not just permission, decides the real "on" state — resolved below
        syncToggleWithSavedToken(toggle, status);
    }

    toggle.addEventListener("change", () => {
        if (toggle.checked) {
            enablePush(toggle, status);
        } else {
            disablePush(toggle, status);
        }
    });
});

function getMessagingInstance() {
    if (messaging) return messaging;
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    messaging = getMessaging(app);
    return messaging;
}

async function syncToggleWithSavedToken(toggle, status) {
    // We don't persist the token locally on purpose (it can rotate); the
    // simplest reliable check is just trying a silent getToken() call,
    // which returns the existing token without a new prompt if one is
    // already registered for this browser+site.
    if (Notification.permission !== "granted") {
        status.textContent = "Status: off.";
        return;
    }
    try {
        const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
        const token = await getToken(getMessagingInstance(), {
            vapidKey: VAPID_KEY,
            serviceWorkerRegistration: registration
        });
        if (token) {
            currentToken = token;
            toggle.checked = true;
            status.textContent = "Status: on for this device.";
        } else {
            status.textContent = "Status: off.";
        }
    } catch (error) {
        status.textContent = "Status: off.";
    }
}

async function enablePush(toggle, status) {
    status.textContent = "Requesting permission...";
    toggle.disabled = true;
    try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
            toggle.checked = false;
            status.textContent = "Status: permission not granted.";
            return;
        }

        const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
        const token = await getToken(getMessagingInstance(), {
            vapidKey: VAPID_KEY,
            serviceWorkerRegistration: registration
        });

        if (!token) {
            toggle.checked = false;
            status.textContent = "Status: couldn't get a device token — try again.";
            return;
        }

        currentToken = token;
        await set(ref(database, `fcmTokens/${token}`), {
            createdAt: Date.now(),
            userAgent: navigator.userAgent
        });

        status.textContent = "Status: on for this device.";
    } catch (error) {
        console.error("[push-notifications] enable failed:", error);
        toggle.checked = false;
        status.textContent = VAPID_KEY.startsWith("PASTE-")
            ? "Status: setup incomplete — add your VAPID key in push-notifications.js (see SETUP-NOTIFICATIONS.md)."
            : "Status: couldn't enable notifications on this device.";
    } finally {
        toggle.disabled = false;
    }
}

async function disablePush(toggle, status) {
    toggle.disabled = true;
    try {
        if (currentToken) {
            await remove(ref(database, `fcmTokens/${currentToken}`));
            await deleteToken(getMessagingInstance()).catch(() => {});
            currentToken = null;
        }
        status.textContent = "Status: off.";
    } catch (error) {
        console.error("[push-notifications] disable failed:", error);
        status.textContent = "Status: off (locally) — cleanup on the server may have failed.";
    } finally {
        toggle.disabled = false;
    }
}
