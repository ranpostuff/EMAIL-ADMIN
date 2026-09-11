/* ==========================================================================
   RESCUEPRIORITY — COMMAND CENTER AUTH GATE
   --------------------------------------------------------------------------
   Loaded first (see index.html's script order) so the gate is wired up
   before the rest of the dashboard's modules start rendering behind it.

   Two-part check, same idea as any allowlisted admin panel:
     1. Firebase Authentication — the person has to sign in with a real
        email/password account (created in Firebase Console -> Authentication;
        this app has no public sign-up form on purpose).
     2. admins/{uid} — the signed-in account also has to be listed in the
        Realtime Database as an authorized admin. A Firebase Auth account by
        itself does NOT grant dashboard access; see RULES-NOTES.md for how
        to add the first admin (a one-time manual step via Firebase Console,
        since the database rules can't let an unlisted account list itself
        as authorized — same bootstrap problem any allowlist has).

   Everything else in this app (script.js and every other module) keeps
   running its own DOMContentLoaded setup regardless of auth state — reads
   on students/sections/classrooms/incidents stay public (the Student
   Incident Reporter app depends on that; see database.rules.json) so data
   loads in the background same as before. This file's only job is to keep
   .app-shell hidden behind #auth-gate until someone authorized signs in.
========================================================================== */

import { firebaseApp, database } from "./script.js";
import {
    getAuth,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    signOut
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { ref, get } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const auth = getAuth(firebaseApp);

document.addEventListener("DOMContentLoaded", () => {
    setupLoginForm();
    setupLogoutButton();

    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            showGate();
            return;
        }

        showChecking();

        let isAuthorized = false;
        try {
            console.log("[auth-debug] checking uid:", JSON.stringify(user.uid), "length:", user.uid.length);
            const snapshot = await get(ref(database, `admins/${user.uid}`));
            console.log("[auth-debug] snapshot exists:", snapshot.exists(), "val:", snapshot.val());
            isAuthorized = snapshot.exists();
        } catch (error) {
            console.error("[auth] Failed to check admin allowlist:", error);
            showLoginError("Couldn't verify your access. Check your connection and try again.");
            await signOut(auth);
            return;
        }

        if (!isAuthorized) {
            showLoginError("This account isn't authorized for the Command Center. Contact your system administrator.");
            await signOut(auth);
            return;
        }

        unlockDashboard(user);
    });
});

function setupLoginForm() {
    const form = document.getElementById("auth-login-form");
    if (!form) return;

    form.addEventListener("submit", async (event) => {
        event.preventDefault();

        const emailInput = document.getElementById("auth-email");
        const passwordInput = document.getElementById("auth-password");
        const submitBtn = document.getElementById("auth-login-btn");

        const email = emailInput ? emailInput.value.trim() : "";
        const password = passwordInput ? passwordInput.value : "";
        if (!email || !password) return;

        hideLoginError();
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = "Signing In\u2026";
        }

        try {
            await signInWithEmailAndPassword(auth, email, password);
            // onAuthStateChanged above takes it from here (allowlist check,
            // then unlockDashboard()).
        } catch (error) {
            showLoginError(friendlyAuthError(error));
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = "Sign In";
            }
        }
    });
}

function setupLogoutButton() {
    const btn = document.getElementById("btn-logout");
    if (!btn) return;
    btn.addEventListener("click", () => {
        signOut(auth).catch((error) => console.error("[auth] Sign out failed:", error));
    });
}

function friendlyAuthError(error) {
    const code = error && error.code;
    if (code === "auth/invalid-email") return "That doesn't look like a valid email address.";
    if (code === "auth/user-disabled") return "This account has been disabled. Contact your system administrator.";
    if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
        return "Incorrect email or password.";
    }
    if (code === "auth/too-many-requests") return "Too many attempts. Wait a bit and try again.";
    return "Couldn't sign in. Check your connection and try again.";
}

function showGate() {
    const gate = document.getElementById("auth-gate");
    const shell = document.querySelector(".app-shell");
    const checking = document.getElementById("auth-checking");
    const form = document.getElementById("auth-login-form");

    if (gate) gate.classList.remove("hidden");
    if (shell) shell.classList.add("hidden");
    if (checking) checking.classList.add("hidden");
    if (form) form.classList.remove("hidden");
}

function showChecking() {
    const checking = document.getElementById("auth-checking");
    const form = document.getElementById("auth-login-form");
    if (checking) checking.classList.remove("hidden");
    if (form) form.classList.add("hidden");
}

function showLoginError(message) {
    showGate();
    const el = document.getElementById("auth-login-error");
    if (el) {
        el.textContent = message;
        el.classList.remove("hidden");
    }
}

function hideLoginError() {
    const el = document.getElementById("auth-login-error");
    if (el) el.classList.add("hidden");
}

function unlockDashboard(user) {
    const gate = document.getElementById("auth-gate");
    const shell = document.querySelector(".app-shell");
    const emailEl = document.getElementById("sidebar-account-email");
    const metaEl = document.getElementById("admin-account-meta");

    if (gate) gate.classList.add("hidden");
    if (shell) shell.classList.remove("hidden");
    if (emailEl) emailEl.textContent = user.email || "Signed in";

    const emailLocal = (user.email || "").split("@")[0];
    const fallbackName = emailLocal
        ? emailLocal.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
        : "Administrator";
    const displayName = (user.displayName || fallbackName).trim();
    document.documentElement.dataset.adminName = displayName;
    if (metaEl) metaEl.textContent = `Administrator${user.email ? ` • ${user.email}` : ""}`;
    window.dispatchEvent(new CustomEvent("rp:admin-identity", { detail: { displayName, email: user.email || "" } }));
}
