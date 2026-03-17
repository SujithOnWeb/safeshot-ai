# SafeShot AI: Building an AI-Powered Privacy Shield for the Browser

> How we combined Microsoft Presidio, spaCy NER, a local LLM, and OCR into a real-time PII masking engine — all running on localhost.

---

## The Problem No One Screenshots About

Every day, millions of screenshots are taken inside enterprise applications — CRM dashboards, support tickets, HR portals, healthcare records. And every day, those screenshots silently leak Personally Identifiable Information: names, emails, phone numbers, credit card numbers, government IDs, and medical data.

The consequences are not hypothetical. A single unredacted screenshot shared in a Slack channel, a Jira ticket, or a vendor email can trigger GDPR, HIPAA, or PCI-DSS violations — with fines reaching into the millions.

**The core challenge:** How do you protect PII *before* the screenshot is taken, without slowing down the user's workflow?

---

## Introducing SafeShot AI

SafeShot AI is a Chrome browser extension backed by a local AI service that **automatically detects and masks PII on any web page** — in real time, before a screenshot is captured.

No data leaves the user's machine. No cloud APIs. No third-party processing. Everything runs on `localhost`.

### What Makes It Different

| Traditional Approach | SafeShot AI |
|---|---|
| Manual redaction after capture | Automatic detection before capture |
| Regex-only pattern matching | AI + NLP + LLM + Regex (layered) |
| Limited to known formats | Context-aware semantic detection |
| Cloud-based processing | 100% local — zero data exfiltration |
| Single detection method | Dual-engine architecture with graceful fallback |

---

## The AI Architecture: Three Layers of Intelligence

SafeShot AI doesn't rely on a single detection method. It employs a **layered AI architecture** where each layer adds depth, and the system degrades gracefully if any layer is unavailable.

```
┌─────────────────────────────────────────────────────┐
│           Layer 3: Local LLM (Ollama)                │
│   Context-aware semantic detection — 25+ entity types │
│   "my mother's maiden name is Parker" → PERSON       │
│   "employee badge E-4829" → BIOMETRIC_ID             │
├─────────────────────────────────────────────────────┤
│           Layer 2: Presidio + spaCy NER              │
│   Pattern matching + Named Entity Recognition         │
│   17 entity types — 50–300ms per scan                │
├─────────────────────────────────────────────────────┤
│           Layer 1: Client-Side Regex                 │
│   6 high-confidence patterns — works fully offline    │
│   < 20ms — zero network dependency                   │
└─────────────────────────────────────────────────────┘

        Fallback direction: LLM → Presidio → Regex
```

### Layer 1: Regex Patterns (The Safety Net)

When the AI backend is unreachable, the browser extension falls back to six high-confidence regex patterns that catch the most common PII formats: emails, phone numbers, SSNs, credit cards, Aadhaar numbers, and IP addresses.

This layer runs entirely in the browser in under 20ms. It's the guarantee that the extension never shows "service unavailable" — it always protects *something*.

### Layer 2: Microsoft Presidio + spaCy NER (The Workhorse)

The primary detection engine combines **Microsoft Presidio** (an open-source PII detection framework) with **spaCy's `en_core_web_sm` NER model** for named entity recognition.

**Why Presidio?**
- Battle-tested by Microsoft across enterprise deployments
- Extensible recognizer registry — we added 4 custom recognizers for Indian PII formats (Aadhaar, PAN, bank accounts, enhanced phone numbers)
- Built-in overlap de-duplication: when multiple recognizers flag the same text span, the highest-confidence result wins
- Deterministic and fast — 50–300ms for a full page scan

**How the NLP pipeline works:**

```
Page Text → spaCy Tokenizer → NER Model → Entity Labels
                                              │
                    ┌─────────────────────────┼────────────────────┐
                    ▼                         ▼                    ▼
              PERSON: "John Smith"    LOCATION: "Springfield"    DATE_TIME: "March 2026"
                    │                         │                    │
                    ▼                         ▼                    ▼
         Presidio Pattern Recognizers (EMAIL, PHONE, CREDIT_CARD, SSN, ...)
                    │
                    ▼
         Custom Recognizers (AADHAAR, PAN, BANK_ACCOUNT, PHONE enhanced)
                    │
                    ▼
         Overlap Merge (sort by position, keep highest score)
                    │
                    ▼
         Final Entity List → Chrome Extension
```

**Custom recognizers we built:**

| Recognizer | Entity | Why It Matters |
|---|---|---|
| `AadhaarRecognizer` | 12-digit Indian national ID | Not in standard Presidio; 1.4B people use this ID |
| `PANRecognizer` | Indian tax ID (ABCDE1234F) | Financial compliance in Indian enterprises |
| `BankAccountRecognizer` | 9–18 digit account numbers | Catches account numbers that look like plain numbers |
| `CustomPhoneRecognizer` | International + US formats | Presidio's built-in phone recognizer misses many formats |

