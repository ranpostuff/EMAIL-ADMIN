/* ==========================================================================
   RESCUEPRIORITY — EMAIL LATENCY SIMULATOR (capstone testing only)
   --------------------------------------------------------------------------
   NOT a real product feature — instrumentation for the thesis Results
   chapter, same family as latency-test.js (submit -> dashboard) and
   facilities-test.js. Measures how long the EMAIL leg of an alert would
   take (Firebase routing lookups + message assembly + a modeled SMTP
   round trip) in batches, WITHOUT ever calling Resend or delivering a
   real email to anyone.

   Request body:  { "batchSize": number, "batchCount": number, "facilityId"?: string }
   Response body: { "ok": true, "batches": [...], "overall": {...} }

   Triggered from the admin dashboard by the debug panel in
   email-latency-test.js (client side), itself gated behind
   ?htmlemail=3 the same way ?latencytest=1 / ?facilitiestest=2 gate
   the other two testing tools. Nothing here runs for a normal visitor.

   WHY THIS IS SAFE TO RUN REPEATEDLY (no real sends, ever)
   1. Firebase reads (facilityAdviserEmails/, ALERT_RECIPIENTS env) are
      REAL — that overhead is genuinely part of what a batch of alerts
      costs, so it's measured for real, not faked.
   2. Message assembly is REAL too: nodemailer's transporter is created
      with { jsonTransport: true }, which runs the actual MIME/header
      compilation pipeline (same CPU work as a real send) and returns
      the compiled message as JSON — it never opens a socket, never
      talks to smtp.resend.com, and cannot deliver mail under any
      configuration. This is nodemailer's own built-in "compile but
      don't send" transport, not something bolted on here.
   3. The one thing genuinely faked is the network round trip to the
      SMTP server, since that can only be measured by actually sending.
      That's modeled with an artificial delay (SIMULATED_SMTP_MIN_MS /
      SIMULATED_SMTP_MAX_MS below) so total batch latency approximates
      a real send's shape. Tune those two constants against a handful
      of real send timings (Vercel function duration logs from an
      actual /api/incident-alert call) if you want closer accuracy —
      no code changes needed elsewhere for that.

   No env vars beyond the ones incident-alert.js already needs
   (FIREBASE_SERVICE_ACCOUNT_KEY, FIREBASE_DATABASE_URL). SMTP_* env
   vars are read only to keep the simulated transporter's shape
   identical to the real one; jsonTransport ignores host/port/auth
   entirely, so this never touches your real Resend credentials.
========================================================================== */

import admin from "firebase-admin";
import nodemailer from "nodemailer";

// Modeled SMTP round-trip time, in ms — the one part of this file that
// is genuinely made up rather than measured, since measuring it for
// real would require actually sending. Adjust these two numbers to
// match reality if you have real timings to compare against (e.g. the
// "Execution Duration" shown in Vercel's function logs for a real
// /api/incident-alert call, minus its own Firebase-read overhead).
const SIMULATED_SMTP_MIN_MS = 180;
const SIMULATED_SMTP_MAX_MS = 520;

const MAX_BATCH_SIZE = 50;   // safety cap — this is a synthetic load test, not a real campaign
const MAX_BATCH_COUNT = 50;  // same reasoning

let appInitialized = false;

function ensureFirebaseAdmin() {
    if (appInitialized) return;

    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY is not set.");

    const jsonText = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const serviceAccount = JSON.parse(jsonText);

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });
    appInitialized = true;
}

