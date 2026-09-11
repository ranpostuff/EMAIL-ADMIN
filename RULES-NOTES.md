# database.rules.json — what it does and why

One Realtime Database, two apps pointed at it (the main dashboard and the
student incident reporter) — deploy this same file for **both** (they must
stay identical), e.g. `firebase deploy --only database` from wherever
`firebase.json` lives, or paste it into Firebase Console -> Realtime
Database -> Rules.

## Why this exists
The default "test mode" rules Firebase starts a new project on
(`.read: true`, `.write: true` at the **root**) expire automatically and
get rejected once a project's been live a while — that's almost certainly
the "being rejected" behavior this was written to fix. This file replaces
that root-level blanket rule with one explicit block per path both apps
actually use (`students/`, `sections/`, `classrooms/`, `incidents/`,
`violations/`, `attendance/`, `counters/`, `admins/`, `studentLogins/`).
Anything outside those paths is unreachable (implicit deny), and each path
only accepts writes shaped like what that app actually sends — a
bad/partial write gets rejected by the rule instead of silently corrupting
a record.

## Both apps now have a login
This used to say neither app implemented Firebase Auth. That's no longer
true:

- **Command Center (admin dashboard):** Firebase Authentication
  (email/password) gates the whole dashboard — see `auth.js`. Being able to
  sign in isn't enough on its own, though: the signed-in account also has
  to be listed under `admins/{uid}` in the database, or `auth.js` signs
  them right back out. **This means creating the first admin account is a
  manual, one-time step** — a fresh `admins/{uid}` write can't check
  `root.child('admins').child(auth.uid).exists()` on itself (nothing
  exists yet), so:
  1. Firebase Console -> Authentication -> Add user (email + password).
  2. Copy that user's UID.
  3. Firebase Console -> Realtime Database -> add `admins/{that UID}` with
     a string value (their email works fine, just something non-empty).

  After that, anyone already listed under `admins/` can add more UIDs the
  same way (a write to `admins/` requires `auth != null &&
  root.child('admins').child(auth.uid).exists()` — i.e. you already have
  to be an admin to add another one).

- **Student Incident Reporter:** students sign in with their **LRN +
  password**, not email — see `studentLogins/{lrn}` below and the student
  app's own README/RULES-NOTES for the flow. This is a plain database
  lookup, not Firebase Auth (an LRN isn't an email address, and there's no
  self-serve signup), so `auth.uid` is never set for a student session —
  rules for student-facing writes (creating an incident, flipping a
  classroom's emergency flag) are still keyed on *shape*, not on identity,
  same as before.

## New nodes

- **`admins/{uid}`** — the Command Center allowlist described above. A
  user can read their own entry (to check "am I authorized"); only an
  existing admin can write a new one.
- **`studentLogins/{lrn}`** — `{ studentId, passwordHash }`, one entry per
  student who's been given a portal password (Students -> Edit Student ->
  "Student Web App Password" on the dashboard). A client can read a single
  `studentLogins/{lrn}` entry directly (needed for the student app's login
  check against the LRN it was just typed in), but can't list the whole
  `studentLogins/` tree — root-level read is `false`, only the `$lrn`
  leaf's read is `true`. Only an authenticated admin can write here.
  `passwordHash` is a client-side SHA-256 (Web Crypto `crypto.subtle`) of
  the password, **not** a salted/bcrypt-style hash from a real backend —
  see the caveat below.
- **`incidents/{key}` writes are now split by create vs. update:** anyone
  can still *create* a new incident (`data.exists() == false`) — that's
  what lets the (unauthenticated-by-design) student app and the
  dashboard's own "Trigger Test Alert" tooling keep working with no login
  — but *updating* an existing one (resolving it, marking help notified,
  etc.) now requires an authenticated, allowlisted admin. `classrooms/`,
  `counters/lastIncidentNumber`, `fcmTokens/`, and `latencyLogs/` are
  deliberately left as open writes, same as before — they're each toggled
  by unauthenticated devices (the student app, test tooling) as part of
  normal operation, not just by the dashboard.
- **`students/`, `sections/`, `attendance/`, `violations/` writes** now
  require an authenticated, allowlisted admin (reads are still public —
  the student app needs to read `students/`/`sections/` to show a name,
  LRN, and section on the report screen and to the admin's reporter
  panel). These were only ever written from inside the dashboard anyway;
  this just backs that up at the rules level instead of trusting the UI
  alone.
- Also fixed a pre-existing gap: `students/{id}/photoUrl` is a field the
  dashboard has always written (Students -> Edit Student -> "Photo URL")
  but that wasn't in the validation schema, so — depending on exactly how
  strict this file was before — that write may have been silently
  rejected. It's in the schema now.

## What this still does *not* do
The student app's LRN/password check is a client-side password compare
against a client-side hash — real, but not a substitute for a proper
backend with salted/per-user hashing and rate-limiting on guesses. Reading
`students/`/`sections/` (for name/photo/section display) is also still a
plain client-side lookup, same known limitation as before — the real fix
for both is moving them behind a Cloud Function that returns only what's
needed (a match/no-match for login, a name/photo/section for display),
not the whole tree. This file is "as safe as it can be without that
rewrite," not a replacement for it.
