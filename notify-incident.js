/* ==========================================================================
   RESCUEPRIORITY — INCIDENT ALERT TRIGGER (client side)
   --------------------------------------------------------------------------
   Vercel functions (unlike Firebase Cloud Functions) can't attach a
   listener directly to the Realtime Database — there's no "run this when
   a new row appears under incidents/" hook available on Vercel. So instead,
   whichever piece of code just WROTE the new incident record also calls
   this helper right after, which pings the Vercel API route and tells it
   "go look at this incidentKey and alert on it."

   Call sites wired up already: script.js (raiseClassroomEmergency — the
   main dashboard's own trigger), app.js (the student incident reporter),
   and facilities-test.js (the Simulate button, for end-to-end testing).

   IMPORTANT GAP: anything that writes to incidents/ WITHOUT going through
   one of those three call sites — most notably an ESP32 or other device
   writing straight to Firebase — will NOT trigger an alert, because
   nothing here is watching the database itself; it's watching these
   specific function calls. If you have hardware writing incidents
   directly, either make it call this same endpoint after it writes, or
   go back to the Firebase Cloud Functions approach (see
   SETUP-NOTIFICATIONS.md, "Firebase Functions" section) which DOES
   listen to the database itself and doesn't have this gap — that's the
   real tradeoff of not using Blaze.

   Fire-and-forget on purpose: a slow or failed alert call should never
   block or fail the actual incident write, which already succeeded by
   the time this runs.
========================================================================== */

// Replace with your deployed Vercel URL, e.g. "https://rescuepriority-alerts.vercel.app"
const ALERT_API_BASE_URL = "https://email-admin-alerts.vercel.app";

// Optional — only needed if you set ALERT_API_SECRET in the Vercel project's
// environment variables (recommended, see SETUP-NOTIFICATIONS.md). Leave
// as "" to skip sending the header entirely.
const ALERT_API_SECRET = "";

export function triggerIncidentAlert(incidentKey) {
    if (!incidentKey) return;
    if (!ALERT_API_BASE_URL || ALERT_API_BASE_URL.startsWith("PASTE-")) {
        console.warn("[incident-alert] ALERT_API_BASE_URL not configured yet — skipping alert call. See SETUP-NOTIFICATIONS.md.");
        return;
    }

    const headers = { "Content-Type": "application/json" };
    if (ALERT_API_SECRET) headers["x-alert-secret"] = ALERT_API_SECRET;

    fetch(`${ALERT_API_BASE_URL}/api/incident-alert`, {
        method: "POST",
        headers,
        body: JSON.stringify({ incidentKey })
    }).catch((error) => {
        // Never surface this to the person reporting/triggering the
        // emergency — the incident itself is already safely saved in
        // Firebase regardless of whether the alert call succeeds.
        console.error("[incident-alert] Alert call failed:", error);
    });
}