### Layer 3: Local LLM via Ollama (The Deep Thinker)

This is where SafeShot AI goes beyond what any pattern matcher or NER model can do.

A local large language model (Meta's **Llama 3.2**, served via **Ollama**) provides **semantic, context-aware PII detection**. It understands *meaning*, not just syntax.

**What the LLM catches that Presidio can't:**

| Input Text | Detected Entity | Why Pattern Matching Fails |
|---|---|---|
| "my mother's maiden name is Parker" | `PERSON` | "Parker" isn't in a typical name context |
| "I'm 34 years old" | `AGE` | Not a Presidio entity type at all |
| "my password is hunter2" | `PASSWORD` | Requires understanding the sentence |
| "employee badge E-4829" | `BIOMETRIC_ID` | Custom identifier, no standard pattern |
| "I was born in Springfield" | `LOCATION` | Requires sentence-level inference |
| "diagnosed with Type 2 diabetes" | `MEDICAL_CONDITION` | Medical context detection |
| "my car plate is ABC 1234" | `VEHICLE_NUMBER` | No standard regex exists |

**LLM prompt engineering:**

We designed a structured system prompt that:
1. Defines an exact JSON output schema (no prose allowed)
2. Lists all 25+ supported entity types with examples
3. Uses `temperature: 0.1` for near-deterministic output
4. Instructs the model to return character offsets for precise DOM targeting

**Robustness against LLM quirks:**

LLMs are powerful but unreliable at structured output. We built multiple safety nets:

| Problem | Our Solution |
|---|---|
| Hallucinated character offsets | `_validate_offsets()` — verifies every start/end against the actual text, corrects via `str.find()` |
| Markdown code fences in output | Automatic stripping of ` ```json ` wrappers |
| Trailing commas in JSON | Pre-parse cleanup before `json.loads()` |
| Text exceeds context window | Overlapping chunk strategy — 6K chunks with overlap for texts > 8K chars |
| Ollama server unreachable | Transparent fallback to Presidio engine |

---

## The Real-Time Masking Engine

Detecting PII is only half the problem. The other half is **applying visual masks to a live web page** without disrupting the user experience — especially on dynamic single-page applications like Dynamics 365 CRM, Salesforce Lightning, or ServiceNow.

### How DOM Masking Works

```
1. TreeWalker extracts all visible text from the DOM
2. Form values (inputs, textareas, selects) are collected separately
3. Combined text is sent to the AI service
4. Detected PII values are mapped back to DOM nodes
5. Absolutely-positioned overlay divs are placed on top of each PII element
6. Overlays use z-index: 2147483647 (maximum) and pointer-events: none
```

Three mask styles are available — all switchable in real time:

| Style | Visual Effect | Use Case |
|---|---|---|
| **Blur** | `backdrop-filter: blur(8px)` | Professional look for demos |
| **Black Box** | Solid black rectangle | Maximum obscuration |
| **Text Replace** | `••••••••` characters | Shows something was redacted |

### Solving the Dynamic UI Challenge

Modern web apps (CRMs, ERPs, SaaS dashboards) constantly mutate the DOM — loading data via AJAX, swapping components, updating grids. A naive MutationObserver re-scan would cause visible "blink" as masks are removed and re-applied.

**Our solution — a three-part strategy:**

1. **Cached Incremental Scans:** When the DOM changes, we don't call the API again. Instead, we use the cached PII values from the last full scan and do a synchronous DOM walk (~1–5ms). Zero network latency, zero visual gap.

2. **Disconnect/Reconnect Observer Pattern:** Instead of a flag-based pause (which leaks queued mutations), we fully `disconnect()` the MutationObserver during mask operations and `reconnect()` only after a double `requestAnimationFrame` — ensuring the browser has flushed all pending DOM writes.

3. **Scan Cooldown:** A 3-second cooldown between observer-triggered scans prevents rapid-fire mutations from causing detection loops.

The result: masks appear once and stay stable, even on the most aggressively dynamic UIs.

---

## OCR: When PII Is in Images

Not all PII lives in the DOM. Screenshots within screenshots, scanned documents embedded in web pages, and canvas-rendered text all contain PII that DOM scanning can't reach.

SafeShot AI includes an **OCR pipeline** powered by **OpenCV** and **Tesseract**:

```
Image → Grayscale → Otsu Binarization → Tesseract OCR → Word-Level Bboxes
                                                              │
                                                    Presidio Detection
                                                              │
                                                    PII with Bounding Boxes
```

Each detected PII entity comes with pixel-level bounding box coordinates, enabling precise overlay placement even on image content.

---

## Privacy by Design

SafeShot AI was built with **GDPR Article 25 (Privacy by Design)** as a first principle:

| Principle | How We Implement It |
|---|---|
| **Data Minimization** | Only visible text and form values are extracted — no cookies, no hidden fields, no network traffic |
| **No Persistence** | Zero PII is written to disk, database, or log files. Only entity *types* and *positions* are logged |
| **Local Processing** | AI service runs on `127.0.0.1` — no external API calls, no cloud dependencies |
| **User Control** | Detection is user-triggered (not automatic by default). Users choose exactly which PII types to detect via 14 toggles |
| **Pre-Capture Masking** | PII is masked *before* the screenshot, not redacted after — the sensitive data never enters the image |

**The key insight:** By masking before capture rather than redacting after, we eliminate the risk class entirely. The PII never exists in the screenshot file.

---

## Performance Profile

| Operation | Latency | Notes |
|---|---|---|
| DOM text extraction | < 50ms | Synchronous TreeWalker |
| Presidio detection | 50–300ms | spaCy NER is the bottleneck |
| LLM detection | 2–15s | GPU recommended; works on CPU |
| Regex fallback | < 20ms | Browser-only, no network |
| Overlay application | < 100ms | DOM manipulation |
| **End-to-end (Presidio)** | **300–900ms** | Fast enough for interactive use |
| **End-to-end (LLM)** | **3–16s** | Deeper analysis, more entity types |
| **Incremental re-scan** | **1–5ms** | Cached values, zero network |

---

## Technology Stack

| Component | Technology | Role |
|---|---|---|
| Browser Extension | Chrome Manifest V3 | Client-side UI and DOM access |
| API Server | Python FastAPI + Uvicorn | REST API with async support |
| NLP Engine | Microsoft Presidio + spaCy | Pattern + NER-based PII detection |
| LLM Runtime | Ollama + Llama 3.2 | Context-aware semantic detection |
| OCR | Tesseract + OpenCV | Image-based text extraction |
| Containerization | Docker + Docker Compose | One-command deployment |
| Auth | API key middleware | Production-ready access control |

---

## What We Learned

### 1. LLMs Are Powerful but Need Guardrails

LLMs detect PII that no regex or NER model can find — but they hallucinate character positions, wrap JSON in markdown, and sometimes return prose instead of structured data. Every LLM integration needs a robust parsing and validation layer.

### 2. The Observer Pattern Matters More Than the Detection Algorithm

On dynamic web apps, the biggest UX challenge isn't *detecting* PII — it's *keeping masks stable* while the DOM mutates underneath. We rewrote the MutationObserver integration three times before landing on the disconnect/reconnect + cached incremental scan approach.

### 3. Layered Fallback Is Non-Negotiable

In enterprise environments, not every machine will have Ollama installed, or even have the Python backend running. The three-layer fallback (LLM → Presidio → Regex) ensures the extension always provides value, even in degraded mode.

### 4. Local-First Is a Feature, Not a Limitation

When we tell enterprise security teams "zero data leaves the machine," the conversation changes completely. Local-first isn't a compromise — it's the strongest possible privacy guarantee.

---

## Results

| Metric | Value |
|---|---|
| Entity types detected (Presidio) | 17 |
| Entity types detected (LLM) | 25+ |
| Regex fallback patterns | 6 |
| End-to-end latency (Presidio) | < 1 second |
| Data sent to external servers | 0 bytes |
| PII persisted to disk | 0 bytes |
| Mask styles available | 3 |
| User-configurable PII toggles | 14 |
| Detection engines | 2 (switchable at runtime) |
| Docker deployment | Single `docker compose up` command |

---

## Try It

SafeShot AI is packaged as a standard Chrome extension with a Python backend:

```bash
# Start the AI service
cd ai-service && pip install -r requirements.txt
python -m spacy download en_core_web_sm
uvicorn main:app --host 0.0.0.0 --port 8000

# Optional: Enable LLM engine
ollama pull llama3.2

# Load extension in Chrome
# chrome://extensions/ → Developer Mode → Load Unpacked → select extension/
```

Or deploy with Docker:
```bash
docker compose up -d
```

---

## What's Next

- **Multi-language NLP** — spaCy models for German, French, Spanish, Hindi, Chinese
- **Video/meeting mode** — Real-time screen masking during screen shares
- **Presidio Anonymizer integration** — Replace PII with realistic synthetic data instead of visual masks
- **Enterprise deployment** — Central configuration server, managed Chrome extension distribution via group policy
- **Full-page scroll capture** — Stitch and mask entire scrollable pages

---

*SafeShot AI is local-first, open-architecture, and built on open-source foundations (Microsoft Presidio, spaCy, Ollama, Tesseract). It proves that enterprise-grade privacy protection doesn't require sending your data to the cloud.*

---

**Tags:** `#AI` `#Privacy` `#PII` `#NLP` `#Presidio` `#LLM` `#ChromeExtension` `#GDPR` `#spaCy` `#Ollama` `#ComputerVision` `#OCR` `#LocalFirst` `#DataProtection`
