import json
import uuid
import warnings
from pathlib import Path

import numpy as np
import pytest

warnings.filterwarnings("ignore", category=DeprecationWarning)

from fastapi.testclient import TestClient  # noqa: E402

from audio_service import audio  # noqa: E402
from audio_service.main import create_app  # noqa: E402
from audio_service.settings import PACKAGE_ROOT, Settings  # noqa: E402

SPEC_DIR = PACKAGE_ROOT.parents[1] / "spec"  # webapp/audio -> repository root


def make_library(tmp_path: Path, n: int = 3) -> Path:
    """A small library of fake speech clips, with the same encoder as generated clips."""
    lib = tmp_path / "library"
    (lib / "clips").mkdir(parents=True)
    entries = []
    for i in range(n):
        clip_id = str(uuid.uuid4())
        t = np.arange(int(24000 * 1.5)) / 24000
        x = (0.2 * np.sin(2 * np.pi * (150 + 20 * i) * t)).astype(np.float32)
        (lib / "clips" / f"{clip_id}.mp3").write_bytes(audio.encode_mp3(audio.fades(audio.level(x), 24000), 24000))
        entries.append({"id": clip_id, "file": f"clips/{clip_id}.mp3", "text": f"Réplique {i}", "emotion": "joyful",
                        "voice_id": "YhIHaAfQ0cQPDV9R", "deal": True, "enabled": True})
    (lib / "manifest.json").write_text(json.dumps(entries), encoding="utf-8")
    return lib


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        provider="fake",
        local_cdn_dir=tmp_path / "cdn",
        data_dir=tmp_path / "data",
        cdn_public_url="http://testserver/cdn",
        library_dir=make_library(tmp_path),
        serve_local_cdn=True,
    )


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as c:
        yield c
