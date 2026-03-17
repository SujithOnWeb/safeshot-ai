# SafeShot AI — AI-Powered PII Masking Chrome Extension

> Automatically detect and redact Personally Identifiable Information (PII) on web pages before screenshots are taken.

---

## Architecture

```
┌─────────────────────┐        REST API        ┌──────────────────────┐
│  Chrome Extension    │ ◄────────────────────► │  FastAPI AI Service   │
│  (Manifest V3)       │   POST /detect-pii     │  (Presidio + spaCy)   │
│                      │   POST /detect-image    │  (Tesseract OCR)      │
│  • content.js        │                        │                        │
│  • popup.html/js     │                        │  • pii_detector.py     │
│  • background.js     │                        │  • main.py             │
└─────────────────────┘                        └──────────────────────┘
```

## Features

- **AI-powered PII detection** — Microsoft Presidio + spaCy NLP
- **Regex fallback** — works offline when the AI service is unavailable
- **Three mask styles** — Blur, Black Box, Text Replacement (••••)
- **Manual mask mode** — click any element to mask it
- **Screenshot capture** — one-click masked screenshot download
- **Dynamic content support** — MutationObserver re-scans new DOM nodes
- **Form field detection** — auto-masks passwords, emails, SSNs, etc.
- **OCR pipeline** — Tesseract + OpenCV for image-based PII detection
- **Local-first & GDPR-compliant** — no data leaves your machine

## Supported PII Types

| Category | Examples |
|---|---|
| Names | John Smith, Mary Johnson |
| Email | john@example.com |
| Phone | +1 (415) 123-4567 |
| Credit Card | 4111 1111 1111 1111 |
| SSN | 123-45-6789 |
| Aadhaar | 1234 5678 9012 |
| PAN | ABCDE1234F |
| IP Address | 192.168.1.1 |
| Bank Account | 9–18 digit numbers |
| Passwords | Input fields of type password |
| Addresses | Detected via NLP |

---

## Quick Start

### 1. Start the AI Service

```bash
cd ai-service

# Create virtual environment (recommended)
python -m venv venv
source venv/bin/activate   # Linux/Mac
venv\Scripts\activate      # Windows

# Install dependencies
pip install -r requirements.txt

# Download spaCy English model
python -m spacy download en_core_web_sm

# Start the server
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Verify it's running:
```bash
curl http://127.0.0.1:8000/health
```

### 2. Load the Chrome Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. The SafeShot AI icon appears in your toolbar

### 3. Use the Extension

1. Navigate to any web page with PII (e.g. a form, profile page, email)
2. Click the SafeShot AI icon in the toolbar
3. Choose your mask style (Blur / Black Box / Replace)
4. Click **Detect & Mask PII** — the extension scans the page and masks detected PII
5. Optionally use **Manual Mask Mode** to click-mask additional elements
6. Click **Capture Masked Screenshot** to download a clean PNG

---

## Project Structure

```
safeshot-ai/
├── extension/
│   ├── manifest.json      # Chrome Extension Manifest V3
│   ├── popup.html         # Extension popup UI
│   ├── popup.js           # Popup controller logic
│   ├── content.js         # Content script — DOM scanning & masking
│   ├── background.js      # Service worker — screenshot capture
│   └── styles.css         # Injected styles for overlays
│
├── ai-service/
│   ├── main.py            # FastAPI server with endpoints
│   ├── pii_detector.py    # Presidio detector + OCR pipeline
│   └── requirements.txt   # Python dependencies
│
└── README.md
```

## API Reference

### `GET /health`
Returns service status.

```json
{
  "status": "ok",
  "service": "SafeShot AI PII Detector",
  "presidio": true,
  "ocr": true
}
```

### `POST /detect-pii`
Detect PII in text content.

**Request:**
```json
{
  "text": "Contact John Smith at john@email.com or call 415-123-4567"
}
```

**Response:**
```json
{
  "entities": [
    { "entity_type": "PERSON", "start": 8, "end": 18, "score": 0.85, "value": "John Smith" },
    { "entity_type": "EMAIL_ADDRESS", "start": 22, "end": 36, "score": 0.95, "value": "john@email.com" },
    { "entity_type": "PHONE_NUMBER", "start": 45, "end": 57, "score": 0.75, "value": "415-123-4567" }
  ]
}
```

### `POST /detect-image`
Upload a screenshot image for OCR-based PII detection.

**Request:** `multipart/form-data` with `file` field.

**Response:**
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

---

## Security & Privacy

- **Local-only processing** — all PII detection runs on `localhost`
- **No data storage** — text is analysed in-memory and never persisted
- **No external calls** — the AI service does not phone home
- **GDPR-compliant** — designed for data minimisation and privacy by default
- **HTTPS-ready** — deploy behind a reverse proxy for encrypted communication

---

## Optional: Install Tesseract OCR

The OCR pipeline requires Tesseract installed on the host:

**Windows:**
```
choco install tesseract
```

**macOS:**
```
brew install tesseract
```

**Linux:**
```
sudo apt install tesseract-ocr
```

---

## Tech Stack

| Component | Technology |
|---|---|
| Extension | Chrome Manifest V3, JavaScript |
| UI | HTML, CSS |
| AI Engine | Microsoft Presidio, spaCy |
| NLP Model | `en_core_web_sm` |
| Server | Python, FastAPI, Uvicorn |
| OCR | Tesseract, OpenCV |
| Communication | REST API (JSON) |

---

## License

MIT — Free for personal and commercial use.
