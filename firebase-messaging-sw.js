/* ==========================================================================
   RESCUEPRIORITY — FIREBASE MESSAGING SERVICE WORKER
   --------------------------------------------------------------------------
   This file MUST live at the site root (same folder as index.html) and MUST
   be named exactly firebase-messaging-sw.js and be reachable at
   /firebase-messaging-sw.js — Firebase's getToken()/onBackgroundMessage()
   look for it there by convention. It's what lets a push notification show
   up even when no RescuePriority tab is open at all: the browser starts
   this worker in the background when a push arrives, this file shows the
   notification, then the worker goes back to sleep.

   Service workers can't use ES module imports like the rest of this app,
   so this uses the classic Firebase "compat" scripts via importScripts()
   instead — that's normal/expected for this one file only.

   Config values below are PUBLIC identifiers (same ones already visible in
   script.js's firebaseConfig) — safe to ship client-side. They are NOT
   secrets.
========================================================================== */

importScripts("https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js");

firebase.initializeApp({
    apiKey: "AIzaSyDHPzeyaEtVvEvnH1Va81i24tpiCX8Gx-8",
    authDomain: "school-alert-system-8f211.firebaseapp.com",
    databaseURL: "https://school-alert-system-8f211-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "school-alert-system-8f211",
    storageBucket: "school-alert-system-8f211.firebasestorage.app",
    messagingSenderId: "568204675808",
    appId: "1:568204675808:web:1ca3536d31b7dc5db45e85"
});

const messaging = firebase.messaging();

// Fires when a push arrives and NO RescuePriority tab is in the foreground
// (that's the whole "even if you're not on the browser" behavior). If a
// tab IS open and focused, the app gets the message directly instead and
// this handler is skipped by the browser — that's normal FCM behavior, not
// a bug, so don't expect double notifications while actively using the app.
messaging.onBackgroundMessage((payload) => {
    const title = (payload.notification && payload.notification.title) || "RescuePriority Alert";
    const options = {
        body: (payload.notification && payload.notification.body) || "A new incident was reported.",
        icon: "/icon-192.png",       // optional — safe to remove/replace if you don't have this file
        badge: "/icon-192.png",      // optional — same
        data: payload.data || {},
        tag: (payload.data && payload.data.incidentKey) || undefined // collapses repeat pushes for the same incident
    };
    self.registration.showNotification(title, options);
});

// Clicking the OS notification focuses/opens the dashboard.
self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const targetUrl = "/index.html";
    event.waitUntil(
        clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
            for (const client of windowClients) {
                if ("focus" in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow(targetUrl);
        })
    );
});
