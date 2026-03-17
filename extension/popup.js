/**
 * popup.js — SafeShot AI Popup Controller
 *
 * Handles all popup UI interactions:
 *  • AI service health check
 *  • Detect & Mask PII button
 *  • Manual mask mode toggle
 *  • Screenshot capture
 *  • Mask style switching
 */

// ── API config (loaded from chrome.storage, set via options page) ──────────────
let API_BASE = "http://127.0.0.1:8000";
let API_KEY  = "";

// ── DOM References ─────────────────────────────────────────────────────────────
const statusDot     = document.getElementById("statusDot");
const statusText    = document.getElementById("statusText");
const btnDetect     = document.getElementById("btnDetect");
const btnManual     = document.getElementById("btnManual");
const btnRemove     = document.getElementById("btnRemove");
const btnCapture    = document.getElementById("btnCapture");
const detectSpinner = document.getElementById("detectSpinner");
const statDetected  = document.getElementById("statDetected");
const statMasked    = document.getElementById("statMasked");
const statManual    = document.getElementById("statManual");
const maskOptions   = document.querySelectorAll(".mask-option");
const engineOptions = document.querySelectorAll(".engine-option");
const enginePresidio = document.getElementById("enginePresidio");
const engineLLM     = document.getElementById("engineLLM");
const piiConfigToggle = document.getElementById("piiConfigToggle");
const piiArrow      = document.getElementById("piiArrow");
const piiGrid       = document.getElementById("piiGrid");
const piiCheckboxes = document.querySelectorAll('.pii-toggle input[type="checkbox"]');

// ── State ──────────────────────────────────────────────────────────────────────
let currentMaskStyle = "blur";
let manualModeActive = false;
let enabledPIITypes = {}; // { "PERSON": true, "EMAIL_ADDRESS": true, ... }
let detectionEngine = "presidio"; // "presidio" | "llm"

// ── Initialise on popup open ───────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Load API config first
  const config = await chrome.storage.local.get(["apiBase", "apiKey"]);
  if (config.apiBase) API_BASE = config.apiBase;
  if (config.apiKey)  API_KEY  = config.apiKey;

  // Restore saved mask style
  const stored = await chrome.storage.local.get(["maskStyle", "enabledPIITypes", "detectionEngine"]);
  if (stored.maskStyle) {
    currentMaskStyle = stored.maskStyle;
    maskOptions.forEach((opt) => {
      opt.classList.toggle("active", opt.dataset.style === currentMaskStyle);
    });
  }

  // Restore saved detection engine
  if (stored.detectionEngine) {
    detectionEngine = stored.detectionEngine;
    engineOptions.forEach((opt) => {
      opt.classList.toggle("active", opt.dataset.engine === detectionEngine);
    });
  }

  // Restore saved PII type toggles
  if (stored.enabledPIITypes) {
    enabledPIITypes = stored.enabledPIITypes;
    piiCheckboxes.forEach((cb) => {
      const type = cb.dataset.pii;
      if (type in enabledPIITypes) {
        cb.checked = enabledPIITypes[type];
      }
    });
  } else {
    // Default: read from checkbox defaults in HTML
    piiCheckboxes.forEach((cb) => {
      enabledPIITypes[cb.dataset.pii] = cb.checked;
    });
  }

  checkServiceHealth();
});

// ── Health check ───────────────────────────────────────────────────────────────
async function checkServiceHealth() {
  try {
    const headers = {};
    if (API_KEY) headers["X-API-Key"] = API_KEY;
    const res = await fetch(`${API_BASE}/health`, { method: "GET", headers });
    if (res.ok) {
      const data = await res.json();
      statusDot.classList.add("connected");
      statusText.textContent = "AI service connected";

      // Update LLM engine availability badge
      if (data.llm) {
        engineLLM.classList.remove("unavailable");
        const badge = engineLLM.querySelector(".engine-badge");
        if (badge) { badge.className = "engine-badge badge-new"; badge.textContent = "v2"; }
      } else {
        engineLLM.classList.add("unavailable");
        const badge = engineLLM.querySelector(".engine-badge");
        if (badge) { badge.className = "engine-badge badge-off"; badge.textContent = "OFF"; }
      }
    } else {
      throw new Error("non-200");
    }
  } catch {
    statusDot.classList.remove("connected");
    statusText.textContent = "AI service offline — using rules only";
    engineLLM.classList.add("unavailable");
  }
}

