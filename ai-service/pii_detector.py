"""
pii_detector.py — SafeShot AI PII Detection Engine

Two core components:
  1. PIIDetector  — text-based PII detection using Microsoft Presidio + spaCy
  2. OCRPipeline  — image → OCR text extraction (Tesseract) → PII detection

Presidio supports 30+ entity types out of the box.  We configure it to detect
the most common PII categories and add custom recognisers for region-specific
IDs (Aadhaar, PAN, etc.).
"""

from __future__ import annotations

import io
import logging
import re
from typing import List, Dict, Any

import numpy as np

# ── Presidio imports ────────────────────────────────────────────────────────────
from presidio_analyzer import AnalyzerEngine, PatternRecognizer, Pattern
from presidio_analyzer.nlp_engine import NlpEngineProvider

logger = logging.getLogger("safeshot.detector")

# ══════════════════════════════════════════════════════════════════════════════
#  CUSTOM RECOGNISERS — extend Presidio with region-specific patterns
# ══════════════════════════════════════════════════════════════════════════════

def _build_aadhaar_recognizer() -> PatternRecognizer:
    """Indian Aadhaar number: 12 digits in groups of 4."""
    return PatternRecognizer(
        supported_entity="AADHAAR_NUMBER",
        name="AadhaarRecognizer",
        patterns=[
            Pattern(
                name="aadhaar_pattern",
                regex=r"\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b",
                score=0.75,
            )
        ],
        supported_language="en",
    )


def _build_pan_recognizer() -> PatternRecognizer:
    """Indian PAN card: 5 letters + 4 digits + 1 letter, e.g. ABCDE1234F."""
    return PatternRecognizer(
        supported_entity="PAN_NUMBER",
        name="PANRecognizer",
        patterns=[
            Pattern(
                name="pan_pattern",
                regex=r"\b[A-Z]{5}\d{4}[A-Z]\b",
                score=0.85,
            )
        ],
        supported_language="en",
    )


def _build_bank_account_recognizer() -> PatternRecognizer:
    """Generic bank account number: 9–18 digits."""
    return PatternRecognizer(
        supported_entity="BANK_ACCOUNT",
        name="BankAccountRecognizer",
        patterns=[
            Pattern(
                name="bank_acct_pattern",
                regex=r"\b\d{9,18}\b",
                score=0.4,  # Low confidence — very broad pattern
            )
        ],
        supported_language="en",
    )


def _build_phone_recognizer() -> PatternRecognizer:
    """Broad phone number patterns (US, India, international)."""
    return PatternRecognizer(
        supported_entity="PHONE_NUMBER",
        name="CustomPhoneRecognizer",
        patterns=[
            Pattern(
                name="phone_intl",
                regex=r"(\+?\d{1,3}[\s\-]?)(\(?\d{2,4}\)?[\s\-]?)?\d{3,4}[\s\-]?\d{4}",
                score=0.7,
            ),
            Pattern(
                name="phone_us",
                regex=r"\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4}",
                score=0.65,
            ),
        ],
        supported_language="en",
    )


# ══════════════════════════════════════════════════════════════════════════════
#  PII DETECTOR — text based
# ══════════════════════════════════════════════════════════════════════════════

class PIIDetector:
    """
    Wraps Microsoft Presidio AnalyzerEngine with custom recognisers.

    Usage:
        detector = PIIDetector()
        results = detector.detect("Email me at john@example.com")
    """

    # Entity types we care about (Presidio built-ins + our custom ones)
    ENTITY_TYPES = [
        "PERSON",
        "EMAIL_ADDRESS",
        "PHONE_NUMBER",
        "CREDIT_CARD",
        "IBAN_CODE",
        "US_SSN",
        "US_PASSPORT",
        "US_DRIVER_LICENSE",
        "IP_ADDRESS",
        "DATE_TIME",
        "LOCATION",
        "NRP",                # Nationality, Religion, Political group
        "MEDICAL_LICENSE",
        "URL",
        # Custom
        "AADHAAR_NUMBER",
        "PAN_NUMBER",
        "BANK_ACCOUNT",
    ]

    def __init__(self, language: str = "en") -> None:
        self.language = language

        # Build the NLP engine (spaCy)
        provider = NlpEngineProvider(nlp_configuration={
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
        })
        nlp_engine = provider.create_engine()

        # Create Presidio analyzer
        self.analyzer = AnalyzerEngine(
            nlp_engine=nlp_engine,
            supported_languages=["en"],
        )

        # Register custom recognisers
        self.analyzer.registry.add_recognizer(_build_aadhaar_recognizer())
        self.analyzer.registry.add_recognizer(_build_pan_recognizer())
        self.analyzer.registry.add_recognizer(_build_bank_account_recognizer())
        self.analyzer.registry.add_recognizer(_build_phone_recognizer())

        logger.info(
            "PIIDetector initialised — %d recognisers loaded.",
            len(self.analyzer.registry.recognizers),
        )

    def detect(self, text: str, score_threshold: float = 0.35) -> List[Dict[str, Any]]:
        """
        Analyse *text* and return a list of detected PII entities.

        Each result dict has keys:
          entity_type, start, end, score, value
        """
        raw_results = self.analyzer.analyze(
            text=text,
            entities=self.ENTITY_TYPES,
            language=self.language,
            score_threshold=score_threshold,
        )

        # De-duplicate overlapping spans — keep highest score
        merged = self._merge_overlapping(raw_results)

        return [
            {
                "entity_type": r.entity_type,
                "start": r.start,
                "end": r.end,
                "score": r.score,
                "value": text[r.start : r.end],
            }
            for r in merged
        ]

    @staticmethod
    def _merge_overlapping(results):
        """Remove overlapping detections, keeping the one with the higher score."""
        if not results:
            return results

        # Sort by start position, then by score descending
        sorted_results = sorted(results, key=lambda r: (r.start, -r.score))
        merged = [sorted_results[0]]

        for current in sorted_results[1:]:
            prev = merged[-1]
            # If current overlaps with previous, keep the higher-scoring one
            if current.start < prev.end:
                if current.score > prev.score:
                    merged[-1] = current
            else:
                merged.append(current)

        return merged


