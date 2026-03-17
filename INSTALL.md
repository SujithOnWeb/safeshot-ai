# SafeShot AI — Installation & User Guide

> **AI-Powered PII Masking Chrome Extension**
> Detect and redact sensitive data (names, emails, SSNs, credit cards, phone numbers, etc.) before taking screenshots. Local-first, GDPR-compliant.

---

## Table of Contents

1. [Quick Start (Extension Only)](#1-quick-start-extension-only)
2. [Setting Up the AI Backend](#2-setting-up-the-ai-backend)
3. [Docker Deployment](#3-docker-deployment)
4. [Configuration](#4-configuration)
5. [How to Use](#5-how-to-use)
6. [Sharing With Others](#6-sharing-with-others)
7. [Troubleshooting](#7-troubleshooting)
8. [Chrome Web Store Publishing](#8-chrome-web-store-publishing)

---

## 1. Quick Start (Extension Only)

The extension works **without** the AI backend using built-in regex patterns for basic PII detection (emails, phone numbers, SSNs, credit cards, IP addresses).

### Install from .zip

1. Download `safeshot-ai-v2.0.0.zip`
2. Extract the zip to a folder (e.g., `C:\SafeShot-AI\`)
3. Open Chrome → navigate to `chrome://extensions/`
4. Enable **Developer mode** (toggle in top-right)
5. Click **"Load unpacked"** → select the extracted folder
6. The 🛡️ SafeShot AI icon appears in your toolbar

### Install from source

```bash
git clone <your-repo-url>
cd safeshot-ai
```

Then load the `extension/` folder as an unpacked extension (steps 3–6 above).

---

## 2. Setting Up the AI Backend

The AI backend provides **much better PII detection** using Microsoft Presidio + spaCy NER (and optionally a local LLM via Ollama).

### Prerequisites

- Python 3.10+ (recommended: 3.12)
- pip

### Install & Run

```bash
cd ai-service

# Install dependencies
pip install -r requirements.txt

# Download spaCy language model
python -m spacy download en_core_web_sm

# Start the server
uvicorn main:app --host 0.0.0.0 --port 8000
```

The API runs at `http://127.0.0.1:8000`. Verify with:

```
curl http://127.0.0.1:8000/health
```

### (Optional) Enable LLM Engine

For context-aware PII detection using a local LLM:

1. Install [Ollama](https://ollama.ai/)
2. Pull the model: `ollama pull llama3.2`
3. Restart the SafeShot AI backend
4. In the extension popup, select the **"Local LLM"** engine

---

## 3. Docker Deployment

The easiest way to run the backend (especially for sharing with a team):

```bash
# From the safeshot-ai/ root directory
docker compose up -d
```

This starts:
- **safeshot-api** on port `8000` — the PII detection API
- **ollama** on port `11434` — for LLM-based detection (optional)

### First-time Ollama setup (if using LLM engine)

```bash
docker exec -it safeshot-ai-ollama-1 ollama pull llama3.2
```

### Configure with environment variables

Copy `.env.example` to `.env` and edit:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `SAFESHOT_API_KEY` | *(empty)* | Set to require API key authentication |
| `SAFESHOT_ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |

---

## 4. Configuration

### Extension Settings Page

Click the ⚙️ gear icon in the extension popup (or right-click the extension → "Options") to configure:

| Setting | Default | Description |
|---------|---------|-------------|
| **Backend API URL** | `http://127.0.0.1:8000` | Where the AI service is running |
| **API Key** | *(empty)* | If your backend requires authentication |
| **Regex Fallback** | ✅ On | Use built-in patterns when backend is offline |
| **Auto-scan** | ❌ Off | Automatically detect PII on every page load |

### API Key Security

When deploying the backend to a shared server:

1. Set `SAFESHOT_API_KEY=your-secret-key-here` in the backend's `.env`
2. Enter the same key in the extension's Settings → API Key field
3. The key is stored locally in Chrome and sent via `X-API-Key` header

---

## 5. How to Use

### Basic Workflow

1. Navigate to any web page with sensitive data
2. Click the 🛡️ SafeShot AI icon in your toolbar
3. Click **"Detect & Mask PII"** — the extension finds and masks all PII
4. Click **"Capture Masked Screenshot"** to save a clean screenshot

### Features

| Feature | Description |
|---------|-------------|
| **Detect & Mask** | One-click AI scan of the current page |
| **Manual Mask** | Click-to-mask individual elements |
| **Remove All** | Clear all masks and start fresh |
| **Mask Styles** | Blur, Black Box, or Replace with •••• |
| **PII Types** | Toggle which PII types to detect (14 types) |
| **Engine Selector** | Choose Presidio (fast) or LLM (deep) |
| **Screenshot** | Capture the masked page as PNG |

### Detection Modes

| Mode | Requires Backend | PII Types | Speed |
|------|:----------------:|-----------|:-----:|
| **Regex Fallback** | ❌ | Email, Phone, SSN, Credit Card, Aadhaar, IP | ⚡ Instant |
| **Presidio (v1)** | ✅ | 17 types including Names, Addresses | 🟢 Fast |
| **Local LLM (v2)** | ✅ + Ollama | 25+ types, context-aware | 🟡 2-5s |

---

## 6. Sharing With Others

### Option A: Share the Extension .zip (Easiest)

```bash
python build.py
```

This creates `safeshot-ai-v2.0.0.zip`. Send this file to your team. They install it via:
1. Extract the zip
2. Chrome → `chrome://extensions/` → Developer mode → Load unpacked

**If using only the extension (no backend):** It works out-of-the-box with regex fallback for basic PII detection.

**If using the AI backend:** Each user configures the backend URL in Settings (⚙️).

### Option B: Host the Backend for Your Team

1. Deploy the backend on a shared server (Docker recommended)
2. Set `SAFESHOT_API_KEY` to secure it
3. Share the extension .zip + backend URL + API key with your team
4. Users enter the URL and key in Settings

### Option C: Chrome Web Store (Public Distribution)

See [Section 8](#8-chrome-web-store-publishing) below.

---

## 7. Troubleshooting

### "AI service offline — using rules only"

- The backend isn't running or is unreachable
- Check: `curl http://127.0.0.1:8000/health`
- Verify the URL in Settings matches where the backend is running

### Extension doesn't mask anything

- Click "Detect & Mask PII" first (no auto-scan by default)
- Check PII Types config — some types may be toggled off
- Open DevTools Console for `[SafeShot]` log messages

### "LLM engine not available"

- Install [Ollama](https://ollama.ai/) and run `ollama pull llama3.2`
- Ollama must be running when the backend starts
- Check `http://localhost:11434` is accessible

### CORS errors in console

- The backend's `SAFESHOT_ALLOWED_ORIGINS` doesn't include your extension's origin
- For development, set to `*`; for production, use `chrome-extension://YOUR_ID`

### Extension doesn't load after update

- Go to `chrome://extensions/` → click the reload ↻ button on SafeShot AI
- Check for errors in the extension's "Errors" section

---

## 8. Chrome Web Store Publishing

To publish SafeShot AI publicly:

### Prerequisites

1. [Chrome Web Store Developer account](https://chrome.google.com/webstore/devconsole/) ($5 one-time fee)
2. Extension icons: 128×128 (included) + 440×280 promotional tile
3. Privacy policy (required for extensions that handle sensitive data)

### Steps

1. Run `python build.py` to create the .zip
2. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/)
3. Click "New Item" → Upload `safeshot-ai-v2.0.0.zip`
4. Fill in:
   - **Description:** AI-powered PII masking — detect and redact sensitive data before screenshots
   - **Category:** Productivity
   - **Privacy policy URL:** *(your hosted privacy policy)*
   - **Single purpose:** "Detect and mask personally identifiable information on web pages"
5. Submit for review (typically 1–3 business days)

### Privacy Policy Considerations

Since SafeShot AI processes web page content, your privacy policy should state:
- All PII detection happens locally (on-device or user-hosted backend)
- No data is sent to third-party servers
- The extension does not collect, store, or share user browsing data
- Any backend communication is to user-configured, user-controlled servers only

### Host Permissions Note

`<all_urls>` is required because the extension needs to scan any page the user visits. Chrome Web Store reviewers may ask you to justify this — the reason is that PII can appear on any website (CRM, email, banking, etc.).

---

## Architecture Overview

```
┌─────────────────────────────────┐
│     Chrome Extension (JS)       │
│  popup.js │ content.js │ bg.js  │
│  ─────────┼────────────┤        │
│  Regex    │ Overlay    │ Screen  │
│  Fallback │ Engine     │ Capture │
└─────┬─────┴────────────┴────────┘
      │ REST API (configurable URL)
      ▼
┌─────────────────────────────────┐
│   Python Backend (FastAPI)      │
│  ┌──────────┐  ┌─────────────┐  │
│  │ Presidio │  │ Ollama LLM  │  │
│  │ + spaCy  │  │ (llama3.2)  │  │
│  └──────────┘  └─────────────┘  │
│         ┌─────────────┐         │
│         │ OCR Pipeline│         │
│         │ (Tesseract) │         │
│         └─────────────┘         │
└─────────────────────────────────┘
```

---

## File Structure

```
safeshot-ai/
├── extension/              # Chrome extension (distributable)
│   ├── manifest.json       # Extension manifest (v3)
│   ├── popup.html/js       # Extension popup UI
│   ├── content.js          # Page scanning & masking engine
│   ├── background.js       # Service worker (screenshots)
│   ├── styles.css          # Overlay styles
│   ├── options.html/js     # Settings page (API URL, key)
│   └── icon{16,48,128}.png # Extension icons
├── ai-service/             # Python backend
│   ├── main.py             # FastAPI server (v2.0)
│   ├── pii_detector.py     # Presidio + custom recognizers
│   ├── llm_detector.py     # LLM detection via Ollama
│   ├── requirements.txt    # Python dependencies
│   └── Dockerfile          # Container build
├── docker-compose.yml      # One-command backend deployment
├── build.py                # Extension packager
├── .env.example            # Environment variable template
├── INSTALL.md              # This file
├── README.md               # Project overview
└── TECHNICAL_DESIGN_DOCUMENT.md  # Detailed architecture docs
```
