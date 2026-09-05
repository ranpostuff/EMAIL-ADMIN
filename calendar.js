/* ==========================================================================
   RESCUEPRIORITY — COMMAND CENTER CALENDAR
   --------------------------------------------------------------------------
   Small, self-contained month calendar for the Command Center's "Calendar"
   card. index.html already wires up the markup (#cc-calendar-grid,
   #cc-calendar-month-label, #cc-calendar-prev / #cc-calendar-next,
   #cc-calendar-today) and loads this file as a module — this is the
   implementation behind it.
========================================================================== */

let viewedYear;
let viewedMonth; // 0-11

function todayParts() {
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
}

function initCalendar() {
    const t = todayParts();
    viewedYear = t.y;
    viewedMonth = t.m;

    const prevBtn = document.getElementById("cc-calendar-prev");
    const nextBtn = document.getElementById("cc-calendar-next");
    const todayBtn = document.getElementById("cc-calendar-today");

    if (prevBtn) {
        prevBtn.addEventListener("click", () => {
            viewedMonth -= 1;
            if (viewedMonth < 0) {
                viewedMonth = 11;
                viewedYear -= 1;
            }
            renderCalendar();
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener("click", () => {
            viewedMonth += 1;
            if (viewedMonth > 11) {
                viewedMonth = 0;
                viewedYear += 1;
            }
            renderCalendar();
        });
    }

    if (todayBtn) {
        todayBtn.addEventListener("click", () => {
            const now = todayParts();
            viewedYear = now.y;
            viewedMonth = now.m;
            renderCalendar();
        });
    }

    renderCalendar();
}

/* Renders a full Sun-Sat grid for the viewed month, padded with the
   trailing days of the previous/next months (shown dim + unclickable via
   the existing .is-other-month CSS) so the grid is always a clean multiple
   of 7 cells, matching the reference calendar UI. */
function renderCalendar() {
    const grid = document.getElementById("cc-calendar-grid");
    const label = document.getElementById("cc-calendar-month-label");
    if (!grid) return;

    const t = todayParts();
    const firstOfMonth = new Date(viewedYear, viewedMonth, 1);
    const startWeekday = firstOfMonth.getDay(); // 0 = Sunday
    const daysInMonth = new Date(viewedYear, viewedMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(viewedYear, viewedMonth, 0).getDate();

    if (label) {
        label.textContent = firstOfMonth.toLocaleDateString("en-PH", { month: "short", year: "numeric" });
    }

    const cells = [];

    // Leading days from the previous month, so the grid always starts on Sunday.
    for (let i = startWeekday - 1; i >= 0; i--) {
        cells.push({ day: daysInPrevMonth - i, otherMonth: true });
    }

    // Real days of the viewed month.
    for (let day = 1; day <= daysInMonth; day++) {
        cells.push({ day, otherMonth: false });
    }

    // Trailing days from the next month, filling out to a multiple of 7.
    let trailDay = 1;
    while (cells.length % 7 !== 0) {
        cells.push({ day: trailDay, otherMonth: true });
        trailDay += 1;
    }

    grid.innerHTML = "";

    cells.forEach((cell) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cc-calendar-day";
        btn.textContent = String(cell.day);

        if (cell.otherMonth) {
            btn.classList.add("is-other-month");
            btn.disabled = true;
        } else {
            if (viewedYear === t.y && viewedMonth === t.m && cell.day === t.d) {
                btn.classList.add("is-today");
            }

            // Purely informational — lets other modules react to a picked
            // date later without this card needing to know about them.
            btn.addEventListener("click", () => {
                const picked = new Date(viewedYear, viewedMonth, cell.day);
                window.dispatchEvent(new CustomEvent("rp:calendar-day-selected", { detail: { date: picked } }));
            });
        }

        grid.appendChild(btn);
    });
}

document.addEventListener("DOMContentLoaded", initCalendar);
