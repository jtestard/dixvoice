"""The real Gradium client against a mocked HTTP transport (no key, no credits)."""

import asyncio
import base64
import json

import httpx
import numpy as np
import pytest

from audio_service.providers.base import ProviderError, ProviderUnavailable
from audio_service.providers.gradium import GradiumProvider


def ndjson(seconds=1.0, words=("Is", "anyone", "there?")):
    pcm = (0.2 * np.sin(np.arange(int(24000 * seconds)) / 10) * 32767).astype("<i2").tobytes()
    lines = [{"type": "audio", "audio": base64.b64encode(pcm[i:i + 3840]).decode()} for i in range(0, len(pcm), 3840)]
    lines += [{"type": "text", "text": w, "start_s": 0.1 + 0.3 * k, "stop_s": 0.4 + 0.3 * k} for k, w in enumerate(words)]
    return "\n".join(json.dumps(x) for x in lines) + "\n"


def make(handler, **kw):
    p = GradiumProvider("key", "https://api.test/api", "gradium-tts-beta", "default", 5, transport=httpx.MockTransport(handler), **kw)
    asyncio.run(p.start())
    return p


def credits_or(route):
    def handler(request: httpx.Request):
        if request.url.path.endswith("/usages/credits"):
            return httpx.Response(200, json={"remaining_credits": 1000})
        return route(request)
    return handler


def test_parses_audio_and_words():
    seen = {}

    def route(request):
        seen.update(json.loads(request.content))
        return httpx.Response(200, text=ndjson())

    p = make(credits_or(route))
    syn = asyncio.run(p.synthesize("Is anyone there?", "voice", 0.7, -1))
    assert syn.sample_rate == 24000 and abs(len(syn.pcm16) / 24000 - 1.0) < 0.01
    assert [w.text for w in syn.words] == ["Is", "anyone", "there?"]
    assert seen["output_format"] == "pcm_24000" and seen["only_audio"] is False
    assert json.loads(seen["json_config"]) == {"temp": 0.7, "padding_bonus": -1}
    assert p.credits_remaining == 1000


def test_revoked_key_is_unavailable():
    p = make(credits_or(lambda r: httpx.Response(500, text="error from server 1008: API key is revoked or expired")))
    with pytest.raises(ProviderUnavailable):
        asyncio.run(p.synthesize("hi", "voice", 0.7, 0))


def test_beta_error_falls_back_to_default_model():
    models = []

    def route(request):
        body = json.loads(request.content)
        models.append(body["model_name"])
        if body["model_name"] == "gradium-tts-beta":
            return httpx.Response(200, text=json.dumps({"type": "error", "message": "worker crashed"}) + "\n")
        return httpx.Response(200, text=ndjson())

    p = make(credits_or(route))
    syn = asyncio.run(p.synthesize("hi", "voice", 0.7, 0))
    assert models == ["gradium-tts-beta", "default"] and syn.model == "default"


def test_error_on_both_models_raises():
    p = make(credits_or(lambda r: httpx.Response(500, text="bad voice")))
    with pytest.raises(ProviderError):
        asyncio.run(p.synthesize("hi", "voice", 0.7, 0))


def test_no_key_means_unavailable():
    p = GradiumProvider("", "https://api.test/api", "m", "default", 5)
    asyncio.run(p.start())
    with pytest.raises(ProviderUnavailable):
        asyncio.run(p.synthesize("hi", "voice", 0.7, 0))