# ══════════════════════════════════════════════════════════════════════════════
#  OCR PIPELINE — image → text → PII detection with bounding boxes
# ══════════════════════════════════════════════════════════════════════════════

class OCRPipeline:
    """
    Processes a screenshot image:
      1. Decode image using OpenCV
      2. Run Tesseract OCR to extract text + word bounding boxes
      3. Detect PII in the extracted text
      4. Map PII spans back to bounding boxes

    Requires: opencv-python, pytesseract, Tesseract-OCR installed on host.
    """

    def __init__(self, detector: PIIDetector) -> None:
        # Import here so the rest of the service works even without OCR deps
        try:
            import cv2
            import pytesseract
            self.cv2 = cv2
            self.pytesseract = pytesseract
        except ImportError as exc:
            raise RuntimeError(
                "OCR dependencies not installed (opencv-python, pytesseract). "
                "Install them or disable the OCR endpoint."
            ) from exc

        self.detector = detector
        logger.info("OCRPipeline initialised.")

    def process(self, image_bytes: bytes) -> List[Dict[str, Any]]:
        """Run the full OCR → PII pipeline on raw image bytes."""

        # 1. Decode image
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        img = self.cv2.imdecode(arr, self.cv2.IMREAD_COLOR)
        if img is None:
            logger.error("Failed to decode image.")
            return []

        # 2. Pre-process for better OCR accuracy
        gray = self.cv2.cvtColor(img, self.cv2.COLOR_BGR2GRAY)
        gray = self.cv2.threshold(gray, 0, 255, self.cv2.THRESH_BINARY | self.cv2.THRESH_OTSU)[1]

        # 3. Run Tesseract OCR — get word-level data
        ocr_data = self.pytesseract.image_to_data(gray, output_type=self.pytesseract.Output.DICT)

        # 4. Build a full text string and a mapping from char offset → bbox
        words = []
        char_to_bbox = {}
        offset = 0
        for i, word in enumerate(ocr_data["text"]):
            word = word.strip()
            if not word:
                continue
            bbox = {
                "x": ocr_data["left"][i],
                "y": ocr_data["top"][i],
                "w": ocr_data["width"][i],
                "h": ocr_data["height"][i],
            }
            start = offset
            end = offset + len(word)
            for c in range(start, end):
                char_to_bbox[c] = bbox
            words.append(word)
            offset = end + 1  # +1 for space separator

        full_text = " ".join(words)

        # 5. Detect PII in the concatenated text
        pii_results = self.detector.detect(full_text)

        # 6. Map PII spans to bounding boxes (union of word bboxes)
        entities = []
        for r in pii_results:
            bboxes = []
            for c in range(r["start"], r["end"]):
                if c in char_to_bbox:
                    bboxes.append(char_to_bbox[c])

            if bboxes:
                # Compute the union bounding box
                min_x = min(b["x"] for b in bboxes)
                min_y = min(b["y"] for b in bboxes)
                max_x = max(b["x"] + b["w"] for b in bboxes)
                max_y = max(b["y"] + b["h"] for b in bboxes)
                union_bbox = {
                    "x": min_x,
                    "y": min_y,
                    "w": max_x - min_x,
                    "h": max_y - min_y,
                }
            else:
                union_bbox = {"x": 0, "y": 0, "w": 0, "h": 0}

            entities.append({
                "entity_type": r["entity_type"],
                "value": r["value"],
                "score": r["score"],
                "bbox": union_bbox,
            })

        return entities
