/**
 * license.js — 
 * Handles: activation, offline validation, periodic re-verification
 * Loaded AFTER db.js and app.js in index.html
 * Calls window.__bootApp() when a valid license is confirmed
 */

const LICENSE_CONFIG = {
  serverUrl: "https://yeilva-store-server.up.railway.app",
  storeUrl: "https://yeilvastore.com",
  dbName: "TindahanLicenseDB", 
  dbVersion: 1,
  verifyEveryDays: 30,
  gracePeriodDays: 7,
};

// ── Tiny dedicated IndexedDB for license storage ──────────────────────────
const LicenseDB = (() => {
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(LICENSE_CONFIG.dbName, LICENSE_CONFIG.dbVersion);
      req.onupgradeneeded = (e) => {
        e.target.result.createObjectStore("kv", { keyPath: "key" });
      };
      req.onsuccess = (e) => { 
        _db = e.target.result; 
        resolve(_db); 
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function get(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction("kv", "readonly").objectStore("kv").get(key);
      req.onsuccess = () => resolve(req.result?.value ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async function set(key, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return { get, set };
})();

// ── Device fingerprint ────────────────────────────────────────────────────
async function generateFingerprint() {
  const raw = [
    navigator.userAgent,
    navigator.language,
    `${screen.width}x${screen.height}`,
    screen.colorDepth,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    navigator.hardwareConcurrency || 0,
    navigator.maxTouchPoints || 0,
  ].join("|");

  const data = new TextEncoder().encode(raw);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Stable device ID ──────────────────────────────────────────────────────
async function getOrCreateDeviceId() {
  let id = await LicenseDB.get("deviceId");
  if (!id) {
    id = crypto.randomUUID
      ? crypto.randomUUID()
      : "dev-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    await LicenseDB.set("deviceId", id);
  }
  return id;
}

// ── Extract token from URL ────────────────────────────────────────────────
function getTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token") || null;
}

function removeTokenFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("token");
  window.history.replaceState({}, document.title, url.pathname + url.search);
}

// ── UI state machine ──────────────────────────────────────────────────────
function showChecking() {
  const el = (id) => document.getElementById(id);
  if(el("lcChecking")) el("lcChecking").hidden = false;
  if(el("lcActivating")) el("lcActivating").hidden = true;
  if(el("lcPurchaseWall")) el("lcPurchaseWall").hidden = true;
  if(el("lcErrorState")) el("lcErrorState").hidden = true;
  if(el("lcSuccess")) el("lcSuccess").hidden = true;
  if(el("licenseGate")) el("licenseGate").hidden = false;
}

function showActivating() {
  const el = (id) => document.getElementById(id);
  if(el("lcChecking")) el("lcChecking").hidden = true;
  if(el("lcActivating")) el("lcActivating").hidden = false;
  if(el("lcPurchaseWall")) el("lcPurchaseWall").hidden = true;
  if(el("lcErrorState")) el("lcErrorState").hidden = true;
  if(el("lcSuccess")) el("lcSuccess").hidden = true;
}

function showPurchaseWall() {
  const el = (id) => document.getElementById(id);
  if(el("lcChecking")) el("lcChecking").hidden = true;
  if(el("lcActivating")) el("lcActivating").hidden = true;
  if(el("lcPurchaseWall")) el("lcPurchaseWall").hidden = false;
  if(el("lcErrorState")) el("lcErrorState").hidden = true;
  if(el("lcSuccess")) el("lcSuccess").hidden = true;
}

function showError(msg) {
  const el = (id) => document.getElementById(id);
  if(el("lcChecking")) el("lcChecking").hidden = true;
  if(el("lcActivating")) el("lcActivating").hidden = true;
  if(el("lcPurchaseWall")) el("lcPurchaseWall").hidden = true;
  if(el("lcErrorState")) el("lcErrorState").hidden = false;
  if(el("lcSuccess")) el("lcSuccess").hidden = true;
  if(el("lcErrorMsg")) el("lcErrorMsg").textContent = msg;
}

function setLicenseError(msg) {
  const el = document.getElementById("lcInlineError");
  if (el) {
    el.textContent = msg;
    el.hidden = !msg;
  }
}

function showActivationSuccess(email) {
  const el = (id) => document.getElementById(id);
  if(el("lcChecking")) el("lcChecking").hidden = true;
  if(el("lcActivating")) el("lcActivating").hidden = true;
  if(el("lcPurchaseWall")) el("lcPurchaseWall").hidden = true;
  if(el("lcErrorState")) el("lcErrorState").hidden = true;
  if(el("lcSuccess")) el("lcSuccess").hidden = false;

  const emailEl = document.getElementById("lcSuccessEmail");
  if (emailEl) emailEl.textContent = "Licensed to: " + email;
}

function bootApp() {
  const gate = document.getElementById("licenseGate");
  if (gate) gate.hidden = true;
  
  // Call the boot function defined in app.js
  if (typeof window.__bootApp === "function") {
    window.__bootApp();
  } else {
    console.error("[License] window.__bootApp is not defined. Did app.js load correctly?");
  }
}

// ── Should we re-verify today? ────────────────────────────────────────────
function shouldVerify(license) {
  if (!license.lastVerified) return true;
  const daysSince = (Date.now() - new Date(license.lastVerified).getTime()) / 86400000;
  return daysSince >= LICENSE_CONFIG.verifyEveryDays;
}

function isWithinGracePeriod(license) {
  if (!license.lastVerified) return false;
  const daysSince = (Date.now() - new Date(license.lastVerified).getTime()) / 86400000;
  return daysSince <= LICENSE_CONFIG.verifyEveryDays + LICENSE_CONFIG.gracePeriodDays;
}

// ── API calls ─────────────────────────────────────────────────────────────
async function apiActivate(token, deviceId, fingerprint) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(`${LICENSE_CONFIG.serverUrl}/api/license/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, deviceId, fingerprint }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await res.json();
    if (!res.ok) throw { status: res.status, ...data };
    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

async function apiVerify(token, deviceId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(
      `${LICENSE_CONFIG.serverUrl}/api/license/verify?token=${token}&deviceId=${deviceId}`,
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);
    const data = await res.json();
    return { ok: res.ok, ...data };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// ── Store / retrieve license from IndexedDB ───────────────────────────────
async function storeLicense({ token, email, buyerName, activatedAt }) {
  await LicenseDB.set("license", {
    token,
    email,
    buyerName: buyerName || "",
    activatedAt,
    lastVerified: new Date().toISOString(),
    storedAt: new Date().toISOString(),
  });
}

async function updateLastVerified() {
  const license = await LicenseDB.get("license");
  if (license) {
    license.lastVerified = new Date().toISOString();
    await LicenseDB.set("license", license);
  }
}

// ── Activation flow ───────────────────────────────────────────────────────
async function attemptActivation(token) {
  try {
    const deviceId = await getOrCreateDeviceId();
    const fingerprint = await generateFingerprint();

    const result = await apiActivate(token, deviceId, fingerprint);

    await storeLicense({
      token,
      email: result.email,
      buyerName: result.buyerName,
      activatedAt: result.activatedAt,
    });

    removeTokenFromUrl();
    showActivationSuccess(result.email);
  } catch (err) {
    console.error("[License] Activation failed:", err);

    if (err.alreadyClaimed) {
      showError("This license is already activated on another device. Each license is for one device only. Purchase a new license at yeilvastore.com");
      return;
    }

    if (err.status === 404) {
      showPurchaseWall();
      setLicenseError("Token not found. Check your email or purchase a new license.");
      return;
    }

    if (err.status === 403) {
      showError(err.error || "This license is not valid.");
      return;
    }

    // Network error — if they have a stored license, let them in anyway
    const stored = await LicenseDB.get("license");
    if (stored) {
      console.warn("[License] Activation network error — using stored license as fallback");
      bootApp();
      return;
    }

    showPurchaseWall();
    setLicenseError("Could not connect to license server. Check your internet connection.");
  }
}

// ── Main license check (runs on every app open) ───────────────────────────
(async function checkLicense() {
  try {
    showChecking();

    const urlToken = getTokenFromUrl();
    const stored = await LicenseDB.get("license");
    const deviceId = await getOrCreateDeviceId();

    // Case 1: Token in URL → always try to activate
    if (urlToken) {
      showActivating();
      await attemptActivation(urlToken);
      return;
    }

    // Case 2: No stored license → show purchase wall
    if (!stored || !stored.token) {
      showPurchaseWall();
      return;
    }

    // Case 3: Stored license exists
    // 3a: Online + due for re-verification
    if (navigator.onLine && shouldVerify(stored)) {
      try {
        const result = await apiVerify(stored.token, deviceId);

        if (result.valid) {
          await updateLastVerified();
          const sub = document.getElementById("dbStatus");
          if (sub) sub.textContent = `Licensed · ${stored.email}`;
          bootApp();
          return;
        }

        // Server says invalid — check grace period before locking out
        if (isWithinGracePeriod(stored)) {
          console.warn("[License] Verify failed but within grace period — allowing access");
          bootApp();
          return;
        }

        // Outside grace period and invalid → lock out
        showError(
          result.error === "License revoked"
            ? "Your license has been revoked. Contact yeilvastore.com for support."
            : "Your license could not be verified. Contact yeilvastore.com"
        );
        return;
      } catch (networkErr) {
        // Network error during verify → trust stored license + grace period
        console.warn("[License] Verify network error — trusting stored license");
        bootApp();
        return;
      }
    }

    // 3b: Offline or not due for verify → trust stored license
    const sub = document.getElementById("dbStatus");
    if (sub) sub.textContent = `Licensed · ${stored.email}`;
    bootApp();

  } catch (fatalErr) {
    console.error("[License] Fatal error:", fatalErr);
    // Something went very wrong — allow access rather than lock out a valid buyer
    bootApp();
  }
})();

// ── Manual token input handler ────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const openAppBtn = document.getElementById("lcOpenAppBtn");
  if (openAppBtn) {
    openAppBtn.addEventListener("click", () => {
      window.location.href = "./";
    });
  }

  const activateBtn = document.getElementById("lcActivateBtn");
  if (activateBtn) {
    activateBtn.addEventListener("click", async () => {
      const input = document.getElementById("lcTokenInput");
      const raw = (input?.value || "").trim();
      if (!raw) { setLicenseError("Please paste your token or activation link"); return; }

      let token = raw;
      try {
        const url = new URL(raw);
        token = url.searchParams.get("token") || raw;
      } catch {}

      if (!token || token.length < 20) {
        setLicenseError("That doesn't look like a valid token. Check your email.");
        return;
      }

      setLicenseError("");
      showActivating();
      await attemptActivation(token);
    });
  }
});