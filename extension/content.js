/**
 * content.js — SafeShot AI Content Script
 *
 * Runs in the context of every web page. Responsible for:
 *  1. Extracting visible text & form values from the DOM
 *  2. Sending text to the AI PII-detection API
 *  3. Locating detected PII on the page & applying mask overlays
 *  4. Manual mask mode (click-to-mask)
 *  5. MutationObserver for dynamic content re-scanning
 *
 * v1.1 — Fixes for dynamic CRM UIs (Dynamics 365, Salesforce, etc.):
 *  • Incremental overlay updates (no remove-then-reapply blink)
 *  • Observer paused while modifying DOM (prevents self-trigger loops)
 *  • Smarter debounce (1.5 s) with scan-lock to prevent pile-ups
 *  • Overlays tracked per target element via WeakMap
 *  • Scroll / resize repositioning without full re-scan
 */

// ── Configuration ──────────────────────────────────────────────────────────────
let API_BASE = "http://127.0.0.1:8000"; // default — overridden from chrome.storage
const MASK_ATTR = "data-safeshot-masked";

// Load user-configured API URL + API key from storage
let API_KEY = "";
let regexFallbackEnabled = true;
let autoScanEnabled = false;

(async () => {
  try {
    const stored = await chrome.storage.local.get(["apiBase", "apiKey", "regexFallback", "autoScan"]);
    if (stored.apiBase) API_BASE = stored.apiBase;
    if (stored.apiKey) API_KEY = stored.apiKey;
    if (stored.regexFallback !== undefined) regexFallbackEnabled = stored.regexFallback;
    if (stored.autoScan !== undefined) autoScanEnabled = stored.autoScan;
    console.log(`[SafeShot AI] Backend URL: ${API_BASE}`);
    // Auto-scan if enabled
    if (autoScanEnabled) {
      setTimeout(() => handleDetectAndMask(true), 2000);
    }
  } catch (e) {
    console.warn("[SafeShot] Could not load settings:", e);
  }
})();

// Listen for storage changes (user updates settings while page is open)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.apiBase) API_BASE = changes.apiBase.newValue;
  if (changes.apiKey) API_KEY = changes.apiKey.newValue;
  if (changes.regexFallback) regexFallbackEnabled = changes.regexFallback.newValue;
  if (changes.autoScan) autoScanEnabled = changes.autoScan.newValue;
});
const OVERLAY_CLASS = "safeshot-overlay";
const MANUAL_HIGHLIGHT = "safeshot-manual-highlight";
const RESCAN_DEBOUNCE_MS = 1500; // Longer debounce for dynamic CRM UIs

// ── State ──────────────────────────────────────────────────────────────────────
let maskStyle = "blur"; // "blur" | "blackbox" | "replace"
let manualMode = false;
let manualCount = 0;
let detectedCount = 0;
let maskedCount = 0;
let scanInProgress = false;         // Lock — prevents concurrent scans
let hasScanRun = false;             // True after first user-triggered scan
let detectionEngine = "presidio";   // "presidio" | "llm" — set by popup
let lastPIIValues = [];             // Cache detected PII values for incremental re-scans
let lastScanTimestamp = 0;          // Epoch ms of last completed scan
const MIN_RESCAN_INTERVAL_MS = 3000; // Minimum gap between observer-triggered scans

// PII type configuration — which types to detect/mask (all enabled by default)
let enabledPIITypes = {
  PERSON: true, EMAIL_ADDRESS: true, PHONE_NUMBER: true,
  CREDIT_CARD: true, US_SSN: true, AADHAAR_NUMBER: true,
  PAN_NUMBER: true, BANK_ACCOUNT: true, IP_ADDRESS: true,
  LOCATION: true, DATE_TIME: false, URL: false,
  PASSWORD_FIELD: true, FORM_FIELDS: true,
};

// Overlay tracking: target element → overlay div
const overlayMap = new WeakMap();

