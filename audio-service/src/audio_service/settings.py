"""Configuration read from environment variables (see README for the full table)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[2]  # audio-service/


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


@dataclass
class Settings:
    host: str = field(default_factory=lambda: _env("HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: int(_env("PORT", "8080")))

    # Speech provider: "gradium" (production), "fake" (dev and tests), "off" (generation disabled).
    provider: str = field(default_factory=lambda: _env("PROVIDER", "fake"))
    gradium_api_key: str = field(default_factory=lambda: _env("GRADIUM_API_KEY", ""))
    gradium_base_url: str = field(default_factory=lambda: _env("GRADIUM_BASE_URL", "https://api.gradium.ai/api"))
    gradium_model: str = field(default_factory=lambda: _env("GRADIUM_MODEL", "gradium-tts-beta"))
    gradium_fallback_model: str = field(default_factory=lambda: _env("GRADIUM_FALLBACK_MODEL", "default"))
    provider_timeout_s: float = field(default_factory=lambda: float(_env("PROVIDER_TIMEOUT_S", "5")))
    fake_latency_ms: int = field(default_factory=lambda: int(_env("FAKE_LATENCY_MS", "0")))

    # Storage of the mp3 files (public, behind the CDN) and of the generated objects (private).
    storage: str = field(default_factory=lambda: _env("STORAGE", "local"))  # "local" or "s3"
    s3_bucket: str = field(default_factory=lambda: _env("S3_BUCKET", "dixvoice-clips"))
    aws_region: str = field(default_factory=lambda: _env("AWS_REGION", "eu-west-1"))
    local_cdn_dir: Path = field(default_factory=lambda: Path(_env("LOCAL_CDN_DIR", "/tmp/dixvoice-cdn")))
    data_dir: Path = field(default_factory=lambda: Path(_env("DATA_DIR", "/tmp/dixvoice-data")))
    cdn_public_url: str = field(default_factory=lambda: _env("CDN_PUBLIC_URL", "http://localhost:8080/cdn"))
    # Dev only: serve LOCAL_CDN_DIR under /cdn so clipUrl works without a real CDN.
    serve_local_cdn: bool = field(default_factory=lambda: _env("SERVE_LOCAL_CDN", "1") == "1")

    config_dir: Path = field(default_factory=lambda: Path(_env("CONFIG_DIR", str(PACKAGE_ROOT / "config"))))
    library_dir: Path = field(default_factory=lambda: Path(_env("LIBRARY_DIR", str(PACKAGE_ROOT / "library"))))

    max_chars: int = field(default_factory=lambda: int(_env("MAX_CHARS", "100")))
    max_concurrency: int = field(default_factory=lambda: int(_env("MAX_CONCURRENCY", "4")))
    queue_timeout_s: float = field(default_factory=lambda: float(_env("QUEUE_TIMEOUT_S", "2")))
    daily_char_budget: int = field(default_factory=lambda: int(_env("DAILY_CHAR_BUDGET", "50000")))
    max_clip_s: float = 2.0

    def clip_url(self, clip_id: str) -> str:
        return f"{self.cdn_public_url.rstrip('/')}/audio/{clip_id}.mp3"
