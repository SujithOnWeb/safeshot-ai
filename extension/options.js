/**
 * options.js — SafeShot AI Settings Page Controller
 *
 * Manages the options/settings page where users configure:
 *  • Backend API URL (local or hosted)
 *  • API Key for authenticated backends
 *  • Regex fallback toggle
 *  • Auto-scan toggle
 */

const DEFAULTS = {
  apiBase: "http://127.0.0.1:8000",
  apiKey: "",
  regexFallback: true,
  autoScan: false,
};

// ── DOM References ─────────────────────────────────────────────────────────────
const apiUrlInput      = document.getElementById("apiUrl");
const apiKeyInput      = document.getElementById("apiKey");
const regexFallbackCb  = document.getElementById("regexFallback");
const autoScanCb       = document.getElementById("autoScan");
const btnSave          = document.getElementById("btnSave");
const btnTest          = document.getElementById("btnTest");
const btnReset         = document.getElementById("btnReset");
const toastSuccess     = document.getElementById("toastSuccess");
const toastError       = document.getElementById("toastError");

// ── Load saved settings ────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  const stored = await chrome.storage.local.get(["apiBase", "apiKey", "regexFallback", "autoScan"]);
  apiUrlInput.value     = stored.apiBase ?? DEFAULTS.apiBase;
  apiKeyInput.value     = stored.apiKey ?? DEFAULTS.apiKey;
  regexFallbackCb.checked = stored.regexFallback ?? DEFAULTS.regexFallback;
  autoScanCb.checked    = stored.autoScan ?? DEFAULTS.autoScan;
});

// ── Save ────────────────────────────────────────────────────────────────────────
btnSave.addEventListener("click", async () => {
  let url = apiUrlInput.value.trim();
  // Remove trailing slash
  if (url.endsWith("/")) url = url.slice(0, -1);
  // Basic URL validation
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    showToast("error", "URL must start with http:// or https://");
    return;
  }

  await chrome.storage.local.set({
    apiBase: url,
    apiKey: apiKeyInput.value.trim(),
    regexFallback: regexFallbackCb.checked,
    autoScan: autoScanCb.checked,
  });

  showToast("success", "Settings saved successfully.");
});

// ── Test connection ─────────────────────────────────────────────────────────────
btnTest.addEventListener("click", async () => {
  let url = apiUrlInput.value.trim();
  if (url.endsWith("/")) url = url.slice(0, -1);

  btnTest.textContent = "Testing…";
  btnTest.disabled = true;

  try {
    const headers = {};
    const key = apiKeyInput.value.trim();
    if (key) headers["X-API-Key"] = key;

    const res = await fetch(`${url}/health`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    showToast("success", `Connected! Presidio: ${data.presidio ? "✓" : "✗"} · LLM: ${data.llm ? "✓" : "✗"}`);
  } catch (err) {
    showToast("error", `Connection failed: ${err.message}`);
  } finally {
    btnTest.textContent = "Test Connection";
    btnTest.disabled = false;
  }
});

// ── Reset ───────────────────────────────────────────────────────────────────────
btnReset.addEventListener("click", async () => {
  apiUrlInput.value = DEFAULTS.apiBase;
  apiKeyInput.value = DEFAULTS.apiKey;
  regexFallbackCb.checked = DEFAULTS.regexFallback;
  autoScanCb.checked = DEFAULTS.autoScan;
  await chrome.storage.local.set(DEFAULTS);
  showToast("success", "Settings reset to defaults.");
});

// ── Toast helper ────────────────────────────────────────────────────────────────
function showToast(type, message) {
  const el = type === "success" ? toastSuccess : toastError;
  const other = type === "success" ? toastError : toastSuccess;
  other.style.display = "none";
  el.textContent = message;
  el.style.display = "block";
  setTimeout(() => { el.style.display = "none"; }, 4000);
}