// ── Regex-based fallback PII patterns (used when AI service is offline) ────────
const PII_PATTERNS = {
  EMAIL: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  PHONE: /(\+?\d{1,3}[\s\-]?)?(\(?\d{2,4}\)?[\s\-]?)?\d{3,4}[\s\-]?\d{4}/g,
  SSN: /\b\d{3}[\-\s]?\d{2}[\-\s]?\d{4}\b/g,
  CREDIT_CARD: /\b(?:\d{4}[\s\-]?){3}\d{4}\b/g,
  AADHAAR: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g,
  IP_ADDRESS: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
};

// ══════════════════════════════════════════════════════════════════════════════
//  MESSAGE LISTENER — receives commands from popup.js
// ══════════════════════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case "detectAndMask":
      maskStyle = msg.style || maskStyle;
      if (msg.enabledTypes) enabledPIITypes = { ...enabledPIITypes, ...msg.enabledTypes };
      if (msg.engine) detectionEngine = msg.engine;
      handleDetectAndMask(/* fullScan */ true).then(sendResponse);
      return true; // async response

    case "toggleManualMask":
      maskStyle = msg.style || maskStyle;
      toggleManualMode(msg.enabled);
      sendResponse({ manualCount });
      break;

    case "changeMaskStyle":
      maskStyle = msg.style || maskStyle;
      updateExistingOverlays();
      sendResponse({ ok: true });
      break;

    case "removeAllMasks":
      disconnectObserver();
      removeAllOverlays();
      manualCount = 0;
      hasScanRun = false;
      lastPIIValues = [];
      reconnectObserver();
      sendResponse({ ok: true });
      break;

    case "updatePIIConfig":
      if (msg.enabledTypes) enabledPIITypes = { ...enabledPIITypes, ...msg.enabledTypes };
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ error: "Unknown action" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  DETECT & MASK — main pipeline
//  fullScan = true  → user-initiated: calls API, detects everything fresh
//  fullScan = false → MutationObserver-triggered: uses CACHED PII values only
//
//  v2.0.1 CRM Blink Fix:
//  • Full scan NO LONGER removes overlays before API call (smart-refresh).
//    Old overlays stay visible while we detect; stale ones pruned afterward.
//  • Incremental scan uses cached lastPIIValues — NO API call, just DOM walk.
//  • Observer is disconnected (not flag-paused) to prevent mutation queue leak.
//  • Cooldown prevents scan-storms from rapid CRM DOM churn.
// ══════════════════════════════════════════════════════════════════════════════
async function handleDetectAndMask(fullScan = false) {
  // Prevent overlapping scans (dynamic CRMs can fire mutations very fast)
  if (scanInProgress) {
    console.log("[SafeShot] Scan already in progress — skipping.");
    return { detected: detectedCount, masked: maskedCount };
  }

  // Cooldown: don't allow observer-triggered scans too frequently
  if (!fullScan) {
    const elapsed = Date.now() - lastScanTimestamp;
    if (elapsed < MIN_RESCAN_INTERVAL_MS) {
      console.log(`[SafeShot] Cooldown active (${elapsed}ms < ${MIN_RESCAN_INTERVAL_MS}ms) — skipping.`);
      return { detected: detectedCount, masked: maskedCount };
    }
  }

  scanInProgress = true;

  try {
    // Disconnect the MutationObserver entirely while we modify the DOM.
    // This is stronger than a flag — it stops mutation record collection,
    // so no queued mutations can re-trigger the observer after resume.
    disconnectObserver();

    if (fullScan) {
      // ── FULL SCAN (user-initiated) ──────────────────────────────────────
      // Do NOT removeAllOverlays() here. Existing masks stay visible while
      // we detect new PII, preventing the "blink" on CRM pages.
      detectedCount = 0;
      maskedCount = 0;

      // 1. Extract page text
      const pageText = extractPageText();
      const formValues = extractFormValues();
      const combinedText = pageText + "\n" + formValues.map((f) => f.value).join("\n");

      // 2. Try AI detection first, fall back to regex
      let entities = [];
      try {
        entities = await detectPIIviaAPI(combinedText);
      } catch (err) {
        console.warn("[SafeShot] AI service unavailable, using regex fallback:", err.message);
        entities = detectPIIviaRegex(combinedText);
      }

      detectedCount = entities.length;

      // 3. Filter entities by enabled PII types
      entities = entities.filter((e) => {
        const type = e.type || e.entity_type;
        return enabledPIITypes[type] !== false;
      });

      // 4. Cache PII values for future incremental scans
      const piiValues = entities.map((e) => e.value).filter(Boolean);
      lastPIIValues = piiValues;

      // 5. Mask matched content (applyOverlay skips already-masked elements)
      if (enabledPIITypes.FORM_FIELDS !== false) {
        formValues.forEach((field) => {
          const matchesEntity = entities.some(
            (e) => field.value.includes(e.value) || e.value.includes(field.value)
          );
          if (matchesEntity || containsRegexPII(field.value)) {
            maskFormField(field.element);
            maskedCount++;
          }
        });
      }

      if (piiValues.length > 0) {
        maskedCount += maskTextNodesContaining(piiValues);
      }

      if (enabledPIITypes.PASSWORD_FIELD !== false) {
        maskedCount += maskSensitiveInputs();
      }

    } else {
      // ── INCREMENTAL SCAN (MutationObserver-triggered) ───────────────────
      // Uses CACHED lastPIIValues — NO API call. This is fast (~1-5ms)
      // and avoids the async gap that causes CRM blink.
      if (lastPIIValues.length > 0) {
        maskTextNodesContaining(lastPIIValues);
      }

      // Re-mask form fields and sensitive inputs (new fields may have appeared)
      if (enabledPIITypes.FORM_FIELDS !== false) {
        const formValues = extractFormValues();
        formValues.forEach((field) => {
          if (lastPIIValues.some((v) => field.value.includes(v) || v.includes(field.value))
              || containsRegexPII(field.value)) {
            maskFormField(field.element);
          }
        });
      }

      if (enabledPIITypes.PASSWORD_FIELD !== false) {
        maskSensitiveInputs();
      }
    }

    // ── Common post-scan steps ──────────────────────────────────────────────
    // Reposition overlays whose targets may have moved (layout reflow)
    repositionAllOverlays();

    // Remove overlays whose targets no longer exist in the DOM
    pruneStaleOverlays();

    hasScanRun = true;
    lastScanTimestamp = Date.now();
  } finally {
    scanInProgress = false;
    // Reconnect observer AFTER all DOM changes are done
    reconnectObserver();
  }

  return { detected: detectedCount, masked: maskedCount };
}

