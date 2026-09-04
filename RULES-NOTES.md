# database.rules.json — what it does and why

One Realtime Database, two apps pointed at it (the main dashboard and the
student incident reporter) — deploy this same file for both, e.g.
`firebase deploy --only database` from wherever `firebase.json` lives, or
paste it into Firebase Console -> Realtime Database -> Rules.

## Why this exists
The default "test mode" rules Firebase starts a new project on
(`.read: true`, `.write: true` at the **root**) expire automatically and
get rejected once a project's been live a while — that's almost certainly
the "being rejected" behavior this was written to fix. This file replaces
that root-level blanket rule with one explicit block per path both apps
actually use (`students/`, `sections/`, `classrooms/`, `incidents/`,
`violations/`, `attendance/`, `counters/`). Anything outside those paths
is unreachable (implicit deny), and each path only accepts writes shaped
like what that app actually sends — a bad/partial write gets rejected by
the rule instead of silently corrupting a record.

## What this does *not* do
Neither app implements Firebase Auth (both READMEs say so directly — "no
login/auth", "student identifies themselves by scanning their own ID"), so
these rules can't scope reads to "only your own record" the way a
logged-in app could; `auth.uid` isn't available to check against.
Practically: any device that can reach the incident app can still read the
whole `students/`/`sections/` roster (needed for the LRN lookup) and write
a new `incidents/` record. That's a known, already-documented limitation
(see `student-incident-app/README.md`, "Security rules") — the real fix is
moving the LRN lookup behind a Cloud Function that returns only a
match/no-match, not the whole tree. This file is the "as safe as it can be
without that rewrite" version, not a replacement for it.
