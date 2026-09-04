/* ==========================================================================
   RESCUEPRIORITY — INCIDENT ALERT (Vercel Serverless Function)
   --------------------------------------------------------------------------
   Runs on the server, not in the browser — same pattern as api/ask-ai.js
   already in this project. Deployed automatically by Vercel because it
   lives in /api. Reachable from the frontend at:  POST /api/incident-alert

   Request body:  { "incidentKey": string }
   Response body: { "ok": true, "email": {...}, "push": {...} }

   Called by notify-incident.js right after script.js / app.js /
   facilities-test.js write a new incidents/{incidentKey} record. This
   function then goes and reads that SAME record back from Firebase itself
   (via the Admin SDK, using a service account — not the public web API
   key) rather than trusting whatever the client claims about it, so a
   forged request body can't be used to send a fake alert about an
   incident that doesn't really exist.

   Needs three things set as Environment Variables in the Vercel project
   (Project Settings -> Environment Variables) — see SETUP-NOTIFICATIONS.md
   for exact steps:
     FIREBASE_SERVICE_ACCOUNT_KEY  - full JSON key for a service account
                                      with Realtime Database + Cloud
                                      Messaging access (base64-encoded)
     FIREBASE_DATABASE_URL         - this project's RTDB URL
     ALERT_RECIPIENTS              - comma-separated adviser emails
     SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD - outgoing mail
     ALERT_API_SECRET (optional)   - shared secret; if set, requests must
                                      include a matching x-alert-secret
                                      header (notify-incident.js sends it)

   None of this requires a Firebase Blaze plan — the Admin SDK talking to
   Realtime Database and Cloud Messaging from an external server (Vercel,
   here) is free-tier Firebase usage. Blaze is only required if the
   function itself runs ON Firebase's own infrastructure (Cloud
   Functions), which this deliberately avoids.
========================================================================== */

import admin from "firebase-admin";
import nodemailer from "nodemailer";

let appInitialized = false;

function ensureFirebaseAdmin() {
    if (appInitialized) return;

    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY is not set.");

    // Accept either raw JSON or base64-encoded JSON (base64 avoids issues
    // pasting multi-line JSON into Vercel's env var UI).
    const jsonText = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const serviceAccount = JSON.parse(jsonText);

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });
    appInitialized = true;
}

export default async function handler(req, res) {
    // CORS: this endpoint is called from at least two different origins —
    // the admin dashboard AND the separate student incident-reporter app,
    // each deployed on their own domain — so it needs to allow cross-origin
    // requests explicitly, or the browser blocks the call before it ever
    // reaches this code. "*" matches this project's existing security
    // model (nothing else here uses auth/logins either); the optional
    // x-alert-secret check below is what actually gates who can use it.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-alert-secret");

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }

    if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed" });
    }

    const configuredSecret = process.env.ALERT_API_SECRET;
    if (configuredSecret && req.headers["x-alert-secret"] !== configuredSecret) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { incidentKey } = req.body || {};
    if (!incidentKey || typeof incidentKey !== "string") {
        return res.status(400).json({ error: "incidentKey is required." });
    }

    try {
        ensureFirebaseAdmin();
    } catch (error) {
        console.error("[incident-alert] Firebase Admin init failed:", error);
        return res.status(500).json({ error: "Server is not configured yet. See SETUP-NOTIFICATIONS.md." });
    }

    let incident;
    try {
        const snap = await admin.database().ref(`incidents/${incidentKey}`).get();
        incident = snap.val();
    } catch (error) {
        console.error("[incident-alert] Failed to read incident:", error);
        return res.status(500).json({ error: "Could not read the incident record." });
    }

    if (!incident) {
        return res.status(404).json({ error: "No incident found with that key." });
    }

    const isTest = !!incident.isTestData;
    const subjectPrefix = isTest ? "[TEST] " : "";
    const title = `${subjectPrefix}RescuePriority Alert: ${incident.classroom || "Unknown location"}`;
    const bodyLines = [
        `Incident: ${incident.incidentNumber || incidentKey}`,
        `Location: ${incident.classroom || "Unknown"}`,
        `Type: ${incident.incidentType || "Unspecified"}`,
        `Status: ${incident.status || "Unknown"}`,
        `Reported: ${incident.timestamp ? new Date(incident.timestamp).toLocaleString("en-PH", { timeZone: "Asia/Manila" }) : "Unknown time"}`,
        incident.description ? `Notes: ${incident.description}` : null,
        isTest ? "\nThis was triggered from Facilities Test Mode — no real emergency." : null
    ].filter(Boolean);
    const body = bodyLines.join("\n");

    const [emailResult, pushResult] = await Promise.allSettled([
        sendAdviserEmail(title, body),
        sendPushToAllDevices(title, body, incident, incidentKey)
    ]);

    return res.status(200).json({
        ok: true,
        email: emailResult.status === "fulfilled" ? emailResult.value : { error: String(emailResult.reason) },
        push: pushResult.status === "fulfilled" ? pushResult.value : { error: String(pushResult.reason) }
    });
}

/* ==========================================================================
   EMAIL
========================================================================== */
async function sendAdviserEmail(subject, textBody) {
    const recipients = (process.env.ALERT_RECIPIENTS || "")
        .split(",")
        .map((email) => email.trim())
        .filter(Boolean);

    if (recipients.length === 0) {
        return { skipped: true, reason: "No ALERT_RECIPIENTS configured." };
    }

    const port = Number(process.env.SMTP_PORT || 465);
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port,
        secure: port === 465,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASSWORD
        }
    });

    await transporter.sendMail({
        from: `"RescuePriority Alerts" <${process.env.SMTP_USER}>`,
        to: recipients.join(","),
        subject,
        text: textBody
    });

    return { sent: true, recipientCount: recipients.length };
}

/* ==========================================================================
   PUSH (Firebase Cloud Messaging)
========================================================================== */
async function sendPushToAllDevices(title, body, incident, incidentKey) {
    const tokensSnap = await admin.database().ref("fcmTokens").get();
    const tokensObj = tokensSnap.val() || {};
    const tokens = Object.keys(tokensObj);

    if (tokens.length === 0) {
        return { skipped: true, reason: "No registered devices in fcmTokens/." };
    }

    const message = {
        notification: { title, body },
        data: {
            incidentKey: String(incidentKey),
            classroom: String(incident.classroom || ""),
            status: String(incident.status || "")
        },
        tokens
    };

    const response = await admin.messaging().sendEachForMulticast(message);

    // Clean up dead tokens (uninstalled/revoked) so fcmTokens/ doesn't grow forever.
    const deletions = [];
    response.responses.forEach((res, i) => {
        const code = res.error && res.error.code;
        if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
            deletions.push(admin.database().ref(`fcmTokens/${tokens[i]}`).remove());
        }
    });
    if (deletions.length) await Promise.allSettled(deletions);

    return { successCount: response.successCount, failureCount: response.failureCount };
}