// ── Mask style selector ────────────────────────────────────────────────────────
maskOptions.forEach((opt) => {
  opt.addEventListener("click", () => {
    maskOptions.forEach((o) => o.classList.remove("active"));
    opt.classList.add("active");
    currentMaskStyle = opt.dataset.style;
    chrome.storage.local.set({ maskStyle: currentMaskStyle });

    // Tell content script about new style
    sendToContentScript({ action: "changeMaskStyle", style: currentMaskStyle });
  });
});

// ── Detection engine selector ─────────────────────────────────────────────────
engineOptions.forEach((opt) => {
  opt.addEventListener("click", () => {
    // Don't allow selecting unavailable engine
    if (opt.classList.contains("unavailable")) {
      statusText.textContent = "LLM engine not available — install Ollama";
      setTimeout(() => checkServiceHealth(), 2000);
      return;
    }
    engineOptions.forEach((o) => o.classList.remove("active"));
    opt.classList.add("active");
    detectionEngine = opt.dataset.engine;
    chrome.storage.local.set({ detectionEngine });
    statusText.textContent = `Engine: ${detectionEngine === "llm" ? "Local LLM (Ollama)" : "Presidio + spaCy"}`;
    setTimeout(() => checkServiceHealth(), 2000);
  });
});

// ── PII Config toggle (collapsible) ────────────────────────────────────────────
piiConfigToggle.addEventListener("click", () => {
  piiGrid.classList.toggle("open");
  piiArrow.classList.toggle("open");
});

// ── PII type checkboxes ────────────────────────────────────────────────────────
piiCheckboxes.forEach((cb) => {
  cb.addEventListener("change", () => {
    enabledPIITypes[cb.dataset.pii] = cb.checked;
    chrome.storage.local.set({ enabledPIITypes });
    // Notify content script about updated config
    sendToContentScript({ action: "updatePIIConfig", enabledTypes: enabledPIITypes });
  });
});

// ── Detect & Mask PII ──────────────────────────────────────────────────────────
btnDetect.addEventListener("click", async () => {
  detectSpinner.style.display = "inline-block";
  btnDetect.disabled = true;

  try {
    const response = await sendToContentScript({
      action: "detectAndMask",
      style: currentMaskStyle,
      enabledTypes: enabledPIITypes,
      engine: detectionEngine,
    });

    if (response) {
      statDetected.textContent = response.detected ?? 0;
      statMasked.textContent   = response.masked ?? 0;
    }
  } catch (err) {
    console.error("Detection failed:", err);
  } finally {
    detectSpinner.style.display = "none";
    btnDetect.disabled = false;
  }
});

// ── Manual Mask Mode ───────────────────────────────────────────────────────────
btnManual.addEventListener("click", async () => {
  manualModeActive = !manualModeActive;
  btnManual.style.background = manualModeActive ? "#7c3aed" : "#334155";

  const response = await sendToContentScript({
    action: "toggleManualMask",
    enabled: manualModeActive,
    style: currentMaskStyle,
  });

  if (response && response.manualCount !== undefined) {
    statManual.textContent = response.manualCount;
  }
});

// ── Remove All Masking ──────────────────────────────────────────────────────────
btnRemove.addEventListener("click", async () => {
  const response = await sendToContentScript({ action: "removeAllMasks" });
  if (response) {
    statDetected.textContent = "0";
    statMasked.textContent   = "0";
    statManual.textContent   = "0";
    statusText.textContent = "All masks removed";
    setTimeout(() => checkServiceHealth(), 2000);
  }
});

// ── Capture Screenshot ─────────────────────────────────────────────────────────
btnCapture.addEventListener("click", async () => {
  // Tell background.js to capture the visible tab
  chrome.runtime.sendMessage({ action: "captureScreenshot" }, (response) => {
    if (response && response.success) {
      statusText.textContent = "Screenshot saved!";
      setTimeout(() => { statusText.textContent = "AI service connected"; }, 2000);
    } else {
      statusText.textContent = "Screenshot failed";
    }
  });
});

// ── Helper: send message to the content script of the active tab ───────────────
function sendToContentScript(message) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return resolve(null);
      chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
        resolve(response);
      });
    });
  });
}

// ── Settings page link ─────────────────────────────────────────────────────────
document.getElementById("openSettings")?.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
