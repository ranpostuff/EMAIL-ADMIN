/* ==========================================================================
   RESCUEPRIORITY — CAMPUS FACILITY LIST (Student App copy)
   --------------------------------------------------------------------------
   This is a duplicate of the SCHOOL_FACILITIES list maintained in the main
   dashboard's script.js, kept here on purpose (same "zero dependency on the
   main dashboard's codebase" convention documented in app.js) so this app
   can power the "pick your real location on the map" picker without
   importing anything from the main project.

   Used for exactly one thing here: letting a reporting student choose
   WHERE something is actually happening, in case it's not the room their
   ID card/section says they belong to (hallway, canteen, gym, another
   section's room, etc.) — because real incidents don't always happen at
   your assigned seat.

   If a room is added/renamed/removed on the main dashboard, mirror the
   change here too.
========================================================================== */

export const SCHOOL_FACILITIES = [
    /* TOP WING (Left to Right) */
    { id: "top-fr-1", name: "F.R.", section: "Facility Room", zone: "Top Wing" },
    { id: "top-fr-2", name: "F.R.", section: "Facility Room", zone: "Top Wing" },
    { id: "top-9e", name: "9-E", section: "Grade 9-E", zone: "Top Wing" },
    { id: "top-10b", name: "10-B", section: "Grade 10-B", zone: "Top Wing" },
    { id: "top-10c", name: "10-C", section: "Grade 10-C", zone: "Top Wing" },
    { id: "top-10d", name: "10-D", section: "Grade 10-D", zone: "Top Wing" },
    { id: "top-cr-1", name: "C.R.", section: "Comfort Room", zone: "Top Wing" },
    { id: "top-fr-3", name: "F.R.", section: "Facility Room", zone: "Top Wing" },
    { id: "top-8f", name: "8-F", section: "Grade 8-F", zone: "Top Wing" },
    { id: "top-9c", name: "9-C", section: "Grade 9-C", zone: "Top Wing" },
    { id: "top-8b", name: "8-B", section: "Grade 8-B", zone: "Top Wing" },
    { id: "top-8d", name: "8-D", section: "Grade 8-D", zone: "Top Wing" },
    { id: "top-lib", name: "LIB.", section: "Library", zone: "Top Wing" },
    { id: "top-clinic", name: "CLINIC", section: "Medical Clinic", zone: "Top Wing" },
    { id: "top-fr-4", name: "F.R.", section: "Facility Room", zone: "Top Wing" },

    /* LEFT WING (Top to Bottom) */
    { id: "left-10e", name: "10-E", section: "Grade 10-E", zone: "Left Wing" },
    { id: "left-9b", name: "9-B", section: "Grade 9-B", zone: "Left Wing" },
    { id: "left-9d", name: "9-D", section: "Grade 9-D", zone: "Left Wing" },
    { id: "left-8e", name: "8-E", section: "Grade 8-E", zone: "Left Wing" },
    { id: "left-fr", name: "F.R.", section: "Facility Room", zone: "Left Wing" },
    { id: "left-canteen", name: "CANTEEN", section: "Food Services", zone: "Left Wing" },
    { id: "left-cr", name: "C.R.", section: "Comfort Room", zone: "Left Wing" },
    { id: "left-garnet", name: "11-GARNET", section: "Grade 11 Garnet", zone: "Left Wing" },
    { id: "left-fedorite", name: "12-FEDORITE", section: "Grade 12 Fedorite", zone: "Left Wing" },
    { id: "left-7a", name: "7-A", section: "Grade 7-A", zone: "Left Wing" },
    { id: "left-euclase", name: "12-EUCLASE", section: "Grade 12 Euclase", zone: "Left Wing" },
    { id: "left-ebony", name: "11-EBONY", section: "Grade 11 Ebony", zone: "Left Wing" },

    /* RIGHT WING (Top to Bottom) */
    { id: "right-8c", name: "8-C", section: "Grade 8-C", zone: "Right Wing" },
    { id: "right-8a", name: "8-A", section: "Grade 8-A", zone: "Right Wing" },
    { id: "right-he", name: "H.E.", section: "Home Economics", zone: "Right Wing" },
    { id: "right-7f", name: "7-F", section: "Grade 7-F", zone: "Right Wing" },
    { id: "right-7c", name: "7-C", section: "Grade 7-C", zone: "Right Wing" },
    { id: "right-7e", name: "7-E", section: "Grade 7-E", zone: "Right Wing" },
    { id: "right-7b", name: "7-B", section: "Grade 7-B", zone: "Right Wing" },
    { id: "right-ssig", name: "SSIG OFFICE", section: "SSIG", zone: "Right Wing" },

    /* BOTTOM BLOCK (Left to Right) */
    { id: "bottom-10a", name: "10-A", section: "Grade 10-A", zone: "Bottom Wing" },
    { id: "bottom-9a", name: "9-A OFFICE", section: "Grade 9-A", zone: "Bottom Wing" },
    { id: "bottom-po", name: "P. OFFICE", section: "Administration", zone: "Bottom Wing" },
    { id: "bottom-7d", name: "7-D", section: "Grade 7-D", zone: "Bottom Wing" },

    /* SHS BUILDING BLOCK 1 */
    { id: "shs1-sapphire", name: "12-SAPPHIRE", section: "Grade 12 Sapphire", zone: "SHS Building 1" },
    { id: "shs1-sci", name: "SCIENCE LAB", section: "Laboratory", zone: "SHS Building 1" },
    { id: "shs1-amethyst", name: "12-AMETHYST", section: "Grade 12 Amethyst", zone: "SHS Building 1" },
    { id: "shs1-amaranth", name: "11-AMARANTH", section: "Grade 11 Amaranth", zone: "SHS Building 1" },
    { id: "shs1-complab", name: "COMP LAB", section: "Computer Laboratory", zone: "SHS Building 1" },
    { id: "shs1-obsidian", name: "12-OBSIDIAN", section: "Grade 12 Obsidian", zone: "SHS Building 1" },
    { id: "shs1-honeydew", name: "11-HONEYDEW", section: "Grade 11 Honeydew", zone: "SHS Building 1" },
    { id: "shs1-epidote", name: "12-EPIDOTE", section: "Grade 12 Epidote", zone: "SHS Building 1" },

    /* SHS BUILDING BLOCK 2 */
    { id: "shs2-fuschia", name: "11-FUSCHIA", section: "Grade 11 Fuschia", zone: "SHS Building 2" },
    { id: "shs2-driftwood", name: "11-DRIFTWOOD", section: "Grade 11 Driftwood", zone: "SHS Building 2" },
    { id: "shs2-emerald", name: "12-EMERALD", section: "Grade 12 Emerald", zone: "SHS Building 2" },
    { id: "shs2-cr1", name: "C.R.", section: "Comfort Room", zone: "SHS Building 2" },
    { id: "shs2-burgundy", name: "11-BURGUNDY", section: "Grade 11 Burgundy", zone: "SHS Building 2" },
    { id: "shs2-bloodstone", name: "12-BLOODSTONE", section: "Grade 12 Bloodstone", zone: "SHS Building 2" },
    { id: "shs2-cerulean", name: "11-CERULEAN", section: "Grade 11 Cerulean", zone: "SHS Building 2" },
    { id: "shs2-cr2", name: "C.R.", section: "Comfort Room", zone: "SHS Building 2" }
];

const FACILITY_DISPLAY_NAMES = {
    "F.R.": "Facility Room",
    "9-A OFFICE": "9-A"
};

export function displayFacilityName(name) {
    return FACILITY_DISPLAY_NAMES[name] || name;
}

export function findFacility(facilityId) {
    return SCHOOL_FACILITIES.find((f) => f.id === facilityId) || null;
}

// Stable zone order for the map picker (matches the physical layout used
// on the main dashboard's Campus Map).
export const ZONE_ORDER = [
    "Top Wing",
    "Left Wing",
    "Right Wing",
    "Bottom Wing",
    "SHS Building 1",
    "SHS Building 2"
];
