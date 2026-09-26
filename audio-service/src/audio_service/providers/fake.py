"""Offline provider for development and tests: a voice-like buzz whose length follows the text (12.5 chars/s,
Gradium's documented average), with word timestamps. No key, no credits. Never use it for the jury."""

from __future__ import annotations

import asyncio
import time

import numpy as np

from ..audio import Word
from .base import Synthesis

SAMPLE_RATE = 24000
CHARS_PER_S = 12.5
LEAD_S, TAIL_S = 0.10, 0.15


class FakeProvider:
    name = "fake"

    def __init__(self, latency_ms: int = 0):
        self.latency_ms = latency_ms

    async def start(self) -> None:
        pass

    async def close(self) -> None:
        pass

    async def synthesize(self, text: str, voice_id: str, temp: float, padding_bonus: float) -> Synthesis:
        t0 = time.perf_counter()
        if self.latency_ms:
            await asyncio.sleep(self.latency_ms / 1000)
        rate = CHARS_PER_S * (1 - 0.075 * padding_bonus)  # negative padding = faster, as in Gradium
        pitch = 110 + (sum(map(ord, voice_id)) % 120)  # each voice sounds a bit different
        words, pos, parts = [], LEAD_S, [np.zeros(int(LEAD_S * SAMPLE_RATE), np.float32)]
        for w in text.split():
            d = (len(w) + 1) / rate
            t = np.arange(int(d * SAMPLE_RATE)) / SAMPLE_RATE
            env = np.sin(np.pi * np.clip(t / d, 0, 1)) ** 0.5
            voiced = sum(np.sin(2 * np.pi * pitch * k * t) / k for k in (1, 2, 3))
            parts.append((0.25 * env * voiced).astype(np.float32))
            words.append(Word(w, pos, pos + d))
            pos += d
        parts.append(np.zeros(int(TAIL_S * SAMPLE_RATE), np.float32))
        pcm = (np.concatenate(parts) * 32767).astype(np.int16)
        return Synthesis(pcm, SAMPLE_RATE, words, "fake", 1.0, (time.perf_counter() - t0) * 1000)

    def status(self) -> dict:
        return {"provider": self.name, "provider_state": "ok", "model_in_use": "fake"}


class OffProvider:
    """PROVIDER=off: generation disabled cleanly (every POST /audio answers 502 provider_unavailable)."""

    name = "off"

    async def start(self) -> None:
        pass

    async def close(self) -> None:
        pass

    async def synthesize(self, *args, **kwargs):
        from .base import ProviderUnavailable
        raise ProviderUnavailable("Generation is switched off (PROVIDER=off).")

    def status(self) -> dict:
        return {"provider": self.name, "provider_state": "down", "model_in_use": None}
