/* ==========================================================================
   RESCUEPRIORITY — CAMPUS MAP ADMIN TESTING TOOL
   --------------------------------------------------------------------------
   Lets an administrator type a room/classroom name and raise a simulated
   emergency there, to verify room highlighting and the emergency
   notification system without needing real ESP32 hardware. Only rendered
   on the Admin dashboard (this file is not shipped to the student app).
========================================================================== */

import { SCHOOL_FACILITIES, displayFacilityName, raiseClassroomEmergency } from "./script.js";

document.addEventListener("DOMContentLoaded", () => {
    const input = document.getElementById("map-testing-room-input");
    const datalist = document.getElementById("map-testing-room-list");
    const triggerBtn = document.getElementById("map-testing-trigger-btn");
    const status = document.getElementById("map-testing-status");

    if (!input || !triggerBtn) return;

    if (datalist) {
        datalist.innerHTML = SCHOOL_FACILITIES
            .map((f) => `<option value="${displayFacilityName(f.name)}"></option>`)
            .join("");
    }

    function findFacility(query) {
        const normalized = query.trim().toLowerCase();
        if (!normalized) return null;
        return SCHOOL_FACILITIES.find(
            (f) => displayFacilityName(f.name).toLowerCase() === normalized || f.name.toLowerCase() === normalized
        ) || SCHOOL_FACILITIES.find((f) => displayFacilityName(f.name).toLowerCase().includes(normalized));
    }

    async function trigger() {
        const facility = findFacility(input.value);
        if (!facility) {
            if (status) {
                status.textContent = "No matching room found.";
                status.className = "map-testing-status is-error";
            }
            return;
        }

        triggerBtn.disabled = true;
        try {
            await raiseClassroomEmergency(facility);
            if (status) {
                status.textContent = `Test incident triggered in ${displayFacilityName(facility.name)}.`;
                status.className = "map-testing-status is-success";
            }
        } catch (error) {
            console.error("[map testing tool] Failed to trigger test incident:", error);
            if (status) {
                status.textContent = "Failed to trigger — check console.";
                status.className = "map-testing-status is-error";
            }
        } finally {
            triggerBtn.disabled = false;
        }
    }

    triggerBtn.addEventListener("click", trigger);
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") trigger();
    });
});