// ══════════════════════════════════════════════════════════════════════════════
//  TEXT EXTRACTION
// ══════════════════════════════════════════════════════════════════════════════

/** Extract all visible text from the page body */
function extractPageText() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Skip script/style content and hidden elements
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
        return NodeFilter.FILTER_REJECT;
      }
      if (parent.offsetParent === null && getComputedStyle(parent).position !== "fixed") {
        return NodeFilter.FILTER_REJECT;
      }
      const trimmed = node.textContent.trim();
      return trimmed.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const chunks = [];
  while (walker.nextNode()) {
    chunks.push(walker.currentNode.textContent.trim());
  }
  return chunks.join(" ");
}

/** Extract form field values (inputs, textareas, selects) */
function extractFormValues() {
  const fields = [];
  const inputs = document.querySelectorAll(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select'
  );
  inputs.forEach((el) => {
    const val = el.value || el.textContent || "";
    if (val.trim().length > 0) {
      fields.push({ element: el, value: val.trim() });
    }
  });
  return fields;
}

// ══════════════════════════════════════════════════════════════════════════════
//  AI PII DETECTION (via FastAPI backend)
// ══════════════════════════════════════════════════════════════════════════════

async function detectPIIviaAPI(text) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-API-Key"] = API_KEY;

  const res = await fetch(`${API_BASE}/detect-pii`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, engine: detectionEngine }),
  });

  if (!res.ok) throw new Error(`API returned ${res.status}`);

  const data = await res.json();
  // Normalise the response — API returns { entities: [...] }
  return (data.entities || []).map((e) => ({
    type: e.entity_type || e.type,
    value: text.substring(e.start, e.end),
    start: e.start,
    end: e.end,
    score: e.score,
  }));
}

// ══════════════════════════════════════════════════════════════════════════════
//  REGEX PII DETECTION (offline fallback)
// ══════════════════════════════════════════════════════════════════════════════

