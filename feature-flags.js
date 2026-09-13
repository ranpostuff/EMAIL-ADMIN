/* ==========================================================================
   RESCUEPRIORITY — HIDDEN-FEATURES TOGGLE
   --------------------------------------------------------------------------
   Lets an admin hide/reveal the attendance-scanning features (Scan
   Attendance, the Kiosk Display link, the "Email Today's Late List"
   button, and the check-in/Late-On-time/Last-Scan columns in the Section
   Roster) by visiting a URL with ?hide=4, and bring them back with
   ?hide=0. The choice is remembered (localStorage), so it stays hidden on
   later visits/reloads too, until ?hide=0 is used again — it isn't just a
   one-time effect of the query string being present on this particular
   page load.

   Deliberately a plain, non-module, synchronous script loaded first in
   <head> (see index.html / kiosk.html) so the class lands on <html>
   before the rest of the page paints — avoids a flash of the
   attendance/kiosk UI before it gets hidden.

   The Violations feature is NEVER affected by this — nothing in
   violations.js or its markup carries the [data-hide-group="attendance"]
   marker this file acts on, by design.

   Elements are hidden purely via CSS: any element (anywhere in the app)
   marked data-hide-group="attendance" is hidden while the flag is on
   (see the ".rp-hide-attendance [data-hide-group]" rule in style.css /
   kiosk.css). kiosk.js additionally reads rpAttendanceHidden() itself to
   show a simple "unavailable" state instead of the live kiosk display.
========================================================================== */
(function () {
    var STORAGE_KEY = "rp_hide_attendance";

    function readFlag() {
        try {
            return window.localStorage.getItem(STORAGE_KEY) === "1";
        } catch (e) {
            return false; // localStorage unavailable (privacy mode, etc.) — fail open, nothing hidden
        }
    }

    function writeFlag(hidden) {
        try {
            if (hidden) {
                window.localStorage.setItem(STORAGE_KEY, "1");
            } else {
                window.localStorage.removeItem(STORAGE_KEY);
            }
        } catch (e) {
            // Ignore — the class below still applies for this page load.
        }
    }

    try {
        var params = new URLSearchParams(window.location.search);
        var hideParam = params.get("hide");

        if (hideParam === "4") {
            writeFlag(true);
        } else if (hideParam === "0") {
            writeFlag(false);
        }
    } catch (e) {
        // Malformed URL, etc. — fall through to whatever was already stored.
    }

    var hidden = readFlag();
    document.documentElement.classList.toggle("rp-hide-attendance", hidden);

    // Exposed for kiosk.js (and anything else that needs to branch in JS
    // rather than pure CSS) without re-reading localStorage/parsing itself.
    window.rpAttendanceHidden = hidden;
})();
