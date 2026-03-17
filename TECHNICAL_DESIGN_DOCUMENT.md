# SafeShot AI — Technical Design Document

**Project:** SafeShot AI — AI-Powered PII Masking Chrome Extension  
**Version:** 2.0.0  
**Date:** March 16, 2026  
**Author:** Engineering Team  
**Status:** v2.0 — Dual-Engine (Presidio + LLM) Release  

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Overview](#2-system-overview)
3. [Architecture](#3-architecture)
4. [Component Design](#4-component-design)
5. [Data Flow](#5-data-flow)
6. [API Specification](#6-api-specification)
7. [PII Detection Engine](#7-pii-detection-engine)
8. [LLM Detection Engine](#8-llm-detection-engine)
9. [Chrome Extension Design](#9-chrome-extension-design)
10. [OCR Pipeline](#10-ocr-pipeline)
11. [Security & Privacy](#11-security--privacy)
12. [Technology Stack](#12-technology-stack)
13. [Project Structure](#13-project-structure)
14. [Deployment & Configuration](#14-deployment--configuration)
15. [Performance Considerations](#15-performance-considerations)
16. [Future Enhancements](#16-future-enhancements)

---

## 1. Executive Summary

SafeShot AI is an enterprise-grade Chrome browser extension that automatically detects and masks Personally Identifiable Information (PII) on web pages before screenshots are captured. It combines a client-side Chrome extension (Manifest V3) with a local Python FastAPI backend that offers **two selectable detection engines**:

1. **Presidio Engine (v1)** — Microsoft Presidio + spaCy NER for fast, pattern-based detection (17+ entity types)
2. **LLM Engine (v2)** — Local LLM via Ollama for context-aware, semantic PII detection (25+ entity types)

Users can switch engines at any time from the popup UI. The system falls back gracefully: LLM → Presidio → regex patterns.

### 1.1 Problem Statement

Organizations frequently capture screenshots of web applications for documentation, testing, support tickets, and compliance. These screenshots often inadvertently contain sensitive data — names, emails, phone numbers, credit cards, government IDs, and passwords — creating data-leak and compliance risks (GDPR, HIPAA, PCI-DSS).

### 1.2 Solution

SafeShot AI intercepts the screenshot workflow by scanning visible DOM content, detecting PII through a user-selected engine (Presidio or LLM), and applying configurable visual masks before capture. The entire pipeline runs locally with zero data transmitted to external servers.

### 1.3 Key Capabilities

| Capability | Description |
|---|---|
| AI PII Detection | Microsoft Presidio + spaCy NLP for 17+ entity types |
| Regex Fallback | Client-side pattern matching when backend is offline |
| Three Mask Styles | Blur, Black Box, Text Replacement (••••) |
| Manual Mask Mode | Click-to-mask any DOM element |
| Screenshot Capture | One-click masked PNG download |
| Dynamic Content | MutationObserver re-scans new DOM nodes automatically |
| Form Field Detection | Auto-masks password, email, SSN, and sensitive inputs |
| OCR Pipeline | Tesseract + OpenCV for image-based PII detection |
| Remove Masking | One-click removal of all applied masks |
| PII Type Config | User-selectable PII categories (14 toggles) with persistent preferences |
| Local-First | No data leaves the user's machine |

---

## 2. System Overview

### 2.1 High-Level Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    USER'S BROWSER                         │
│                                                          │
│  ┌─────────────┐    Chrome Messages    ┌──────────────┐  │
│  │  popup.js   │ ◄──────────────────► │  content.js  │  │
│  │  (Popup UI) │                       │  (Page DOM)  │  │
│  └──────┬──────┘                       └──────┬───────┘  │
│         │                                     │          │
│         │ chrome.runtime                      │ fetch()  │
│         ▼                                     │          │
│  ┌──────────────┐                             │          │
│  │ background.js│                             │          │
│  │ (Svc Worker) │                             │          │
│  │  Screenshot  │                             │          │
│  └──────────────┘                             │          │
└───────────────────────────────────────────────┼──────────┘
                                                │
                              HTTP POST (localhost:8000)
                                                │
                                                ▼
┌──────────────────────────────────────────────────────────┐
│                  AI SERVICE (Python)                      │
│                                                          │
│  ┌──────────┐    ┌───────────────┐    ┌──────────────┐  │
│  │ FastAPI   │──engine──► PIIDetector   │───►│   Presidio   │  │
│  │ main.py   │  switch  │ (Presidio +   │    │  Analyzer    │  │
│  │           │    │    │  spaCy NLP)   │    │  Engine      │  │
│  │  /detect- │    │    └───────────────┘    └──────────────┘  │
│  │  pii      │    │                                        │
│  │           │    └───►┌───────────────┐    ┌──────────────┐  │
│  │  ?engine= │         │ LLMDetector   │───►│ Ollama API  │  │
│  │  llm      │         │ (Ollama +     │    │ (localhost  │  │
│  │           │         │  llama3.2)    │    │  :11434)    │  │
│  └──────────┘         └───────────────┘    └──────────────┘  │
│                                                          │
│  ┌──────────┐    ┌───────────────┐    ┌──────────────┐  │
│  │ /detect-  │───►│ OCRPipeline   │───►│  Tesseract   │  │
│  │  image    │    │ (OpenCV +     │    │  OCR Engine  │  │
│  │           │    │  Tesseract)   │    │              │  │
│  └──────────┘    └───────────────┘    └──────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### 2.2 Communication Pattern

| From | To | Protocol | Purpose |
|---|---|---|---|
| popup.js | content.js | `chrome.tabs.sendMessage` | Trigger scan, toggle manual mode, change style |
| popup.js | content.js | `chrome.tabs.sendMessage` | Remove all masks (`removeAllMasks`) |
| popup.js | content.js | `chrome.tabs.sendMessage` | Update PII type config (`updatePIIConfig`) |
| content.js | popup.js | Message response callback | Return detected/masked counts |
| popup.js | background.js | `chrome.runtime.sendMessage` | Trigger screenshot capture |
| content.js | AI Service | HTTP POST (`fetch`) | Send page text for PII detection |
| AI Service | content.js | HTTP JSON response | Return detected PII entities |

---

## 3. Architecture

### 3.1 Layered Architecture

```
┌─────────────────────────────────────────────────┐
│              PRESENTATION LAYER                  │
│   popup.html  │  popup.js  │  styles.css         │
│   (Extension popup UI — mask controls, stats)    │
├─────────────────────────────────────────────────┤
│              CLIENT LOGIC LAYER                  │
│                  content.js                       │
│   • DOM text extraction (TreeWalker)             │
│   • Form value extraction                        │
│   • Regex PII detection (offline fallback)       │
│   • Overlay positioning & styling                │
│   • Manual mask mode (event handlers)            │
│   • MutationObserver (dynamic content)           │
├─────────────────────────────────────────────────┤
│              SERVICE LAYER                       │
│                background.js                      │
│   • Screenshot capture (captureVisibleTab)       │
│   • PNG download (chrome.downloads API)          │
│   • Extension lifecycle (install/update)         │
├─────────────────────────────────────────────────┤
│              API LAYER                           │
│                 main.py (FastAPI)                 │
│   • REST endpoints (/health, /detect-pii,        │
│     /detect-image, /engines)                     │
│   • Engine routing (presidio ↔ llm)              │
│   • CORS middleware                              │
│   • Request/response validation (Pydantic)       │
├─────────────────────────────────────────────────┤
│              AI / NLP LAYER                      │
│              pii_detector.py                      │
│   • PIIDetector class (Presidio AnalyzerEngine)  │
│   • Custom recognisers (Aadhaar, PAN, Phone,     │
│     Bank Account)                                │
│   • Overlap de-duplication algorithm             │
│   • OCRPipeline class (OpenCV + Tesseract)       │
│              llm_detector.py                      │
│   • LLMDetector class (Ollama REST API)          │
│   • Structured JSON prompt engineering            │
│   • Offset validation & correction               │
│   • Long-text chunking with overlap              │
│   • Response parsing with LLM quirk handling      │
├─────────────────────────────────────────────────┤
│              INFRASTRUCTURE LAYER                │
│   spaCy en_core_web_sm │ Tesseract OCR │ OpenCV  │
│   Ollama (llama3.2)    │                         │
└─────────────────────────────────────────────────┘
```

### 3.2 Design Patterns

| Pattern | Where | Purpose |
|---|---|---|
| **Singleton** | `PIIDetector`, `LLMDetector`, `OCRPipeline` in `main.py` | Single instance per server lifetime; avoids reloading heavy NLP/LLM models |
| **Strategy** | `setOverlayStyle()` in `content.js`; engine selection in `main.py` | Swappable mask styles and detection engines without changing core logic |
| **Observer** | `MutationObserver` in `content.js` | React to dynamic DOM changes and re-scan automatically |
| **Facade** | `PIIDetector.detect()`, `LLMDetector.detect()` | Identical interface hiding engine internals (Presidio config vs Ollama prompt) |
| **Fallback / Circuit Breaker** | `handleDetectAndMask()` in `content.js`; engine fallback in `main.py` | Graceful degradation: LLM → Presidio → regex patterns |
| **Message Bus** | Chrome messaging API | Decoupled communication between popup, content, and background scripts |

---

## 4. Component Design

### 4.1 Chrome Extension Components

#### 4.1.1 manifest.json

| Property | Value | Rationale |
|---|---|---|
| `manifest_version` | 3 | Latest Chrome extension standard; required for new submissions |
| `permissions` | `activeTab`, `scripting`, `storage`, `downloads`, `tabs` | Minimum privileges for DOM access, screenshot, preferences, file saving |
| `host_permissions` | `<all_urls>` | Content script must run on any webpage |
| `content_scripts` | `content.js` + `styles.css` at `document_idle` | Inject after DOM is ready |
| `service_worker` | `background.js` | MV3 background processing |

#### 4.1.2 popup.html / popup.js — Extension Popup

**Responsibilities:**
- Render the toolbar popup UI (340px wide, dark theme)
- Perform AI service health checks on open (`GET /health`)
- Dispatch commands to content.js via `chrome.tabs.sendMessage`
- Dispatch screenshot command to background.js via `chrome.runtime.sendMessage`
- Persist mask style, PII type preferences, and detection engine in `chrome.storage.local`
- Display real-time statistics (Detected / Masked / Manual counts)
- Provide "Remove All Masking" one-click cleanup
- Provide collapsible PII type configuration (14 toggles)
- Provide detection engine selector (Presidio v1 / LLM v2) with availability badges

**UI Elements:**

| Element | ID | Action |
|---|---|---|
| Status indicator | `statusDot`, `statusText` | Green dot when API reachable; red when offline |
| Detect & Mask | `btnDetect` | Sends `detectAndMask` (with `enabledTypes` + `engine`) to content script |
| Manual Mask | `btnManual` | Toggles `toggleManualMask` in content script |
| Remove All Masking | `btnRemove` | Sends `removeAllMasks` to content script; resets stats to 0 |
| Capture Screenshot | `btnCapture` | Sends `captureScreenshot` to background |
| Engine Selector | `enginePresidio`, `engineLLM` | Presidio (v1) or LLM (v2) — saves to storage; shows availability badges |
| Mask Style Chips | `.mask-option[data-style]` | `blur`, `blackbox`, `replace` — saves to storage |
| PII Config Toggle | `piiConfigToggle`, `piiArrow` | Expand / collapse the PII type checkbox grid |
| PII Checkboxes | `.pii-toggle input[data-pii]` | 14 checkboxes — saves to `chrome.storage.local`, sends `updatePIIConfig` |
| Stats Row | `statDetected`, `statMasked`, `statManual` | Updated after each scan |

**State Management:**

```
chrome.storage.local
  ├── maskStyle: "blur" | "blackbox" | "replace"
  ├── detectionEngine: "presidio" | "llm"
  ├── apiBase: "http://127.0.0.1:8000"
  └── enabledPIITypes: {
        "PERSON": true,
        "EMAIL_ADDRESS": true,
        "PHONE_NUMBER": true,
        "CREDIT_CARD": true,
        "US_SSN": true,
        "AADHAAR_NUMBER": true,
        "PAN_NUMBER": true,
        "BANK_ACCOUNT": true,
        "IP_ADDRESS": true,
        "LOCATION": true,
        "DATE_TIME": false,
        "URL": false,
        "PASSWORD_FIELD": true,
        "FORM_FIELDS": true
      }
```

**PII Type Configuration Defaults:**

| PII Type | Default | Category |
|---|---|---|
| `PERSON` | Enabled | Identity |
| `EMAIL_ADDRESS` | Enabled | Contact |
| `PHONE_NUMBER` | Enabled | Contact |
| `CREDIT_CARD` | Enabled | Financial |
| `US_SSN` | Enabled | Government ID |
| `AADHAAR_NUMBER` | Enabled | Government ID |
| `PAN_NUMBER` | Enabled | Government ID |
| `BANK_ACCOUNT` | Enabled | Financial |
| `IP_ADDRESS` | Enabled | Technical |
| `LOCATION` | Enabled | Identity |
| `DATE_TIME` | Disabled | Low risk — too many false positives |
| `URL` | Disabled | Low risk — usually not PII |
| `PASSWORD_FIELD` | Enabled | Credentials |
| `FORM_FIELDS` | Enabled | Sensitive inputs |

#### 4.1.3 content.js — Content Script

**Responsibilities:**
- Extract visible text from the page DOM using `TreeWalker`
- Extract form field values (inputs, textareas, selects)
- Call AI service `POST /detect-pii` with extracted text
- Fall back to regex-based detection if API is unreachable
- Filter detected entities against user-configured `enabledPIITypes`
- Locate PII values in DOM nodes and apply positioned overlays
- Conditionally mask form fields and password inputs based on PII config
- Auto-mask sensitive input types (password, email, SSN, etc.)
- Provide manual click-to-mask mode with hover highlighting
- Remove all masks on demand (`removeAllMasks` action)
- Accept live PII config updates (`updatePIIConfig` action)
- Monitor dynamic content changes via `MutationObserver`

**Internal Functions:**

| Function | Purpose |
|---|---|
| `handleDetectAndMask()` | Main pipeline: extract → detect → filter by config → mask |
| `extractPageText()` | TreeWalker over visible text nodes |
| `extractFormValues()` | Query inputs/textareas/selects |
| `detectPIIviaAPI(text)` | HTTP POST to FastAPI backend |
| `detectPIIviaRegex(text)` | Offline fallback — 6 regex patterns |
| `maskTextNodesContaining(values)` | Walk DOM, overlay matching parents |
| `maskFormField(el)` | Overlay a form input (gated by `FORM_FIELDS` config) |
| `maskSensitiveInputs()` | Auto-detect password/email/SSN fields (gated by `PASSWORD_FIELD` config) |
| `applyOverlay(targetEl)` | Create absolutely-positioned overlay div |
| `setOverlayStyle(overlay, targetEl)` | Apply blur/blackbox/replace CSS |
| `updateExistingOverlays()` | Switch style on existing overlays |
| `removeAllOverlays()` | Clean up all masks and reset state |
| `toggleManualMode(enabled)` | Enable/disable click-to-mask |
| `manualClickHandler(e)` | Mask clicked element |
| `MutationObserver` callback | Debounced re-scan on DOM changes |

**Message Actions Handled:**

| Action | Parameters | Effect |
|---|---|---|
| `detectAndMask` | `style`, `enabledTypes` | Run full PII scan with type filtering; return stats |
| `toggleManualMask` | `enabled`, `style` | Enable/disable manual click-to-mask mode |
| `changeMaskStyle` | `style` | Update mask style on existing overlays |
| `removeAllMasks` | — | Remove all overlays, reset `manualCount` & `hasScanRun` |
| `updatePIIConfig` | `enabledTypes` | Merge new PII type preferences into `enabledPIITypes` |

**Regex Fallback Patterns:**

| Pattern Name | Regex | Target |
|---|---|---|
| `EMAIL` | `[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}` | Email addresses |
| `PHONE` | `(\+?\d{1,3}[\s\-]?)?(\(?\d{2,4}\)?[\s\-]?)?\d{3,4}[\s\-]?\d{4}` | Phone numbers |
| `SSN` | `\b\d{3}[\-\s]?\d{2}[\-\s]?\d{4}\b` | US Social Security Numbers |
| `CREDIT_CARD` | `\b(?:\d{4}[\s\-]?){3}\d{4}\b` | 16-digit credit card numbers |
| `AADHAAR` | `\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b` | Indian Aadhaar (12 digits) |
| `IP_ADDRESS` | `\b(?:\d{1,3}\.){3}\d{1,3}\b` | IPv4 addresses |

#### 4.1.4 background.js — Service Worker

**Responsibilities:**
- Listen for `captureScreenshot` messages from popup
- Capture visible tab via `chrome.tabs.captureVisibleTab` (PNG, quality 100)
- Auto-download with timestamped filename (`SafeShot_YYYY-MM-DDTHH-MM-SS.png`)
- Set default configuration on extension install

**Lifecycle Events:**

| Event | Handler |
|---|---|
| `chrome.runtime.onMessage` | Route `captureScreenshot` action |
| `chrome.runtime.onInstalled` | Set defaults (`maskStyle: "blur"`, `apiBase`) |

#### 4.1.5 styles.css — Injected Styles

| CSS Class | Purpose |
|---|---|
| `.safeshot-overlay` | Positioned overlay with max z-index (2147483647) |
| `.safeshot-manual-highlight` | Dashed purple border + light purple background on hover |
| `.safeshot-overlay--new` | Pulse animation for newly masked items |
| `[data-safeshot-masked]` | Sets `position: relative` on masked source elements |

---

### 4.2 AI Service Components

#### 4.2.1 main.py — FastAPI Application

**Responsibilities:**
- Serve REST API endpoints behind CORS middleware
- Initialize `PIIDetector` and `OCRPipeline` singletons at startup
- Validate requests/responses via Pydantic models
- Structured logging for audit trail

**Pydantic Models:**

| Model | Fields | Used By |
|---|---|---|
| `DetectRequest` | `text: str` | `POST /detect-pii` request |
| `PIIEntity` | `entity_type`, `start`, `end`, `score`, `value` | Response entity |
| `DetectResponse` | `entities: list[PIIEntity]` | `POST /detect-pii` response |
| `OCREntity` | `entity_type`, `value`, `score`, `bbox: dict` | OCR response entity |
| `OCRResponse` | `entities: list[OCREntity]` | `POST /detect-image` response |

**Middleware:**

| Middleware | Configuration | Purpose |
|---|---|---|
| `CORSMiddleware` | `allow_origins=["*"]`, all methods/headers | Enable cross-origin requests from Chrome extension |

#### 4.2.2 pii_detector.py — Detection Engine

**Class: `PIIDetector`**

| Aspect | Detail |
|---|---|
| NLP Engine | spaCy `en_core_web_sm` (loaded via `NlpEngineProvider`) |
| Analyzer | Presidio `AnalyzerEngine` (English language) |
| Built-in Recognizers | 13 types: PERSON, EMAIL, PHONE, CREDIT_CARD, IBAN, US_SSN, US_PASSPORT, US_DRIVER_LICENSE, IP_ADDRESS, DATE_TIME, LOCATION, NRP, MEDICAL_LICENSE, URL |
| Custom Recognizers | 4 types: AADHAAR_NUMBER, PAN_NUMBER, BANK_ACCOUNT, PHONE_NUMBER (custom patterns) |
| Score Threshold | 0.35 (configurable) |
| Dedup Strategy | Sort by start position → merge overlapping spans → keep highest score |

**Custom Recognizer Specifications:**

| Recognizer | Entity Type | Pattern | Score |
|---|---|---|---|
| `AadhaarRecognizer` | `AADHAAR_NUMBER` | `\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b` | 0.75 |
| `PANRecognizer` | `PAN_NUMBER` | `\b[A-Z]{5}\d{4}[A-Z]\b` | 0.85 |
| `BankAccountRecognizer` | `BANK_ACCOUNT` | `\b\d{9,18}\b` | 0.40 |
| `CustomPhoneRecognizer` | `PHONE_NUMBER` | International + US patterns | 0.65–0.70 |

**Class: `OCRPipeline`**

| Step | Technology | Operation |
|---|---|---|
| 1. Decode | OpenCV `imdecode` | Convert raw bytes → BGR image |
| 2. Pre-process | OpenCV | Grayscale → Otsu binary threshold |
| 3. OCR | Tesseract `image_to_data` | Word-level text + bounding boxes |
| 4. Map | Custom logic | Build char-offset → bbox mapping |
| 5. Detect | `PIIDetector.detect()` | Run Presidio on concatenated text |
| 6. Resolve | Union bbox | Merge word bboxes per PII span |

---

## 5. Data Flow

### 5.1 Detect & Mask PII (Primary Flow)

```
User clicks "Detect & Mask PII" in popup
            │
            ▼
    popup.js sends { action: "detectAndMask", style: "blur", enabledTypes: {...} }
    via chrome.tabs.sendMessage
            │
            ▼
    content.js receives message
            │
            ├── 1. removeAllOverlays()
            │
            ├── 2. extractPageText()        ──► TreeWalker over body text nodes
            ├── 3. extractFormValues()       ──► Query inputs/textareas/selects
            │       combinedText = pageText + formValues
            │
            ├── 4. Try: detectPIIviaAPI(text)
            │       │   POST http://127.0.0.1:8000/detect-pii
            │       │   Body: { "text": combinedText }
            │       │
            │       │   FastAPI main.py
            │       │     └── PIIDetector.detect(text)
            │       │           ├── Presidio AnalyzerEngine.analyze()
            │       │           ├── Custom recognizers (Aadhaar, PAN, Phone, Bank)
            │       │           └── _merge_overlapping() dedup
            │       │
            │       │   Response: { entities: [{ entity_type, start, end, score, value }] }
            │       │
            │       └── Catch: detectPIIviaRegex(text)   ◄── offline fallback
            │
            ├── 5. Filter entities by enabledPIITypes config
            │       (e.g. skip DATE_TIME, URL if disabled)
            │
            ├── 6. maskFormField()                      ──► gated by FORM_FIELDS toggle
            ├── 7. maskTextNodesContaining(piiValues)    ──► Walk DOM + applyOverlay()
            ├── 8. maskSensitiveInputs()                 ──► gated by PASSWORD_FIELD toggle
            │
            └── 9. Return { detected: N, masked: M } to popup
                        │
                        ▼
                popup.js updates statistics display
```

### 5.2 Screenshot Capture Flow

```
User clicks "Capture Masked Screenshot"
            │
            ▼
    popup.js sends { action: "captureScreenshot" }
    via chrome.runtime.sendMessage
            │
            ▼
    background.js receives message
            │
            ├── chrome.tabs.query({ active: true })
            ├── chrome.tabs.captureVisibleTab(windowId, { format: "png" })
            ├── Generate filename: SafeShot_2026-03-16T14-30-22.png
            └── chrome.downloads.download({ url: dataUrl, filename })
                        │
                        ▼
                PNG saved to Downloads folder
```

### 5.3 Manual Mask Flow

```
User clicks "Manual Mask Mode" in popup
            │
            ▼
    content.js toggleManualMode(true)
            │
            ├── Set cursor to crosshair
            ├── Register click handler (capture phase)
            ├── Register mouseover handler   ──► Add .safeshot-manual-highlight
            └── Register mouseout handler    ──► Remove highlight
                        │
                        ▼
            User hovers element   ──► Purple dashed border appears
            User clicks element   ──► applyOverlay(target), manualCount++
```

### 5.4 Remove All Masks Flow

```
User clicks "Remove All Masking" in popup
            │
            ▼
    popup.js sends { action: "removeAllMasks" }
    via chrome.tabs.sendMessage
            │
            ▼
    content.js receives message
            │
            ├── removeAllOverlays()     ──► Remove all .safeshot-overlay divs
            │                                Remove [data-safeshot-masked] attributes
            ├── manualCount = 0
            ├── hasScanRun = false
            │
            └── sendResponse({ ok: true })
                        │
                        ▼
                popup.js resets all stats to 0
                statusText = "All masks removed"
```

### 5.5 PII Type Configuration Flow

```
User toggles a PII type checkbox in popup
            │
            ▼
    popup.js checkbox change handler
            │
            ├── Update enabledPIITypes object
            ├── Save to chrome.storage.local
            │
            └── sendToContentScript({ action: "updatePIIConfig", enabledTypes: {...} })
                        │
                        ▼
                content.js merges new config into enabledPIITypes
                (takes effect on next scan — existing masks NOT retroactively removed)


On popup re-open:
            │
            ├── chrome.storage.local.get("enabledPIITypes")
            └── Restore checkbox states from saved config
```

### 5.6 Dynamic Content Re-scan

```
MutationObserver watches document.body
            │
            ▼
    New DOM nodes added (e.g. AJAX content)
            │
            ├── Check: existing overlays present? (user has run a scan before)
            ├── Check: added node is ELEMENT_NODE, not an overlay
            │
            └── Debounce 500ms → handleDetectAndMask()
                (Full re-scan pipeline)
```

---

## 6. API Specification

### 6.1 `GET /health`

**Purpose:** Health check for extension popup status indicator.

**Response (200 OK):**
```json
{
  "status": "ok",
  "service": "SafeShot AI PII Detector",
  "presidio": true,
  "llm": true,
  "llm_model": "llama3.2",
  "ocr": true
}
```

| Field | Type | Description |
|---|---|---|
| `status` | string | Always `"ok"` if server is running |
| `presidio` | boolean | `true` if PIIDetector initialized |
| `llm` | boolean | `true` if Ollama is running and model is available |
| `llm_model` | string\|null | Name of the configured Ollama model |
| `ocr` | boolean | `true` if OCRPipeline initialized (Tesseract available) |

---

### 6.2 `GET /engines`

**Purpose:** List available detection engines and their readiness status.

**Response (200 OK):**
```json
{
  "engines": [
    {
      "id": "presidio",
      "name": "Presidio + spaCy",
      "description": "Pattern-based + NER detection (17 entity types, fast)",
      "available": true
    },
    {
      "id": "llm",
      "name": "Local LLM (llama3.2)",
      "description": "Context-aware AI detection via Ollama (25+ entity types, deeper understanding)",
      "available": false
    }
  ],
  "default": "presidio"
}
```

---

### 6.3 `POST /detect-pii`

**Purpose:** Detect PII entities in a block of text using the selected engine.

**Request:**
```json
{
  "text": "Contact John Smith at john@email.com or call 415-123-4567",
  "engine": "presidio"
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `text` | string | Yes | — | Raw text to analyze |
| `engine` | string | No | `"presidio"` | `"presidio"` or `"llm"` |

**Response (200 OK):**
```json
{
  "entities": [
    {
      "entity_type": "PERSON",
      "start": 8,
      "end": 18,
      "score": 0.85,
      "value": "John Smith"
    },
    {
      "entity_type": "EMAIL_ADDRESS",
      "start": 22,
      "end": 36,
      "score": 1.0,
      "value": "john@email.com"
    },
    {
      "entity_type": "PHONE_NUMBER",
      "start": 45,
      "end": 57,
      "score": 0.7,
      "value": "415-123-4567"
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `entity_type` | string | Presidio entity type (e.g. `PERSON`, `EMAIL_ADDRESS`) |
| `start` | integer | Character offset start (0-indexed) |
| `end` | integer | Character offset end (exclusive) |
| `score` | float | Confidence score (0.0–1.0) |
| `value` | string | The detected PII substring |

---

### 6.4 `POST /detect-image`

**Purpose:** OCR-based PII detection on screenshot images.

**Request:** `multipart/form-data` with `file` field (PNG/JPEG image).

**Response (200 OK):**
```json
{
  "entities": [
    {
      "entity_type": "EMAIL_ADDRESS",
      "value": "john@email.com",
      "score": 0.9,
      "bbox": { "x": 120, "y": 340, "w": 200, "h": 24 }
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `bbox.x` | integer | Bounding box left (pixels) |
| `bbox.y` | integer | Bounding box top (pixels) |
| `bbox.w` | integer | Bounding box width (pixels) |
| `bbox.h` | integer | Bounding box height (pixels) |

---

## 7. PII Detection Engine

### 7.1 Detection Strategy

```
                    ┌─────────────────────┐
                    │   Input Text         │
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │  Presidio Analyzer   │
                    │  (17 entity types)   │
                    ├─────────────────────┤
                    │  Built-in:           │
                    │  • PERSON (NER)      │
                    │  • EMAIL_ADDRESS     │
                    │  • PHONE_NUMBER      │
                    │  • CREDIT_CARD       │
                    │  • US_SSN            │
                    │  • IP_ADDRESS        │
                    │  • LOCATION (NER)    │
                    │  • URL               │
                    │  • ... 5 more        │
                    ├─────────────────────┤
                    │  Custom:             │
                    │  • AADHAAR_NUMBER    │
                    │  • PAN_NUMBER        │
                    │  • BANK_ACCOUNT      │
                    │  • PHONE (enhanced)  │
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │  Merge Overlapping   │
                    │  (keep highest score)│
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │  Return Entities     │
                    └─────────────────────┘
```

### 7.2 Overlap De-duplication Algorithm

Multiple recognizers may detect overlapping spans (e.g., a phone number also matching a date pattern). The `_merge_overlapping` method resolves conflicts:

1. Sort results by `start` position ascending, then `score` descending
2. Iterate through sorted results
3. If current span overlaps the previous span (`current.start < prev.end`):
   - Keep the one with the higher score
4. If no overlap, append to merged list

**Time Complexity:** O(n log n) for sort + O(n) for merge = O(n log n)

### 7.3 Supported Entity Types (17 Total)

| # | Entity Type | Detection Method | Source |
|---|---|---|---|
| 1 | `PERSON` | spaCy NER | Built-in |
| 2 | `EMAIL_ADDRESS` | Pattern | Built-in |
| 3 | `PHONE_NUMBER` | Pattern + Custom | Built-in + Custom |
| 4 | `CREDIT_CARD` | Pattern + Checksum | Built-in |
| 5 | `IBAN_CODE` | Pattern + Checksum | Built-in |
| 6 | `US_SSN` | Pattern | Built-in |
| 7 | `US_PASSPORT` | Pattern | Built-in |
| 8 | `US_DRIVER_LICENSE` | Pattern | Built-in |
| 9 | `IP_ADDRESS` | Pattern | Built-in |
| 10 | `DATE_TIME` | spaCy NER | Built-in |
| 11 | `LOCATION` | spaCy NER | Built-in |
| 12 | `NRP` | spaCy NER | Built-in |
| 13 | `MEDICAL_LICENSE` | Pattern | Built-in |
| 14 | `URL` | Pattern | Built-in |
| 15 | `AADHAAR_NUMBER` | Pattern | Custom |
| 16 | `PAN_NUMBER` | Pattern | Custom |
| 17 | `BANK_ACCOUNT` | Pattern | Custom |

---

## 8. LLM Detection Engine (v2)

### 8.1 Overview

The LLM engine provides **context-aware** PII detection using a local large language model via Ollama. Unlike pattern/NER-based Presidio, the LLM understands semantic context and can detect implied PII that no regex can catch.

**Examples of context-aware detection:**

| Input | Entity Type | Why Presidio Misses It |
|---|---|---|
| "my mother's maiden name is Parker" | `PERSON` | Not a typical name pattern |
| "I was born in Springfield" | `LOCATION` | Requires sentence context |
| "I'm 34 years old" | `AGE` | Not a Presidio entity type |
| "my password is hunter2" | `PASSWORD` | Not a Presidio entity type |
| "employee badge E-4829" | `BIOMETRIC_ID` | Custom contextual entity |
| "my car plate is ABC 1234" | `VEHICLE_NUMBER` | Not a Presidio entity type |

### 8.2 Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    LLMDetector                                │
│                                                              │
│  ┌─────────────┐    ┌───────────────┐    ┌───────────────┐  │
│  │  detect()   │───►│ _call_ollama()│───►│  Ollama API   │  │
│  │  (entry pt) │    │  (HTTP POST   │    │  /api/generate│  │
│  │             │    │   via httpx)  │    │  :11434       │  │
│  └──────┬──────┘    └───────────────┘    └───────────────┘  │
│         │                                                    │
│  ┌──────▼──────┐    ┌───────────────┐    ┌───────────────┐  │
│  │  _parse_    │───►│ _validate_    │───►│ _merge_       │  │
│  │  response() │    │  offsets()    │    │  overlapping()│  │
│  │  (JSON +    │    │  (fix LLM     │    │  (dedup)      │  │
│  │  quirks)    │    │  hallucinated │    │               │  │
│  │             │    │  positions)   │    │               │  │
│  └─────────────┘    └───────────────┘    └───────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 8.3 System Prompt Design

The LLM receives a structured system prompt that:
1. Defines the exact JSON output schema expected
2. Lists all supported entity types (25+)
3. Provides examples of contextual PII that pattern matchers miss
4. Instructs the model to return ONLY a JSON array (no prose)
5. Uses `temperature: 0.1` for deterministic output

### 8.4 Supported Entity Types (25+)

| # | Entity Type | Detection | Presidio Also? |
|---|---|---|---|
| 1–17 | *(All Presidio types)* | Semantic | Yes |
| 18 | `PASSWORD` | Contextual | LLM-only |
| 19 | `ORGANIZATION` | Contextual | LLM-only |
| 20 | `AGE` | Contextual | LLM-only |
| 21 | `GENDER` | Contextual | LLM-only |
| 22 | `NATIONALITY` | Contextual | LLM-only |
| 23 | `MEDICAL_CONDITION` | Contextual | LLM-only |
| 24 | `BIOMETRIC_ID` | Contextual | LLM-only |
| 25 | `VEHICLE_NUMBER` | Contextual | LLM-only |
| 26 | `PASSPORT_NUMBER` | Contextual | LLM-only |

### 8.5 Robustness Features

| Feature | Implementation |
|---|---|
| **Offset Validation** | LLMs often hallucinate character positions; `_validate_offsets()` verifies each entity's start/end against the actual text and corrects via `str.find()` |
| **JSON Quirk Handling** | Strips markdown code fences, fixes trailing commas, extracts JSON arrays from prose responses |
| **Long-Text Chunking** | Texts > 8000 chars are split into overlapping 6000-char chunks to stay within LLM context window |
| **Overlap De-dup** | Same algorithm as Presidio — sort by start, keep highest score on overlaps |
| **Availability Check** | `is_available()` queries Ollama `/api/tags` to verify server + model before each session |
| **Graceful Fallback** | If Ollama is unreachable, `main.py` transparently falls back to Presidio |

### 8.6 Ollama Configuration

| Config | Default | Env / Location |
|---|---|---|
| Ollama endpoint | `http://localhost:11434` | `llm_detector.py` constructor |
| Model name | `llama3.2` | `llm_detector.py` constructor |
| Temperature | `0.1` | Low for deterministic JSON output |
| Max tokens | `4096` | `num_predict` in options |
| Request timeout | `60s` | `httpx.Client(timeout=60)` |

### 8.7 Engine Comparison

| Dimension | Presidio (v1) | LLM (v2) |
|---|---|---|
| **Speed** | 50–300 ms | 2–15 s (depends on model/hardware) |
| **Entity types** | 17 | 25+ |
| **Context awareness** | None (pattern/NER only) | Full semantic understanding |
| **False positives** | Low | Very low (contextual filtering) |
| **Hardware requirement** | CPU only | GPU recommended (runs on CPU too) |
| **Dependencies** | Presidio + spaCy (pip) | Ollama (separate install) |
| **Offline fallback** | Regex patterns | → Presidio → Regex |

---

## 9. Chrome Extension Design

### 9.1 Manifest V3 Permissions

| Permission | Justification |
|---|---|
| `activeTab` | Access the currently active tab for content script messaging |
| `scripting` | Programmatic script injection if needed |
| `storage` | Persist user preferences (mask style, PII type config) across sessions |
| `downloads` | Save captured screenshots as PNG files |
| `tabs` | Query active tab for screenshot capture |
| `<all_urls>` (host) | Content script must run on any web page |

### 9.2 Masking Implementation

#### Overlay Positioning Strategy

Overlays are absolutely positioned `<div>` elements appended to `document.body`:

```javascript
{
  position: "absolute",
  top: rect.top + window.scrollY,      // Account for scroll
  left: rect.left + window.scrollX,
  width: rect.width,
  height: rect.height,
  zIndex: 2147483647,                   // Maximum z-index
  pointerEvents: "none"                 // Don't interfere with page interaction
}
```

#### Mask Styles

| Style | CSS Implementation |
|---|---|
| **Blur** | `backdrop-filter: blur(8px)` + semi-transparent dark background |
| **Black Box** | `background: #000` (opaque black) |
| **Replace** | Dark background + `•` characters matching original text length |

### 9.3 DOM Element Targeting

**Text Nodes:** TreeWalker finds text nodes containing PII values → mask the parent element.

**Form Fields:** Matched by:
1. Value-based: form values matching detected PII entities
2. Type-based: `input[type="password"]`, `input[type="email"]`
3. Name-based: `input[name*="ssn" i]`, `input[name*="aadhaar" i]`, etc.
4. Autocomplete-based: `input[autocomplete="cc-number"]`, `input[autocomplete="cc-csc"]`

### 9.4 State Tracking

| Attribute / Class | Purpose |
|---|---|
| `data-safeshot-masked` | Marks elements that have been masked (prevents double-masking) |
| `.safeshot-overlay` | Class on all overlay divs (for cleanup and style changes) |
| `.safeshot-manual-highlight` | Temporary hover highlight in manual mode |

---

## 10. OCR Pipeline

### 10.1 Pipeline Stages

```
Image Bytes ──► OpenCV Decode ──► Grayscale ──► Otsu Threshold
     │
     ▼
Tesseract image_to_data (word-level)
     │
     ├── Text: ["John", "Smith", "john@email.com", ...]
     ├── Bounding boxes: [{x, y, w, h}, ...]
     │
     ▼
Build char_offset → bbox mapping
     │
     ▼
PIIDetector.detect(full_text)
     │
     ▼
Map PII spans → union bounding boxes
     │
     ▼
Return entities with bbox coordinates
```

### 10.2 Pre-processing

| Step | OpenCV Method | Purpose |
|---|---|---|
| Grayscale | `cvtColor(COLOR_BGR2GRAY)` | Remove color information, reduce noise |
| Binarize | `threshold(THRESH_BINARY + THRESH_OTSU)` | Automatic threshold for sharp text edges |

### 10.3 Bounding Box Resolution

When a PII entity spans multiple OCR words, individual word bounding boxes are merged via union:

```
min_x = min(all word.x)
min_y = min(all word.y)
max_x = max(all word.x + word.w)
max_y = max(all word.y + word.h)
union = { x: min_x, y: min_y, w: max_x - min_x, h: max_y - min_y }
```

---

## 11. Security & Privacy

### 11.1 Threat Model

| Threat | Mitigation |
|---|---|
| PII sent to external server | All processing on `localhost`; no external network calls |
| PII persisted on disk | In-memory analysis only; no database or file storage |
| Man-in-the-middle on API calls | localhost communication; HTTPS optional via reverse proxy |
| Extension captures sensitive data | Extension only reads visible DOM text; no cookie/credential access |
| Malicious overlay injection | Overlays are `pointerEvents: none`; max z-index prevents click-jacking |
| Dynamic content leaks PII | MutationObserver re-scans within 500ms of DOM changes |

### 11.2 Data Handling Principles

| Principle | Implementation |
|---|---|
| **Data Minimization** | Only visible text and form values are extracted; hidden fields excluded |
| **No Persistence** | No PII written to disk, database, or logs (only entity types/positions logged) |
| **Local Processing** | AI service runs on `127.0.0.1`; zero external API calls |
| **User Control** | User explicitly triggers detection; no background scanning by default |
| **Configurable Scope** | Users choose exactly which PII types to detect; preferences stored locally only |
| **GDPR Article 25** | Privacy by design — masks before screenshot, not after |

### 11.3 CORS Configuration

```python
CORSMiddleware(
    allow_origins=["*"],          # Production: restrict to chrome-extension://<id>
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

**Production Recommendation:** Replace `*` with specific extension origin:
```python
allow_origins=["chrome-extension://<extension-id>"]
```

---

## 12. Technology Stack

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| **Extension** | Chrome Manifest V3 | V3 | Browser extension framework |
| **Extension UI** | HTML5 / CSS3 / JavaScript | ES2020+ | Popup interface |
| **API Framework** | FastAPI | ≥ 0.110.0 | REST API server |
| **ASGI Server** | Uvicorn | ≥ 0.29.0 | Production ASGI server |
| **PII Detection** | Microsoft Presidio Analyzer | ≥ 2.2.0 | NLP-based PII recognition |
| **PII Anonymization** | Microsoft Presidio Anonymizer | ≥ 2.2.0 | Entity anonymization utilities |
| **NLP** | spaCy | ≥ 3.7.0 | Named Entity Recognition |
| **NLP Model** | en_core_web_sm | 3.8.0 | English NER model (12 MB) |
| **Validation** | Pydantic | ≥ 2.6.0 | Request/response models |
| **OCR** | Tesseract | System install | Optical character recognition |
| **OCR Binding** | pytesseract | ≥ 0.3.10 | Python wrapper for Tesseract |
| **Image Processing** | OpenCV | ≥ 4.9.0 | Image decode, grayscale, threshold |
| **Numerical** | NumPy | ≥ 1.26.0 | Array operations for image data |
| **LLM Client** | httpx | ≥ 0.27.0 | HTTP client for Ollama API calls |
| **LLM Runtime** | Ollama | System install | Local LLM inference server |
| **LLM Model** | llama3.2 | Latest | Default Ollama model (configurable) |
| **Language** | Python | 3.12+ | Backend runtime |

---

## 13. Project Structure

```
safeshot-ai/
│
├── extension/                    # Chrome Extension (client-side)
│   ├── manifest.json             # Extension manifest (MV3)
│   ├── popup.html                # Popup UI — header, buttons, settings, stats
│   ├── popup.js                  # Popup logic — health check, action dispatch
│   ├── content.js                # Content script — DOM scan, mask, manual mode
│   ├── background.js             # Service worker — screenshot capture
│   └── styles.css                # Injected styles — overlays, highlights
│
├── ai-service/                   # Python AI Backend
│   ├── main.py                   # FastAPI app — endpoints, engine routing, CORS
│   ├── pii_detector.py           # PIIDetector class (Presidio) + OCRPipeline class
│   ├── llm_detector.py           # LLMDetector class (Ollama + prompt engineering)
│   └── requirements.txt          # Python dependencies
│
└── README.md                     # Project documentation
```

**File Sizes (approximate):**

| File | Lines | Size | Complexity |
|---|---|---|---|
| content.js | ~645 | ~20 KB | High — DOM manipulation, API calls, overlay engine, PII filtering, engine mode |
| llm_detector.py | ~320 | ~11 KB | High — Ollama API, prompt engineering, offset validation, chunking |
| pii_detector.py | 318 | ~10 KB | High — Presidio config, custom recognizers, OCR |
| popup.html | ~350 | ~11 KB | Medium — Inline CSS, engine selector, PII config grid, semantic HTML |
| main.py | ~220 | ~7 KB | Medium — FastAPI endpoints, engine routing, Pydantic models |
| popup.js | ~210 | ~6 KB | Medium — Event handlers, engine/PII config persistence, message passing |
| background.js | 70 | ~2 KB | Low — Screenshot capture |
| styles.css | 50 | ~1 KB | Low — Overlay styles |
| manifest.json | 31 | ~0.6 KB | Config |

---

## 14. Deployment & Configuration

### 14.1 Local Development Setup

#### AI Service

```bash
cd ai-service
python -m venv venv
source venv/bin/activate          # Linux/Mac
venv\Scripts\activate             # Windows

pip install -r requirements.txt
python -m spacy download en_core_web_sm

uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

#### LLM Engine (Optional — requires Ollama)

```bash
# Install Ollama:  https://ollama.ai/download
# Then pull a model:
ollama pull llama3.2

# Ollama serves on http://localhost:11434 by default.
# The FastAPI server auto-detects Ollama availability at startup.
```

#### Chrome Extension

1. Navigate to `chrome://extensions/`
2. Enable **Developer Mode**
3. Click **Load Unpacked** → select `extension/` folder
4. Extension icon appears in toolbar
5. On first install, the Settings (options) page opens automatically for backend URL configuration

### 14.2 Docker Deployment

```bash
# From the safeshot-ai/ root directory
docker compose up -d
```

This starts the API on port 8000 and (optionally) Ollama on port 11434.

First-time Ollama model pull:
```bash
docker exec -it safeshot-ai-ollama-1 ollama pull llama3.2
```

### 14.3 Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SAFESHOT_API_KEY` | *(empty)* | Set to require `X-API-Key` header on all requests (health endpoint exempt) |
| `SAFESHOT_ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins; restrict to `chrome-extension://YOUR_ID` in production |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API base URL (overrides default in LLMDetector) |

### 14.4 API Key Authentication

When `SAFESHOT_API_KEY` is set:
- All endpoints except `/health`, `/docs`, `/openapi.json` require `X-API-Key` header
- Unauthenticated requests receive HTTP 401
- The Chrome extension sends the key from `chrome.storage.local` (configured in Settings page)

### 14.5 Configuration Points

| Config | Location | Default | Description |
|---|---|---|---|
| API Base URL | Settings page → `chrome.storage.local` | `http://127.0.0.1:8000` | FastAPI service address (configurable per-user) |
| API Key | Settings page → `chrome.storage.local` | *(empty)* | Authentication key sent via `X-API-Key` header |
| Regex Fallback | Settings page → `chrome.storage.local` | `true` | Use regex patterns when backend is offline |
| Auto-scan | Settings page → `chrome.storage.local` | `false` | Automatically detect PII on page load |
| Mask Style | `chrome.storage.local` | `blur` | User-selected mask style |
| Enabled PII Types | `chrome.storage.local` | 12 of 14 enabled | Per-type toggles (see §4.1.2 table) |
| Detection Engine | `chrome.storage.local` | `presidio` | `"presidio"` or `"llm"` |
| Ollama Endpoint | `OLLAMA_BASE_URL` env var | `http://localhost:11434` | Ollama API base URL |
| Ollama Model | `llm_detector.py` | `llama3.2` | Model name for `ollama pull` |
| LLM Temperature | `llm_detector.py` | `0.1` | Low for deterministic JSON output |
| LLM Timeout | `llm_detector.py` | `60s` | Max wait for Ollama response |
| Score Threshold | `pii_detector.py` | `0.35` | Minimum confidence for PII detection |
| CORS Origins | `SAFESHOT_ALLOWED_ORIGINS` env var | `*` | Allowed request origins |
| Server Port | CLI argument | `8000` | Uvicorn listening port |
| OCR Dependencies | `pii_detector.py` | Optional | Gracefully disabled if Tesseract not installed |

### 14.6 Distribution & Packaging

#### Extension Package

```bash
python build.py    # Creates safeshot-ai-v2.0.0.zip
```

The `build.py` script packages all 11 extension files into a distributable zip.

#### Sharing Options

| Method | Audience | Backend Required |
|---|---|---|
| Share `.zip` (regex-only mode) | Small team, basic PII | ❌ No |
| Share `.zip` + hosted backend URL | Team, full AI detection | ✅ Yes (shared server) |
| Chrome Web Store | Public | ✅ Optional |
| Docker Compose | Self-hosted team deployment | ✅ Yes |

### 14.7 Optional: Tesseract OCR Installation

| OS | Command |
|---|---|
| Windows | `choco install tesseract` |
| macOS | `brew install tesseract` |
| Linux | `sudo apt install tesseract-ocr` |

---

## 15. Performance Considerations

### 15.1 Latency Budget

| Operation | Expected Latency | Notes |
|---|---|---|
| DOM text extraction | < 50 ms | TreeWalker is synchronous |
| Form value extraction | < 10 ms | Simple query selector |
| API round-trip | 100–500 ms | Depends on text length; ~200ms for 1 KB text |
| Presidio analysis | 50–300 ms | spaCy NER is the bottleneck |
| LLM analysis | 2–15 s | Depends on model size and GPU/CPU; llama3.2 ~3s on GPU |
| Regex fallback | < 20 ms | Runs in browser, no network |
| Overlay application | < 100 ms | DOM manipulation per entity |
| Screenshot capture | < 200 ms | Chrome native API |
| **Total (Presidio mode)** | **300–900 ms** | End-to-end detect & mask |
| **Total (LLM mode)** | **3–16 s** | Deeper analysis, more entity types |
| **Total (regex mode)** | **50–150 ms** | Offline fallback |

### 15.2 Optimization Strategies

| Strategy | Implementation |
|---|---|
| Singleton NLP models | `PIIDetector` and `LLMDetector` created once at startup, reused across requests |
| Lazy OCR loading | OCR dependencies imported only in `OCRPipeline.__init__`; service works without them |
| Lazy LLM loading | `LLMDetector.is_available()` cached after first check; re-checkable on demand |
| LLM text chunking | Long texts (> 8 KB) split into overlapping chunks to stay within context window |
| Debounced re-scanning | MutationObserver waits 500 ms before re-scanning |
| Dedup before masking | `Set` of elements prevents duplicate overlay creation |
| `data-safeshot-masked` attribute | Prevents re-masking same element |
| Overlap merging | Reduces entity count sent to frontend |

### 15.3 Scalability Limits

| Dimension | Limit | Mitigation |
|---|---|---|
| Page text size | > 100 KB may slow Presidio | Text chunking (future) |
| Number of overlays | > 500 overlays affect rendering | Batch DOM updates (future) |
| Concurrent users | Single-worker Uvicorn | Deploy with `--workers N` or Gunicorn |
| OCR image size | Large screenshots (> 10 MP) | Image downscaling (future) |

---

## 16. Future Enhancements

### 16.1 Completed in v1.1

| Feature | Description | Status |
|---|---|---|
| Remove All Masking | One-click button to strip all overlays and reset state | ✅ Done |
| PII Type Configuration | 14-toggle checkbox grid to select which PII types to detect/mask | ✅ Done |
| Persistent Config | PII type preferences saved in `chrome.storage.local` across sessions | ✅ Done |
| Live Config Push | Checkbox changes sent to content script immediately via `updatePIIConfig` | ✅ Done |
| Entity Filtering | Detection pipeline filters entities against user config before masking | ✅ Done |
| Conditional Form/Password Masking | `FORM_FIELDS` and `PASSWORD_FIELD` toggles gate respective masking steps | ✅ Done |

### 16.2 Completed in v2.0

| Feature | Description | Status |
|---|---|---|
| LLM Detection Engine | Local LLM via Ollama (llama3.2) for context-aware PII detection | ✅ Done |
| Engine Selector UI | Two-option selector in popup (Presidio v1 / LLM v2) with availability badges | ✅ Done |
| Per-Request Engine Switching | `engine` parameter on `/detect-pii` routes to selected engine | ✅ Done |
| LLM → Presidio Fallback | Automatic fallback to Presidio if Ollama is unavailable | ✅ Done |
| `/engines` Endpoint | New API endpoint listing available engines and their status | ✅ Done |
| Health Endpoint Enhanced | `/health` now reports `llm`, `llm_model` fields | ✅ Done |
| LLM Offset Validation | Corrects hallucinated character offsets from LLM output | ✅ Done |
| Long-Text Chunking | Overlapping chunk strategy for texts > 8000 chars | ✅ Done |
| Persistent Engine Pref | Selected engine saved in `chrome.storage.local` | ✅ Done |
| 25+ Entity Types (LLM) | AGE, PASSWORD, ORGANIZATION, MEDICAL_CONDITION, VEHICLE_NUMBER, etc. | ✅ Done |

### 16.3 Completed in v2.0 — Production Readiness

| Feature | Description | Status |
|---|---|---|
| Extension Icons | PNG icons (16px, 48px, 128px) for toolbar and Chrome Web Store | ✅ Done |
| Options / Settings Page | Full settings page with API URL, API key, regex fallback, auto-scan | ✅ Done |
| Dynamic API URL | API_BASE read from `chrome.storage.local` instead of hardcoded | ✅ Done |
| API Key Auth | `X-API-Key` header support (env-based `SAFESHOT_API_KEY`) | ✅ Done |
| CORS Lockdown | `SAFESHOT_ALLOWED_ORIGINS` env var replaces hardcoded `*` | ✅ Done |
| Dockerfile | Production container build for the backend | ✅ Done |
| Docker Compose | One-command deployment (API + Ollama) | ✅ Done |
| Build Script | `build.py` packages extension into distributable .zip | ✅ Done |
| INSTALL.md | Comprehensive user guide for installation & distribution | ✅ Done |
| Auto-scan Option | Optional auto-scan on page load (off by default) | ✅ Done |
| Storage Listener | Content script reacts to settings changes in real-time | ✅ Done |
| Settings Gear in Popup | ⚙️ icon in header opens options page | ✅ Done |
| Manifest v2.0.0 | Version bumped, icons registered, options_page declared | ✅ Done |

### 16.4 Short-Term (v2.1)

| Feature | Description |
|---|---|
| Undo individual mask | Click to remove a single overlay (not all) |
| Keyboard shortcuts | Ctrl+Shift+M to toggle mask, Ctrl+Shift+S to screenshot |
| Badge count | Show detected PII count on extension icon |
| Custom regex patterns | User-defined patterns via options page |
| Privacy policy | Hosted privacy policy for Chrome Web Store submission |

### 16.5 Medium-Term (v3.0)

| Feature | Description |
|---|---|
| Full-page screenshot | Scroll-capture with stitching for long pages |
| Whitelist/blacklist | Per-domain masking rules |
| Custom entity types | User-defined regex patterns via UI |
| Batch processing | Mask multiple tabs simultaneously |
| Audit log | Local CSV export of detection events (no PII values) |
| RPA integration | Expose `window.__safeshot.mask()` API for automation tools |

### 16.6 Long-Term (v4.0)

| Feature | Description |
|---|---|
| Multi-language NLP | spaCy models for DE, FR, ES, HI, ZH |
| Enterprise deployment | Central config server, group policy, managed Chrome extension |
| Cloud option | Optional Azure/AWS deployment with encrypted transit |
| Presidio Anonymizer | Replace PII with synthetic data instead of masks |
| Video/meeting mode | Real-time screen masking for screen-sharing |

---

*End of Technical Design Document*
