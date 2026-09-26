"""Common interface of the speech providers (Gradium, fake)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import numpy as np

from ..audio import Word


class ProviderError(Exception):
    """Generation failed (502 provider_error)."""


class ProviderTimeout(ProviderError):
    """Generation took longer than PROVIDER_TIMEOUT_S (502 provider_timeout)."""


class UnknownVoice(ProviderError):
    """Gradium does not know the voice id (400 unknown_voice when the caller chose it)."""


class ProviderUnavailable(ProviderError):
    """No key, revoked key, no credits, or provider switched off (502 provider_unavailable)."""


@dataclass
class Synthesis:
    pcm16: np.ndarray
    sample_rate: int
    words: list[Word] = field(default_factory=list)
    model: str = ""
    first_audio_ms: float | None = None
    total_ms: float = 0.0


class Provider(Protocol):
    name: str

    async def start(self) -> None: ...

    async def close(self) -> None: ...

    async def synthesize(self, text: str, voice_id: str, temp: float, padding_bonus: float) -> Synthesis: ...

    def status(self) -> dict: ...