function randomDelayMs() {
    return SIMULATED_SMTP_MIN_MS + Math.random() * (SIMULATED_SMTP_MAX_MS - SIMULATED_SMTP_MIN_MS);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function mean(values) {
    return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(values, avg) {
    const variance = mean(values.map((v) => (v - avg) ** 2));
    return Math.sqrt(variance);
}

function summarize(latencies) {
    const avg = mean(latencies);
    return {
        count: latencies.length,
        meanMs: Number(avg.toFixed(2)),
        medianMs: Number(median(latencies).toFixed(2)),
        minMs: Number(Math.min(...latencies).toFixed(2)),
        maxMs: Number(Math.max(...latencies).toFixed(2)),
        stddevMs: Number(stddev(latencies, avg).toFixed(2))
    };
}

/* ==========================================================================
   ONE SIMULATED SEND — mirrors sendAdviserEmail() in incident-alert.js
   exactly, right up until the point of actually handing off to a real
   transport, where it substitutes jsonTransport + a modeled delay.
========================================================================== */
async function simulateOneSend(facilityId, index) {
    const start = performance.now();
    const startedAt = Date.now(); // epoch ms — mirrors submission_time in the submit->dashboard latency CSV

    const alwaysCc = (process.env.ALERT_RECIPIENTS || "")
        .split(",")
        .map((email) => email.trim())
        .filter(Boolean);

    let roomRecipients = [];
    try {
        const snap = await admin.database().ref(`facilityAdviserEmails/${facilityId}`).get();
        const raw = snap.val();
        if (raw) {
            roomRecipients = String(raw)
                .split(",")
                .map((email) => email.trim())
                .filter(Boolean);
        }
    } catch (error) {
        console.error("[email-latency-test] Failed to read facilityAdviserEmails:", error);
    }

    const recipients = Array.from(new Set([...roomRecipients, ...alwaysCc]));
    // Fall back to a placeholder so a room with no adviser email on file
    // still exercises the full message-assembly pipeline during a test run
    // (a skip here would understate real batch latency for occupied rooms).
    const effectiveRecipients = recipients.length ? recipients : ["simulated-recipient@example.invalid"];

    // jsonTransport: true — nodemailer compiles the full message (headers,
    // MIME parts, encoding) and hands it back as JSON. No socket is ever
    // opened; smtp.resend.com is never contacted. This is nodemailer's own
    // built-in transport for exactly this purpose, not a custom stub.
    const transporter = nodemailer.createTransport({ jsonTransport: true });

    const compileStart = performance.now();
    await transporter.sendMail({
        from: `"RescuePriority Alerts" <${process.env.MAIL_FROM || "onboarding@resend.dev"}>`,
        to: effectiveRecipients.join(","),
        subject: `[SIMULATED] RescuePriority Alert #${index}`,
        text: [
            `Incident: SIM-${index}`,
            `Student: Simulated Student ${index}`,
            `Location: ${facilityId}`,
            "Type: Simulated",
            "Status: Simulated — no real incident, no real email sent."
        ].join("\n")
    });
    const compileMs = performance.now() - compileStart;

    // The one faked part: how long the real SMTP round trip would have
    // taken. Everything before this line was real work, really measured.
    const modeledNetworkMs = randomDelayMs();
    await sleep(modeledNetworkMs);

    const totalMs = performance.now() - start;
    const completedAt = Date.now(); // epoch ms — mirrors display_time in the submit->dashboard latency CSV

    return {
        index,
        facilityId,
        recipientCount: effectiveRecipients.length,
        firebaseLookupAndCompileMs: Number(compileMs.toFixed(2)),
        modeledNetworkMs: Number(modeledNetworkMs.toFixed(2)),
        totalMs: Number(totalMs.toFixed(2)),
        startedAt,
        completedAt
    };
}

export default async function handler(req, res) {
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

    // Reuses the same optional shared-secret gate as incident-alert.js —
    // if you've set ALERT_API_SECRET, this endpoint is locked the same way.
    const configuredSecret = process.env.ALERT_API_SECRET;
    if (configuredSecret && req.headers["x-alert-secret"] !== configuredSecret) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body || {};
    const batchSize = Math.max(1, Math.min(MAX_BATCH_SIZE, Number(body.batchSize) || 5));
    const batchCount = Math.max(1, Math.min(MAX_BATCH_COUNT, Number(body.batchCount) || 1));

    try {
        ensureFirebaseAdmin();
    } catch (error) {
        console.error("[email-latency-test] Firebase Admin init failed:", error);
        return res.status(500).json({ error: "Server is not configured yet. See SETUP-NOTIFICATIONS.md." });
    }

    // Spread simulated sends across real facilityIds so the Firebase-lookup
    // portion of the timing reflects genuine variety, not one cached path.
    let facilityIds = [];
    try {
        const snap = await admin.database().ref("facilityAdviserEmails").get();
        const val = snap.val() || {};
        facilityIds = Object.keys(val);
    } catch (error) {
        console.error("[email-latency-test] Failed to list facilityAdviserEmails:", error);
    }
    if (facilityIds.length === 0) facilityIds = [body.facilityId || "shs1-amaranth"];

    const batches = [];
    let runningIndex = 0;

    for (let b = 0; b < batchCount; b++) {
        const batchStart = performance.now();

        // A batch fires its sends concurrently (Promise.all), same as how
        // sendAdviserEmail + sendPushToAllDevices already run concurrently
        // via Promise.allSettled in incident-alert.js for a single alert —
        // this just extends that pattern to N alerts at once.
        const items = await Promise.all(
            Array.from({ length: batchSize }, (_, i) => {
                const facilityId = facilityIds[(runningIndex + i) % facilityIds.length];
                return simulateOneSend(facilityId, runningIndex + i);
            })
        );
        runningIndex += batchSize;

        const batchWallMs = performance.now() - batchStart;
        const latencies = items.map((it) => it.totalMs);

        batches.push({
            batchNumber: b + 1,
            batchWallMs: Number(batchWallMs.toFixed(2)),
            items,
            stats: summarize(latencies)
        });
    }

    const allLatencies = batches.flatMap((batch) => batch.items.map((it) => it.totalMs));

    return res.status(200).json({
        ok: true,
        simulated: true,
        note: "No real emails were sent — nodemailer jsonTransport compiled messages in memory only.",
        batchSize,
        batchCount,
        batches,
        overall: summarize(allLatencies)
    });
}