function detectPIIviaRegex(text) {
  const results = [];
  for (const [type, regex] of Object.entries(PII_PATTERNS)) {
    let match;
    const re = new RegExp(regex.source, regex.flags);
    while ((match = re.exec(text)) !== null) {
      results.push({
        type,
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
        score: 0.8,
      });
    }
  }
  return results;
}

/** Quick check if a single string has regex PII */
function containsRegexPII(text) {
  for (const regex of Object.values(PII_PATTERNS)) {
    if (new RegExp(regex.source, regex.flags).test(text)) return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
//  DOM MASKING
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Walk all text nodes inside body, and for each text node that contains any
 * of the PII values, wrap the parent element with a mask overlay.
 */
function maskTextNodesContaining(values) {
  let count = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

  const nodesToMask = new Set();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent;
    for (const val of values) {
      if (val.length >= 3 && text.includes(val)) {
        // Mask the closest inline/block parent that holds this text
        const target = node.parentElement;
        if (target && !target.hasAttribute(MASK_ATTR)) {
          nodesToMask.add(target);
        }
        break;
      }
    }
  }

  nodesToMask.forEach((el) => {
    applyOverlay(el);
    count++;
  });
  return count;
}

/** Mask an individual form field (input / textarea) */
function maskFormField(el) {
  if (el.hasAttribute(MASK_ATTR)) return;
  applyOverlay(el);
}

/** Mask all password & sensitive input types */
function maskSensitiveInputs() {
  let count = 0;
  const selectors = [
    'input[type="password"]',
    'input[type="email"]',
    'input[autocomplete="cc-number"]',
    'input[autocomplete="cc-csc"]',
    'input[name*="ssn" i]',
    'input[name*="aadhaar" i]',
    'input[name*="pan" i]',
    'input[name*="passport" i]',
    'input[name*="account" i]',
    'input[name*="routing" i]',
  ];

  document.querySelectorAll(selectors.join(",")).forEach((el) => {
    if (!el.hasAttribute(MASK_ATTR) && el.value && el.value.trim().length > 0) {
      applyOverlay(el);
      count++;
    }
  });
  return count;
}

// ══════════════════════════════════════════════════════════════════════════════
//  OVERLAY APPLICATION
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a positioned overlay element on top of the target and applies
 * the chosen mask style (blur / blackbox / replace).
 *
 * v1.1: If an overlay already exists for this target, reposition it instead
 * of creating a new one (prevents blink on dynamic UIs).
 */
function applyOverlay(targetEl) {
  // Already masked — just reposition the existing overlay
  if (targetEl.hasAttribute(MASK_ATTR)) {
    const existing = overlayMap.get(targetEl);
    if (existing && existing.isConnected) {
      repositionOverlay(existing, targetEl);
    }
    return;
  }

  targetEl.setAttribute(MASK_ATTR, "true");

  const overlay = document.createElement("div");
  overlay.className = OVERLAY_CLASS;

  // Position the overlay exactly over the target
  positionOverlayOver(overlay, targetEl);

  Object.assign(overlay.style, {
    zIndex: "2147483647",
    pointerEvents: "none",
    borderRadius: "3px",
  });

  setOverlayStyle(overlay, targetEl);

  // Track this overlay so we can reposition / prune it later
  overlayMap.set(targetEl, overlay);
  overlay._safeshotTarget = targetEl; // reverse reference for pruning

  document.body.appendChild(overlay);
}

/** Position / size an overlay to exactly cover a target element */
function positionOverlayOver(overlay, targetEl) {
  const rect = targetEl.getBoundingClientRect();
  Object.assign(overlay.style, {
    position: "absolute",
    top: `${rect.top + window.scrollY}px`,
    left: `${rect.left + window.scrollX}px`,
    width: `${Math.max(rect.width, 4)}px`,
    height: `${Math.max(rect.height, 4)}px`,
  });
}

/** Reposition a single overlay to follow its target */
function repositionOverlay(overlay, targetEl) {
  const rect = targetEl.getBoundingClientRect();
  // Only update if position/size actually changed (avoids layout thrash)
  const newTop = `${rect.top + window.scrollY}px`;
  const newLeft = `${rect.left + window.scrollX}px`;
  const newW = `${Math.max(rect.width, 4)}px`;
  const newH = `${Math.max(rect.height, 4)}px`;

  if (
    overlay.style.top !== newTop ||
    overlay.style.left !== newLeft ||
    overlay.style.width !== newW ||
    overlay.style.height !== newH
  ) {
    overlay.style.top = newTop;
    overlay.style.left = newLeft;
    overlay.style.width = newW;
    overlay.style.height = newH;
  }
}

/** Reposition ALL existing overlays (called on scroll, resize, incremental scan) */
function repositionAllOverlays() {
  document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((overlay) => {
    const target = overlay._safeshotTarget;
    if (target && target.isConnected) {
      repositionOverlay(overlay, target);
    }
  });
}

/**
 * Remove overlays whose target elements no longer exist in the DOM.
 * This prevents ghost overlays after CRM panels close / views navigate.
 */
function pruneStaleOverlays() {
  document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((overlay) => {
    const target = overlay._safeshotTarget;
    if (!target || !target.isConnected) {
      overlay.remove();
    }
  });
}

/** Apply the visual mask style to an overlay */
function setOverlayStyle(overlay, targetEl) {
  // Reset
  overlay.style.background = "";
  overlay.style.backdropFilter = "";
  overlay.style.webkitBackdropFilter = "";
  overlay.textContent = "";
  overlay.style.display = "flex";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.fontSize = "13px";
  overlay.style.fontWeight = "700";
  overlay.style.letterSpacing = "2px";

  switch (maskStyle) {
    case "blur":
      overlay.style.backdropFilter = "blur(8px)";
      overlay.style.webkitBackdropFilter = "blur(8px)";
      overlay.style.background = "rgba(30, 41, 59, 0.45)";
      overlay.textContent = "";
      break;

    case "blackbox":
      overlay.style.background = "#000";
      overlay.textContent = "";
      break;

    case "replace":
      overlay.style.background = "#1e293b";
      overlay.style.color = "#94a3b8";
      // Replace with asterisks roughly matching width
      const charCount = (targetEl.textContent || targetEl.value || "").length;
      overlay.textContent = "•".repeat(Math.min(charCount, 30));
      break;
  }
}

/** Update the style of all existing overlays (when user switches style) */
function updateExistingOverlays() {
  disconnectObserver();
  document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((overlay) => {
    const target = overlay._safeshotTarget || document.body;
    setOverlayStyle(overlay, target);
  });
  reconnectObserver();
}

/** Remove all mask overlays and reset state */
function removeAllOverlays() {
  document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((el) => el.remove());
  document.querySelectorAll(`[${MASK_ATTR}]`).forEach((el) => el.removeAttribute(MASK_ATTR));
  detectedCount = 0;
  maskedCount = 0;
}

// ══════════════════════════════════════════════════════════════════════════════
//  MANUAL MASK MODE
// ══════════════════════════════════════════════════════════════════════════════

function toggleManualMode(enabled) {
  manualMode = enabled;
  if (manualMode) {
    document.body.style.cursor = "crosshair";
    document.addEventListener("click", manualClickHandler, true);
    document.addEventListener("mouseover", manualHoverHandler, true);
    document.addEventListener("mouseout", manualHoverOutHandler, true);
  } else {
    document.body.style.cursor = "";
    document.removeEventListener("click", manualClickHandler, true);
    document.removeEventListener("mouseover", manualHoverHandler, true);
    document.removeEventListener("mouseout", manualHoverOutHandler, true);
    // Clean up any hover highlights
    document.querySelectorAll(`.${MANUAL_HIGHLIGHT}`).forEach((el) => {
      el.classList.remove(MANUAL_HIGHLIGHT);
    });
  }
}

function manualClickHandler(e) {
  if (!manualMode) return;
  e.preventDefault();
  e.stopPropagation();

  const target = e.target;
  if (target.classList.contains(OVERLAY_CLASS)) return;
  if (target.hasAttribute(MASK_ATTR)) return;

  applyOverlay(target);
  manualCount++;
  target.classList.remove(MANUAL_HIGHLIGHT);
}

function manualHoverHandler(e) {
  if (!manualMode) return;
  const target = e.target;
  if (!target.classList.contains(OVERLAY_CLASS) && !target.hasAttribute(MASK_ATTR)) {
    target.classList.add(MANUAL_HIGHLIGHT);
  }
}

function manualHoverOutHandler(e) {
  e.target.classList.remove(MANUAL_HIGHLIGHT);
}

// ══════════════════════════════════════════════════════════════════════════════
//  MUTATION OBSERVER — detect dynamic content changes
//  v1.1: Paused/resumed around our own DOM changes to prevent self-triggering.
//        Longer debounce (1.5 s) and scan-lock prevent CRM blink loops.
//        Ignores attribute-only mutations (style changes, class toggling).
// ══════════════════════════════════════════════════════════════════════════════
let observerConnected = true;

const observerConfig = { childList: true, subtree: true };

const observer = new MutationObserver((mutations) => {
  // Guard: only run if user has done at least one scan
  if (!hasScanRun) return;
  if (document.querySelectorAll(`.${OVERLAY_CLASS}`).length === 0) return;

  let hasNewContent = false;
  let addedNonOverlayCount = 0;

  for (const mutation of mutations) {
    // Only care about new child nodes — not attribute changes that CRMs fire constantly
    if (mutation.type !== "childList") continue;
    if (mutation.addedNodes.length > 0) {
      for (const node of mutation.addedNodes) {
        if (
          node.nodeType === Node.ELEMENT_NODE &&
          !node.classList?.contains(OVERLAY_CLASS) &&
          !node.hasAttribute?.(MASK_ATTR)
        ) {
          hasNewContent = true;
          addedNonOverlayCount++;
        }
      }
    }
  }

  // Skip trivial mutations (e.g., class toggling, single-element updates)
  // that CRMs fire hundreds of times per second during transitions
  if (!hasNewContent || addedNonOverlayCount === 0) return;

  // Debounce: wait RESCAN_DEBOUNCE_MS (1.5s) before incremental re-scan
  clearTimeout(observer._debounce);
  observer._debounce = setTimeout(() => {
    console.log(`[SafeShot] Dynamic content detected (${addedNonOverlayCount} nodes) — incremental re-mask…`);
    handleDetectAndMask(/* fullScan */ false);
  }, RESCAN_DEBOUNCE_MS);
});

// Only observe childList (not attributes) to avoid noise from CRM style toggling
observer.observe(document.body, observerConfig);

/**
 * Disconnect the MutationObserver entirely (stops mutation record collection).
 * Stronger than a flag — no queued mutations will fire after reconnect.
 */
function disconnectObserver() {
  if (observerConnected) {
    observer.disconnect();
    // Clear any pending mutation records
    observer.takeRecords();
    clearTimeout(observer._debounce);
    observerConnected = false;
  }
}

/**
 * Reconnect the MutationObserver after our DOM changes are complete.
 * Uses double-rAF to ensure the browser has fully flushed our changes
 * before re-observing, preventing self-triggered mutation loops.
 */
function reconnectObserver() {
  if (!observerConnected) {
    // Double requestAnimationFrame: first rAF lets the browser commit our
    // DOM writes; second rAF ensures the paint is done before we observe.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        observer.observe(document.body, observerConfig);
        observerConnected = true;
      });
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  SCROLL & RESIZE — reposition overlays without full re-scan
//  This keeps masks stable on CRMs that reflow layouts on scroll.
// ══════════════════════════════════════════════════════════════════════════════
let repositionRAF = null;

function onScrollOrResize() {
  if (!hasScanRun) return;
  if (repositionRAF) cancelAnimationFrame(repositionRAF);
  repositionRAF = requestAnimationFrame(() => {
    repositionAllOverlays();
  });
}

window.addEventListener("scroll", onScrollOrResize, { passive: true });
window.addEventListener("resize", onScrollOrResize, { passive: true });

// ── Log readiness ──────────────────────────────────────────────────────────────
console.log("[SafeShot AI] Content script loaded — ready for PII detection.");
