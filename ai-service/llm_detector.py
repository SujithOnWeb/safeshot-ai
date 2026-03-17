"""
llm_detector.py — SafeShot AI LLM-based PII Detection Engine

Uses a local LLM (via Ollama) for context-aware PII detection.
This provides deeper semantic understanding compared to the pattern-based
Presidio engine — it can detect PII that requires contextual reasoning
(e.g., "my mother's maiden name is Parker").

Supports:
  • Ollama (default: http://localhost:11434)
  • Any model available via `ollama pull` (default: llama3.2)
  • Structured JSON output parsing
  • Automatic fallback to Presidio if Ollama is unavailable

Run Ollama locally:
  1. Install Ollama: https://ollama.ai/download
  2. Pull a model:   ollama pull llama3.2
  3. Start server:   ollama serve  (runs on :11434 by default)
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger("safeshot.llm")

# ── System prompt for PII extraction ───────────────────────────────────────────
SYSTEM_PROMPT = """\
You are a PII (Personally Identifiable Information) detection engine.
Your task is to analyze the given text and identify ALL PII entities.

You MUST respond ONLY with a valid JSON array. No explanation, no markdown.

Each element must be an object with these exact keys:
  - "entity_type": one of PERSON, EMAIL_ADDRESS, PHONE_NUMBER, CREDIT_CARD,
    US_SSN, AADHAAR_NUMBER, PAN_NUMBER, BANK_ACCOUNT, IP_ADDRESS, LOCATION,
    DATE_TIME, URL, IBAN_CODE, US_PASSPORT, US_DRIVER_LICENSE, NRP,
    MEDICAL_LICENSE, PASSWORD, ORGANIZATION, AGE, GENDER, NATIONALITY,
    MEDICAL_CONDITION, BIOMETRIC_ID, VEHICLE_NUMBER, PASSPORT_NUMBER
  - "value": the exact substring from the text that is PII
  - "score": confidence float between 0.0 and 1.0
  - "start": character offset (0-indexed) where the PII starts in the text
  - "end": character offset (exclusive) where the PII ends in the text

Also detect CONTEXTUAL PII that pattern-based systems miss, such as:
  - "my mother's maiden name is Parker" → PERSON
  - "I was born in Springfield" → LOCATION  
  - "I'm 34 years old" → AGE
  - "my password is hunter2" → PASSWORD
  - "employee ID E-4829" → BIOMETRIC_ID
  - "my car plate is ABC 1234" → VEHICLE_NUMBER

If no PII found, return an empty array: []

