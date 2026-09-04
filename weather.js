/* ==========================================================================
   RESCUEPRIORITY — TEMPERATURE KPI
   Fetches the live temperature for Maasin City (MCNHS area) from Open-Meteo
   (a free, no-API-key weather service) and recolors the Temperature KPI
   card based on the reading. Runs independently of script.js — no Firebase
   or dashboard state is touched here, so this cannot affect the rest of
   the dashboard if the weather service is unreachable.
========================================================================== */

const MAASIN_LAT = 10.1330;
const MAASIN_LON = 124.8460;
const REFRESH_MS = 10 * 60 * 1000; // refresh every 10 minutes

// Ordered low -> high; a reading is placed in the first band whose max it
// does not exceed. Thresholds follow the brief's suggested convention and
// can be tuned here without touching any other logic.
const TEMP_BANDS = [
    { max: 20, cls: "temp-cold", label: "Cold" },
    { max: 24, cls: "temp-cool", label: "Cool" },
    { max: 27, cls: "temp-comfortable", label: "Comfortable" },
    { max: 31, cls: "temp-warm", label: "Warm" },
    { max: Infinity, cls: "temp-hot", label: "Hot" }
];

const ALL_TEMP_CLASSES = TEMP_BANDS.map(b => b.cls);

function bandFor(tempC) {
    return TEMP_BANDS.find(b => tempC <= b.max) || TEMP_BANDS[TEMP_BANDS.length - 1];
}

function applyTempState(elements, state) {
    const { card, valueEl, badgeEl, footEl } = elements;

    ALL_TEMP_CLASSES.forEach(cls => card.classList.remove(cls));
    card.classList.remove("temp-unavailable");

    if (state.unavailable) {
        card.classList.add("temp-unavailable");
        valueEl.textContent = "--\u00b0C";
        badgeEl.textContent = "N/A";
        footEl.textContent = "Weather unavailable";
        return;
    }

    const band = bandFor(state.temp);
    card.classList.add(band.cls);
    valueEl.textContent = `${Math.round(state.temp)}\u00b0C`;
    badgeEl.textContent = band.label;
    footEl.textContent = "Maasin City \u00b7 MCNHS area";
}

async function fetchTemperature() {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${MAASIN_LAT}&longitude=${MAASIN_LON}&current=temperature_2m&timezone=Asia%2FManila`;
    const response = await fetch(url);
    if (!response.ok) throw new Error("Weather service error");

    const data = await response.json();
    const temp = data && data.current ? data.current.temperature_2m : undefined;
    if (typeof temp !== "number" || Number.isNaN(temp)) {
        throw new Error("Malformed weather response");
    }
    return temp;
}

function getElements() {
    const card = document.getElementById("temp-kpi-card");
    const valueEl = document.getElementById("temp-value");
    const badgeEl = document.getElementById("temp-badge");
    const footEl = document.getElementById("temp-foot");
    if (!card || !valueEl || !badgeEl || !footEl) return null;
    return { card, valueEl, badgeEl, footEl };
}

async function refreshTemperatureCard() {
    const elements = getElements();
    if (!elements) return;

    try {
        const temp = await fetchTemperature();
        applyTempState(elements, { temp });
    } catch (err) {
        applyTempState(elements, { unavailable: true });
    }
}

document.addEventListener("DOMContentLoaded", () => {
    refreshTemperatureCard();
    setInterval(refreshTemperatureCard, REFRESH_MS);
});
