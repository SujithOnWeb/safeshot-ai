"""
main.py — SafeShot AI FastAPI Service (v2.0)

Entry point for the PII detection backend.
Supports TWO detection engines selectable per-request:
  • "presidio" (default) — Microsoft Presidio + spaCy NER
  • "llm" — Local LLM via Ollama for context-aware detection

Endpoints:
  GET  /health       → Service health check (includes engine availability)
  POST /detect-pii   → Detect PII entities in supplied text (engine selectable)
  POST /detect-image  → OCR + PII detection on uploaded screenshot image
  GET  /engines       → List available detection engines and their status

Run locally:
  uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import io
import logging
import os
from typing import Optional

from fastapi import FastAPI, File, UploadFile, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel

from pii_detector import PIIDetector, OCRPipeline
from llm_detector import LLMDetector
# ── Logging ─────────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("safeshot")

# ── Configuration from environment variables ─────────────────────────────────────
SAFESHOT_API_KEY = os.environ.get("SAFESHOT_API_KEY", "")       # empty = no auth required
ALLOWED_ORIGINS  = os.environ.get("SAFESHOT_ALLOWED_ORIGINS", "*")  # comma-separated or *
OLLAMA_BASE_URL  = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")

# ── API Key Authentication Middleware ────────────────────────────────────────────
class APIKeyMiddleware(BaseHTTPMiddleware):
    """
    If SAFESHOT_API_KEY env var is set, every request must include
    X-API-Key header matching that value. Health endpoint is exempt.
    """
    async def dispatch(self, request: Request, call_next):
        if not SAFESHOT_API_KEY:
            return await call_next(request)
        # Allow health check without auth (so monitoring tools work)
        if request.url.path in ("/health", "/docs", "/openapi.json"):
            return await call_next(request)
        api_key = request.headers.get("X-API-Key", "")
        if api_key != SAFESHOT_API_KEY:
            raise HTTPException(status_code=401, detail="Invalid or missing API key")
        return await call_next(request)

# ── FastAPI app ─────────────────────────────────────────────────────────────────
app = FastAPI(
    title="SafeShot AI — PII Detection Service",
    version="2.0.0",
    description="Detects PII using Microsoft Presidio + spaCy or a Local LLM (Ollama), with optional OCR pipeline.",
)

# Register API key middleware
app.add_middleware(APIKeyMiddleware)

# CORS: configurable via SAFESHOT_ALLOWED_ORIGINS env var
origins = [o.strip() for o in ALLOWED_ORIGINS.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Singletons ──────────────────────────────────────────────────────────────────
detector: Optional[PIIDetector] = None
llm_detector: Optional[LLMDetector] = None
ocr_pipeline: Optional[OCRPipeline] = None


@app.on_event("startup")
def startup_event():
    """Initialise detection engines and (optionally) OCR pipeline once at startup."""
    global detector, llm_detector, ocr_pipeline

    # 1. Presidio engine (always available)
    logger.info("Loading Presidio detector (Presidio + spaCy)…")
    detector = PIIDetector()
    logger.info("Presidio detector ready.")

    # 2. LLM engine (available if Ollama is running)
    try:
        llm_detector = LLMDetector(ollama_base=OLLAMA_BASE_URL)
        if llm_detector.is_available():
            logger.info("LLM detector ready (Ollama model: %s).", llm_detector.model)
        else:
            logger.warning(
                "Ollama not available — LLM engine disabled. "
                "Install Ollama and run: ollama pull llama3.2"
            )
    except Exception as exc:
        logger.warning("LLM detector init failed: %s", exc)
        llm_detector = None

    # 3. OCR pipeline (optional)
    try:
        ocr_pipeline = OCRPipeline(detector)
        logger.info("OCR pipeline ready (Tesseract + OpenCV).")
    except Exception as exc:
        logger.warning("OCR pipeline unavailable: %s — image endpoint will be disabled.", exc)
        ocr_pipeline = None


# ══════════════════════════════════════════════════════════════════════════════
#  REQUEST / RESPONSE MODELS
# ══════════════════════════════════════════════════════════════════════════════

class DetectRequest(BaseModel):
    """Request body for the /detect-pii endpoint."""
    text: str
    engine: str = "presidio"   # "presidio" | "llm"


class PIIEntity(BaseModel):
    """A single detected PII entity."""
    entity_type: str
    start: int
    end: int
    score: float
    value: str


class DetectResponse(BaseModel):
    """Response body for the /detect-pii endpoint."""
    entities: list[PIIEntity]


class OCREntity(BaseModel):
    """A PII entity detected via OCR, including bounding box."""
    entity_type: str
    value: str
    score: float
    bbox: dict  # { x, y, w, h }


class OCRResponse(BaseModel):
    """Response body for the /detect-image endpoint."""
    entities: list[OCREntity]


# ══════════════════════════════════════════════════════════════════════════════
#  ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/health")
def health():
    """Simple health check used by the extension popup."""
    llm_available = llm_detector is not None and llm_detector.is_available()
    return {
        "status": "ok",
        "service": "SafeShot AI PII Detector",
        "presidio": detector is not None,
        "llm": llm_available,
        "llm_model": llm_detector.model if llm_detector else None,
        "ocr": ocr_pipeline is not None,
    }


@app.get("/engines")
def engines():
    """List available detection engines and their readiness status."""
    llm_available = llm_detector is not None and llm_detector.is_available()
    return {
        "engines": [
            {
                "id": "presidio",
                "name": "Presidio + spaCy",
                "description": "Pattern-based + NER detection (17 entity types, fast)",
                "available": detector is not None,
            },
            {
                "id": "llm",
                "name": f"Local LLM ({llm_detector.model if llm_detector else 'N/A'})",
                "description": "Context-aware AI detection via Ollama (25+ entity types, deeper understanding)",
                "available": llm_available,
            },
        ],
        "default": "presidio",
    }


@app.post("/detect-pii", response_model=DetectResponse)
def detect_pii(req: DetectRequest):
    """
    Accept a block of text and return all PII entities found.

    Engine selection:
      • "presidio" (default) — Microsoft Presidio + spaCy NER
      • "llm" — Local LLM via Ollama (context-aware, deeper detection)
    """
    if not req.text or not req.text.strip():
        return DetectResponse(entities=[])

    engine = req.engine.lower().strip()
    logger.info("Detecting PII in %d chars [engine=%s]…", len(req.text), engine)

    results = []

    if engine == "llm":
        # ── LLM-based detection ─────────────────────────────────────────────
        if llm_detector is None or not llm_detector.is_available():
            logger.warning("LLM engine requested but unavailable — falling back to Presidio.")
            results = detector.detect(req.text)
        else:
            results = llm_detector.detect(req.text)
    else:
        # ── Presidio detection (default) ────────────────────────────────────
        results = detector.detect(req.text)

    logger.info("Found %d PII entities [engine=%s].", len(results), engine)

    entities = [
        PIIEntity(
            entity_type=r["entity_type"],
            start=r["start"],
            end=r["end"],
            score=round(r["score"], 4),
            value=r["value"],
        )
        for r in results
    ]

    return DetectResponse(entities=entities)


@app.post("/detect-image", response_model=OCRResponse)
async def detect_image(file: UploadFile = File(...)):
    """
    Accept a screenshot image, run OCR to extract text, detect PII,
    and return entities with bounding-box coordinates for masking.
    """
    if ocr_pipeline is None:
        return OCRResponse(entities=[])

    image_bytes = await file.read()
    logger.info("Received image (%d bytes) for OCR PII detection.", len(image_bytes))

    results = ocr_pipeline.process(image_bytes)

    entities = [
        OCREntity(
            entity_type=r["entity_type"],
            value=r["value"],
            score=round(r["score"], 4),
            bbox=r["bbox"],
        )
        for r in results
    ]

    logger.info("OCR pipeline found %d PII entities.", len(entities))
    return OCRResponse(entities=entities)


# ── Run directly ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