Respond with ONLY the JSON array, nothing else."""


# ══════════════════════════════════════════════════════════════════════════════
#  LLM PII DETECTOR
# ══════════════════════════════════════════════════════════════════════════════

class LLMDetector:
    """
    PII detection using a local LLM via Ollama's REST API.

    The LLM provides context-aware detection that can catch PII missed by
    pattern/NER-based systems (e.g., implied identities, contextual secrets).

    Usage:
        detector = LLMDetector()
        if detector.is_available():
            results = detector.detect("My SSN is 123-45-6789")
    """

    # Extended entity types — LLM can detect more categories than Presidio
    SUPPORTED_ENTITIES = [
        "PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD",
        "US_SSN", "AADHAAR_NUMBER", "PAN_NUMBER", "BANK_ACCOUNT",
        "IP_ADDRESS", "LOCATION", "DATE_TIME", "URL", "IBAN_CODE",
        "US_PASSPORT", "US_DRIVER_LICENSE", "NRP", "MEDICAL_LICENSE",
        # LLM-exclusive types (contextual PII)
        "PASSWORD", "ORGANIZATION", "AGE", "GENDER", "NATIONALITY",
        "MEDICAL_CONDITION", "BIOMETRIC_ID", "VEHICLE_NUMBER",
        "PASSPORT_NUMBER",
    ]

    def __init__(
        self,
        ollama_base: str = "http://localhost:11434",
        model: str = "llama3.2",
        timeout: float = 60.0,
        temperature: float = 0.1,
    ) -> None:
        self.ollama_base = ollama_base.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.temperature = temperature
        self._available: Optional[bool] = None
        self._client = httpx.Client(timeout=timeout)

        logger.info(
            "LLMDetector initialised — model=%s, endpoint=%s",
            self.model, self.ollama_base,
        )

    # ── Availability check ──────────────────────────────────────────────────

    def is_available(self) -> bool:
        """Check if Ollama is running and the model is available."""
        if self._available is not None:
            return self._available

        try:
            resp = self._client.get(f"{self.ollama_base}/api/tags")
            if resp.status_code == 200:
                data = resp.json()
                models = [m.get("name", "") for m in data.get("models", [])]
                # Check if our model (or a variant like "llama3.2:latest") is listed
                self._available = any(
                    self.model in m or m.startswith(self.model)
                    for m in models
                )
                if not self._available:
                    logger.warning(
                        "Ollama is running but model '%s' not found. "
                        "Available models: %s. Run: ollama pull %s",
                        self.model, models, self.model,
                    )
                else:
                    logger.info("Ollama model '%s' is available.", self.model)
            else:
                self._available = False
        except Exception as exc:
            logger.warning("Ollama not reachable at %s: %s", self.ollama_base, exc)
            self._available = False

        return self._available

    def refresh_availability(self) -> bool:
        """Force re-check of Ollama availability."""
        self._available = None
        return self.is_available()

    # ── Core detection ──────────────────────────────────────────────────────

    def detect(self, text: str, score_threshold: float = 0.3) -> List[Dict[str, Any]]:
        """
        Send text to the local LLM and parse PII entities from its response.

        Returns a list of dicts matching the Presidio-compatible format:
          [{ entity_type, start, end, score, value }, ...]
        """
        if not text or not text.strip():
            return []

        # For very long texts, chunk to stay within LLM context window
        if len(text) > 8000:
            return self._detect_chunked(text, score_threshold)

        raw_response = self._call_ollama(text)
        if raw_response is None:
            return []

        entities = self._parse_response(raw_response, text)

        # Filter by score threshold
        entities = [e for e in entities if e["score"] >= score_threshold]

        # Validate and fix character offsets against actual text
        entities = self._validate_offsets(entities, text)

        # De-duplicate overlapping spans
        entities = self._merge_overlapping(entities)

        return entities

    # ── Ollama API call ─────────────────────────────────────────────────────

    def _call_ollama(self, text: str) -> Optional[str]:
        """Call the Ollama generate API and return the raw response text."""
        payload = {
            "model": self.model,
            "prompt": f"Analyze this text for PII:\n\n{text}",
            "system": SYSTEM_PROMPT,
            "stream": False,
            "options": {
                "temperature": self.temperature,
                "num_predict": 4096,
            },
        }

        try:
            start = time.time()
            resp = self._client.post(
                f"{self.ollama_base}/api/generate",
                json=payload,
            )
            elapsed = time.time() - start
            logger.info("LLM response in %.1fs (model=%s)", elapsed, self.model)

            if resp.status_code != 200:
                logger.error("Ollama returned %d: %s", resp.status_code, resp.text[:200])
                return None

            data = resp.json()
            return data.get("response", "")

        except httpx.TimeoutException:
            logger.error("Ollama request timed out after %.0fs.", self.timeout)
            return None
        except Exception as exc:
            logger.error("Ollama request failed: %s", exc)
            return None

    # ── Response parsing ────────────────────────────────────────────────────

    def _parse_response(self, raw: str, original_text: str) -> List[Dict[str, Any]]:
        """
        Parse the LLM's JSON output into a list of entity dicts.
        Handles common LLM quirks: markdown code fences, trailing commas, etc.
        """
        # Strip markdown code fences if present
        cleaned = raw.strip()
        cleaned = re.sub(r'^```(?:json)?\s*', '', cleaned)
        cleaned = re.sub(r'\s*```$', '', cleaned)
        cleaned = cleaned.strip()

        # Try direct JSON parse
        try:
            parsed = json.loads(cleaned)
            if isinstance(parsed, list):
                return self._normalize_entities(parsed, original_text)
            elif isinstance(parsed, dict) and "entities" in parsed:
                return self._normalize_entities(parsed["entities"], original_text)
        except json.JSONDecodeError:
            pass

        # Try to extract JSON array from the response using regex
        match = re.search(r'\[.*\]', cleaned, re.DOTALL)
        if match:
            try:
                # Fix trailing commas (common LLM mistake)
                json_str = re.sub(r',\s*([}\]])', r'\1', match.group())
                parsed = json.loads(json_str)
                if isinstance(parsed, list):
                    return self._normalize_entities(parsed, original_text)
            except json.JSONDecodeError:
                pass

        logger.warning("Failed to parse LLM response as JSON: %s", raw[:200])
        return []

    def _normalize_entities(
        self, entities: List[dict], original_text: str
    ) -> List[Dict[str, Any]]:
        """Normalize entity dicts to a consistent schema."""
        normalized = []
        for e in entities:
            if not isinstance(e, dict):
                continue

            entity_type = e.get("entity_type", e.get("type", "UNKNOWN"))
            value = e.get("value", e.get("text", ""))
            score = float(e.get("score", e.get("confidence", 0.5)))
            start = e.get("start", -1)
            end = e.get("end", -1)

            if not value:
                continue

            # Clamp score to [0, 1]
            score = max(0.0, min(1.0, score))

            normalized.append({
                "entity_type": entity_type,
                "value": value,
                "score": score,
                "start": start,
                "end": end,
            })

        return normalized

    # ── Offset validation ───────────────────────────────────────────────────

    def _validate_offsets(
        self, entities: List[Dict[str, Any]], text: str
    ) -> List[Dict[str, Any]]:
        """
        LLMs often hallucinate character offsets.
        Verify each entity's start/end against the actual text; fix if needed.
        """
        validated = []
        for e in entities:
            value = e["value"]
            start = e["start"]
            end = e["end"]

            # Check if the reported offsets actually match
            if (
                0 <= start < len(text)
                and 0 < end <= len(text)
                and text[start:end] == value
            ):
                validated.append(e)
                continue

            # Offsets are wrong — try to find the value in the text
            idx = text.find(value)
            if idx >= 0:
                e["start"] = idx
                e["end"] = idx + len(value)
                validated.append(e)
            else:
                # Case-insensitive search
                idx = text.lower().find(value.lower())
                if idx >= 0:
                    e["value"] = text[idx : idx + len(value)]
                    e["start"] = idx
                    e["end"] = idx + len(value)
                    validated.append(e)
                else:
                    logger.debug(
                        "LLM entity '%s' not found in text — dropping.", value
                    )

        return validated

    # ── De-duplication ──────────────────────────────────────────────────────

    @staticmethod
    def _merge_overlapping(entities: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Remove overlapping detections, keeping the one with the higher score."""
        if not entities:
            return entities

        sorted_ents = sorted(entities, key=lambda e: (e["start"], -e["score"]))
        merged = [sorted_ents[0]]

        for current in sorted_ents[1:]:
            prev = merged[-1]
            if current["start"] < prev["end"]:
                if current["score"] > prev["score"]:
                    merged[-1] = current
            else:
                merged.append(current)

        return merged

    # ── Chunked detection for long texts ────────────────────────────────────

    def _detect_chunked(
        self, text: str, score_threshold: float, chunk_size: int = 6000, overlap: int = 500
    ) -> List[Dict[str, Any]]:
        """Split long text into overlapping chunks and detect PII in each."""
        all_entities: List[Dict[str, Any]] = []
        pos = 0

        while pos < len(text):
            end = min(pos + chunk_size, len(text))
            chunk = text[pos:end]

            raw = self._call_ollama(chunk)
            if raw:
                entities = self._parse_response(raw, chunk)
                entities = [e for e in entities if e["score"] >= score_threshold]
                entities = self._validate_offsets(entities, chunk)

                # Adjust offsets to account for chunk position in full text
                for e in entities:
                    e["start"] += pos
                    e["end"] += pos

                all_entities.extend(entities)

            pos += chunk_size - overlap  # Overlap to catch PII at boundaries

        return self._merge_overlapping(all_entities)

    # ── Cleanup ─────────────────────────────────────────────────────────────

    def close(self):
        """Close the HTTP client."""
        self._client.close()

    def __del__(self):
        try:
            self._client.close()
        except Exception:
            pass
