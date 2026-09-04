# Facilities Test Mode + Email/Push Alerts — setup (Vercel)

Three pieces were added to the project. Here's what each is and, for the
two that need it, exactly how to turn it on — using Vercel instead of
Firebase Cloud Functions, so **no Firebase Blaze plan is required.**

---

## 1. Facilities Test Mode — works immediately, nothing to configure

Open the dashboard with `?facilitiestest=2` on the URL, e.g.:

```
https://your-deployed-url/index.html?facilitiestest=2
```

No build step, no config. It overlays a live table (one row per facility)
on top of the app, reading straight from the same `classrooms/` and
`incidents/` paths the real dashboard uses. The **Corresponds?** column
flags a `MISMATCH` if a facility says `EMERGENCY` but there's no matching
incident record. Each row's **Simulate** button writes a real (but
clearly tagged `isTestData: true`) incident so you can watch the whole
pipeline — including email/push, once set up below — fire end-to-end,
labeled `[TEST]`. **Reset All Test Data** wipes every test incident at
once. **Export CSV** / **Export Excel** download the table as shown.

---

## 2. Why Vercel instead of Firebase Functions

Firebase Cloud Functions require the Blaze (pay-as-you-go) plan no matter
what the function does — that's a hard Google requirement, not something
specific to this project. Vercel's free Hobby tier runs serverless
functions with no billing plan required, so the email + push backend
lives there instead, in `api/incident-alert.js`.

The one real tradeoff: Firebase Functions can listen directly to the
database ("run this the instant a new incident appears"). Vercel
functions can't attach to Firebase that way — they're plain HTTP
endpoints. So instead, the three places in this codebase that create an
incident (`script.js`'s "Trigger Test Alert", `app.js`'s student
reporter, and Facilities Test Mode's Simulate button) each call the
Vercel endpoint themselves right after writing to Firebase — that's what
`notify-incident.js` does. **If anything else ever writes to `incidents/`
directly** (most notably an ESP32 or other device writing straight to
Firebase, bypassing this web app), it won't trigger an alert unless it
also calls this same endpoint. Keep that in mind if hardware is involved.

---

## 3. Deploy the Vercel function

### Step A — Push this project to a Git repo and import it into Vercel
(or run `vercel` from the project root with the Vercel CLI — either
works; the Git route auto-redeploys on every push, which is usually
easier long-term.)

### Step B — Create a Firebase service account
1. Firebase Console → your project (⚙️ **Project settings**) → **Service
   accounts** tab → **Generate new private key**. This downloads a JSON
   file — keep it secret, it's a real credential.
2. Base64-encode it so it's safe to paste into Vercel's env var UI as one
   line:
   ```bash
   base64 -i path/to/your-service-account.json | tr -d '\n'
   ```
   (On Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("path\to\file.json"))`)

### Step C — Set environment variables in Vercel
Project → **Settings** → **Environment Variables**, add:

| Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_KEY` | the base64 string from Step B |
| `FIREBASE_DATABASE_URL` | `https://school-alert-system-8f211-default-rtdb.asia-southeast1.firebasedatabase.app` |
| `ALERT_RECIPIENTS` | comma-separated adviser emails, e.g. `adviser1@example.com,adviser2@example.com` |
| `SMTP_HOST` | `smtp.gmail.com` (see Step D) |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | the sending Gmail address |
| `SMTP_PASSWORD` | a Gmail **App Password** (not your real password — see Step D) |
| `ALERT_API_SECRET` | *(optional but recommended)* any random string you make up — locks the endpoint down so randoms can't hit it and spam your inbox/devices |

### Step D — Get a Gmail App Password (or use SendGrid)
1. Use a Gmail account you're OK sending alerts from.
2. Turn on 2-Step Verification, then create an
   [App Password](https://myaccount.google.com/apppasswords) (Google
   Account → Security → 2-Step Verification → App passwords). Copy the
   16-character password — that's `SMTP_PASSWORD`.
3. Prefer SendGrid instead? Set `SMTP_HOST=smtp.sendgrid.net`,
   `SMTP_PORT=587`, `SMTP_USER=apikey` (literally that string), and
   `SMTP_PASSWORD` = your SendGrid API key.

### Step E — Deploy
Push to your connected Git branch (or run `vercel --prod`). Note the
deployment URL Vercel gives you, e.g. `https://rescuepriority-alerts.vercel.app`.

### Step F — Point BOTH apps at your deployment
This same `api/incident-alert.js` serves both the admin dashboard AND the
separate student incident-reporter app — they're two different projects
on two different domains, but both write to the same Firebase database
and both need to reach the same Vercel endpoint. There are two copies of
`notify-incident.js`, one in each project. In **both** of them, replace:
```js
const ALERT_API_BASE_URL = "PASTE-YOUR-VERCEL-DEPLOYMENT-URL-HERE";
```
with your real Vercel URL, and if you set `ALERT_API_SECRET` in Step C,
fill in the same matching value in **both** copies too:
```js
const ALERT_API_SECRET = "";
```
Redeploy/re-upload both static sites after this change. (The function
already sends the CORS headers needed for the student app's domain to
call it — nothing else to configure for that part.)

---

## 4. Enable Cloud Messaging + get a VAPID key (for push)

1. Firebase Console → your project → ⚙️ **Project settings** → **Cloud
   Messaging** tab.
2. Under **Web Push certificates**, click **Generate key pair** (skip if
   one already exists) and copy the key shown.
3. Open `push-notifications.js` and replace:
   ```js
   const VAPID_KEY = "PASTE-YOUR-FIREBASE-VAPID-KEY-HERE";
   ```
   with the key you copied.

## 5. Turn on push notifications on a device

On the dashboard, go to **Settings** → check **"Send me emergency push
notifications on this device."** The browser shows a real permission
prompt. Once granted, the device is registered in `fcmTokens/` and will
get a push — even with the tab closed — the next time an incident is
created and reaches `api/incident-alert.js`. Unchecking it removes the
device.

## 6. Test the whole pipeline

Open `?facilitiestest=2`, click **Simulate** on any facility, then check:
- The device you enabled push on gets a `[TEST]`-labeled notification.
- Every address in `ALERT_RECIPIENTS` gets a `[TEST]`-labeled email.
- The Facilities Test table's "Corresponds?" column reads `OK`.

If nothing arrives, check the function's logs in the Vercel dashboard
(Project → **Deployments** → your deployment → **Functions** →
`api/incident-alert`) — it logs exactly what failed (bad credentials,
SMTP auth error, missing env var, etc.).

---

## Files this added

| File | What it is |
|---|---|
| `facilities-test.js` / `.css` | The `?facilitiestest=2` test view. No config needed. |
| `firebase-messaging-sw.js` | Service worker required for push while the tab is closed. Must stay at the site root. |
| `push-notifications.js` | Settings-page opt-in checkbox; needs the VAPID key (Section 4). |
| `notify-incident.js` | Client helper — calls the Vercel endpoint right after an incident is written. Present in BOTH the admin dashboard and the student app. Needs Step F, in both places. |
| `api/incident-alert.js` | The Vercel function that actually sends the email + push. Needs Steps A–E. |
| `package.json` / `vercel.json` | Tell Vercel what to install and how to serve this project. |
| `database.rules.json` | Added an `fcmTokens/` path so a device can save (and only save) its own token. |
