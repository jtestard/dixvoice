"""Gradium TTS over REST (POST /post/speech/tts, NDJSON stream), on one kept-alive HTTP client.

Docs: https://docs.gradium.ai/guides/text-to-speech-rest (response modes), api-reference/endpoint/tts-post (errors:
HTTP 500 + plain text before the stream, {"type": "error"} lines inside it)."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time

import httpx
import numpy as np

from ..audio import Word
from .base import ProviderError, ProviderTimeout, ProviderUnavailable, Synthesis, UnknownVoice

log = logging.getLogger("audio_service.gradium")

SAMPLE_RATE = 24000
OUTPUT_FORMAT = "pcm_24000"
MAX_DECODE_S = 2.4  # we keep at most 2 s: stop decoding beyond this, but read the stream to the end
UNAVAILABLE_HINTS = ("revoked", "expired", "credit", "quota", "1008", "unauthorized", "forbidden")
STICKY_FAILURES = 3
STICKY_SECONDS = 30 * 60


def _classify(message: str, status: int | None = None) -> ProviderError:
    lowered = message.lower()
    if "embeddings not found" in lowered or ("voice" in lowered and "not found" in lowered):
        return UnknownVoice(message)  # measured 2026-09-26: HTTP 400 {"detail": "Embeddings not found for <id>, ..."}
    if status in (401, 402, 403) or any(h in lowered for h in UNAVAILABLE_HINTS):
        return ProviderUnavailable(message)
    return ProviderError(message)


class GradiumProvider:
    name = "gradium"

    def __init__(self, api_key: str, base_url: str, model: str, fallback_model: str, timeout_s: float,
                 transport: httpx.AsyncBaseTransport | None = None):
        self.transport = transport  # tests inject an httpx.MockTransport
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.fallback_model = fallback_model
        self.timeout_s = timeout_s
        self.client: httpx.AsyncClient | None = None
        self.state = "down"
        self.credits_remaining: int | None = None
        self.last_total_ms: float | None = None
        self._beta_failures = 0
        self._sticky_until = 0.0

    async def start(self) -> None:
        if not self.api_key:
            self.state = "out_of_credits"
            log.warning("GRADIUM_API_KEY is empty: generation unavailable")
            return
        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"x-api-key": self.api_key},
            # httpx closes idle connections after 5 s by default: keep them 2 minutes to avoid TCP+TLS per clip.
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=4, keepalive_expiry=120),
            timeout=httpx.Timeout(self.timeout_s),
            transport=self.transport,
        )
        await self.refresh_credits()

    async def close(self) -> None:
        if self.client:
            await self.client.aclose()

    async def refresh_credits(self) -> None:
        """Also opens (or keeps warm) a connection to Gradium. Never raises."""
        if not self.client:
            return
        try:
            r = await self.client.get("/usages/credits")
            if r.status_code == 200:
                self.credits_remaining = r.json().get("remaining_credits")
                self.state = "out_of_credits" if self.credits_remaining == 0 else "ok"
            else:
                self.state = "out_of_credits" if isinstance(_classify(r.text, r.status_code), ProviderUnavailable) else "degraded"
        except httpx.HTTPError as exc:
            log.warning("credits check failed: %s", exc)
            self.state = "down"

    def _model_to_use(self) -> str:
        return self.fallback_model if time.monotonic() < self._sticky_until else self.model

    async def synthesize(self, text: str, voice_id: str, temp: float, padding_bonus: float) -> Synthesis:
        if not self.client or self.state == "out_of_credits":
            raise ProviderUnavailable("Gradium is not available (no key or no credits).")
        model = self._model_to_use()
        try:
            result = await self._synthesize_once(text, voice_id, temp, padding_bonus, model)
        except (ProviderUnavailable, ProviderTimeout, UnknownVoice):
            raise
        except ProviderError as exc:
            if model == self.fallback_model:
                raise
            self._beta_failures += 1
            if self._beta_failures >= STICKY_FAILURES:
                self._sticky_until = time.monotonic() + STICKY_SECONDS
                log.warning("model %s failed %d times in a row: using %s for 30 min", model, self._beta_failures, self.fallback_model)
            log.warning("model %s failed (%s): retrying once with %s", model, exc, self.fallback_model)
            result = await self._synthesize_once(text, voice_id, temp, padding_bonus, self.fallback_model)
        else:
            if model == self.model:
                self._beta_failures = 0
        self.state = "ok"
        self.last_total_ms = result.total_ms
        return result

    async def _synthesize_once(self, text: str, voice_id: str, temp: float, padding_bonus: float, model: str) -> Synthesis:
        body = {
            "text": text,
            "voice_id": voice_id,
            "output_format": OUTPUT_FORMAT,
            "model_name": model,
            # Sent as a JSON string: the SDK does so and the API reference types it as a string.
            "json_config": json.dumps({"temp": temp, "padding_bonus": padding_bonus}),
            "only_audio": False,
        }
        try:
            async with asyncio.timeout(self.timeout_s):
                try:
                    return await self._stream(body, model)
                except httpx.ConnectError:
                    # The text never reached Gradium, so nothing was billed: one retry.
                    return await self._stream(body, model)
        except TimeoutError as exc:
            raise ProviderTimeout(f"Gradium took more than {self.timeout_s:g} s") from exc
        except httpx.HTTPError as exc:
            self.state = "degraded"
            raise ProviderError(f"Gradium request failed: {exc}") from exc

    async def _stream(self, body: dict, model: str) -> Synthesis:
        assert self.client is not None
        t0 = time.perf_counter()
        first_audio_ms = None
        chunks: list[bytes] = []
        decoded_bytes = 0
        max_bytes = int(MAX_DECODE_S * SAMPLE_RATE) * 2
        words: list[Word] = []
        async with self.client.stream("POST", "/post/speech/tts", json=body) as r:
            if r.status_code != 200:
                raise _classify((await r.aread()).decode("utf-8", "replace")[:300], r.status_code)
            async for line in r.aiter_lines():
                if not line.strip():
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    raise _classify(line[:300])
                kind = msg.get("type")
                if kind == "audio":
                    if first_audio_ms is None:
                        first_audio_ms = (time.perf_counter() - t0) * 1000
                    if decoded_bytes < max_bytes:
                        data = base64.b64decode(msg["audio"])
                        chunks.append(data)
                        decoded_bytes += len(data)
                elif kind == "text":
                    words.append(Word(msg.get("text", ""), float(msg.get("start_s", 0.0)), float(msg.get("stop_s", 0.0))))
                elif kind == "error":
                    raise _classify(str(msg.get("message", msg)))
        raw = b"".join(chunks)
        pcm = np.frombuffer(raw[: len(raw) // 2 * 2], dtype="<i2").copy()
        if len(pcm) == 0:
            raise ProviderError("Gradium returned no audio")
        return Synthesis(pcm, SAMPLE_RATE, words, model, first_audio_ms, (time.perf_counter() - t0) * 1000)

    def status(self) -> dict:
        return {
            "provider": self.name,
            "provider_state": self.state,
            "model_in_use": self._model_to_use(),
            "credits_remaining": self.credits_remaining,
            "last_total_ms": self.last_total_ms,
        }
