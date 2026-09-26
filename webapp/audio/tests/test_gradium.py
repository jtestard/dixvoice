"""The real Gradium client against a mocked HTTP transport (no key, no credits)."""

import asyncio
import base64
import json

import httpx
import numpy as np
import pytest

from audio_service.providers.base import ProviderError, ProviderUnavailable, UnknownVoice
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


def test_unknown_voice_is_not_retried():
    calls = []

    def route(request):
        calls.append(1)
        return httpx.Response(400, json={"detail": "Embeddings not found for nope, 7e9db3ce@5 (7e9db3ce@5)"})

    p = make(credits_or(route))
    with pytest.raises(UnknownVoice):
        asyncio.run(p.synthesize("hi", "nope", 0.7, 0))
    assert len(calls) == 1


def speech_then_silence_stream(segments, words, early_words):
    """segments: list of (seconds, loud?). Words in early_words are sent right after the first audio chunk (ahead
    of the audio, as Gradium does); the other words are sent at the very end."""
    sr = 24000
    pcm = np.concatenate([
        (0.3 * np.sin(np.arange(int(sr * d)) / 5) if loud else np.zeros(int(sr * d))) for d, loud in segments
    ])
    raw = (pcm * 32767).astype("<i2").tobytes()
    chunks = [raw[i:i + 3840] for i in range(0, len(raw), 3840)]
    lines = []
    for k, c in enumerate(chunks):
        lines.append({"type": "audio", "audio": base64.b64encode(c).decode()})
        if k == 0:
            lines += [{"type": "text", "text": w, "start_s": a, "stop_s": b} for w, a, b in words[:early_words]]
    lines += [{"type": "text", "text": w, "start_s": a, "stop_s": b} for w, a, b in words[early_words:]]
    lines.append({"type": "end_of_stream"})
    return "\n".join(json.dumps(x) for x in lines) + "\n", len(pcm) / sr


def test_early_stop_waits_for_the_last_word_after_a_pause():
    # "Great. Just great.": voice, 0.6 s pause, last word, then 1 s of trailing silence.
    body, full = speech_then_silence_stream(
        [(0.5, True), (0.6, False), (0.3, True), (1.0, False)],
        [("Great.", 0.0, 0.5), ("Just", 0.5, 1.1), ("great.", 1.1, 1.4)], early_words=2)
    p = make(credits_or(lambda r: httpx.Response(200, text=body)))
    syn = asyncio.run(p.synthesize("Great. Just great.", "voice", 0.7, 0))
    kept = len(syn.pcm16) / 24000
    assert syn.early_stop and 1.6 <= kept < full - 0.3  # the last word is kept, most of the trailing silence is not


def test_no_early_stop_when_disabled_or_last_word_unheard():
    body, full = speech_then_silence_stream(
        [(0.5, True), (1.5, False)], [("One", 0.0, 0.5), ("two", 0.5, 1.0), ("three", 1.0, 1.5)], early_words=0)
    p = make(credits_or(lambda r: httpx.Response(200, text=body)))
    syn = asyncio.run(p.synthesize("One two three", "voice", 0.7, 0))
    assert not syn.early_stop  # only 0 of 3 words stamped: never stop early

    body, full = speech_then_silence_stream([(0.4, True), (1.2, False)], [("Behold!", 0.0, 0.4)], early_words=0)
    p = make(credits_or(lambda r: httpx.Response(200, text=body)), early_stop_s=0)
    syn = asyncio.run(p.synthesize("Behold!", "voice", 0.7, 0))
    assert not syn.early_stop and abs(len(syn.pcm16) / 24000 - full) < 0.01
