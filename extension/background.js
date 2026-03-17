/**
 * background.js — SafeShot AI Service Worker (Manifest V3)
 *
 * Runs as the extension's background service worker. Handles:
 *  • Screenshot capture via chrome.tabs.captureVisibleTab
 *  • Downloading the captured screenshot as a PNG file
 *  • Coordinating messages between popup and content script
 */

// ── Screenshot Capture ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "captureScreenshot") {
    captureAndDownload()
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error("[SafeShot] Screenshot capture failed:", err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // keep the message channel open for async response
  }
});

/**
 * Capture the currently visible tab and trigger a PNG download.
 */
async function captureAndDownload() {
  // 1. Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found");

  // 2. Capture the visible area of the tab
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
    quality: 100,
  });

  // 3. Generate a timestamped filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `SafeShot_${timestamp}.png`;

  // 4. Download the captured image
  await chrome.downloads.download({
    url: dataUrl,
    filename: filename,
    saveAs: false, // auto-save to default downloads folder
  });

  console.log(`[SafeShot] Screenshot saved as ${filename}`);
}

// ── Extension Install / Update ─────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    console.log("[SafeShot AI] Extension installed — welcome!");
    // Set default configuration
    chrome.storage.local.set({
      maskStyle: "blur",
      apiBase: "http://127.0.0.1:8000",
      apiKey: "",
      regexFallback: true,
      autoScan: false,
    });
    // Open options page on first install so user can configure the backend URL
    chrome.runtime.openOptionsPage();
  } else if (details.reason === "update") {
    console.log("[SafeShot AI] Extension updated to", chrome.runtime.getManifest().version);
  }
});

// ── Keep-alive ping (prevents service worker from sleeping in MV3) ─────────────
// Not strictly necessary for user-triggered actions, but useful if you
// add periodic background tasks later.
