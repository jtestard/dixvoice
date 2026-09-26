import io

import soundfile as sf
from fastapi.testclient import TestClient

from audio_service.main import create_app


def post(client, text="Où est passé mon sandwich ?", emotion="espiègle"):
    return client.post("/audio", json={"text": text, "emotion": emotion})


def test_list_returns_library(client):
    r = client.get("/audio/list")
    assert r.status_code == 200
    assert len(r.json()) == 3
    assert r.headers["cache-control"] == "no-cache"


def test_list_etag_304(client):
    etag = client.get("/audio/list").headers["etag"]
    assert client.get("/audio/list", headers={"If-None-Match": etag}).status_code == 304
    post(client)
    assert client.get("/audio/list", headers={"If-None-Match": etag}).status_code == 200


def test_post_then_get_and_download(client):
    r = post(client)
    assert r.status_code == 201
    sound = r.json()
    assert r.headers["location"] == f"/audio/{sound['id']}"
    assert sound["text"] == "Où est passé mon sandwich ?" and sound["emotion"] == "espiègle"
    assert client.get(f"/audio/{sound['id']}").json() == sound
    mp3 = client.get(sound["clipUrl"].replace("http://testserver", ""))
    assert mp3.status_code == 200 and mp3.headers["content-type"] == "audio/mpeg"
    info = sf.info(io.BytesIO(mp3.content))
    assert info.frames / info.samplerate <= 2.0


def test_long_text_is_cut_to_two_seconds(client):
    sound = post(client, "This sentence is far too long to be spoken in two seconds by anyone at all", "angry").json()
    info = sf.info(io.BytesIO(client.get(sound["clipUrl"].replace("http://testserver", "")).content))
    assert info.frames / info.samplerate <= 2.0
    assert sound["text"].startswith("This sentence")  # text is returned as sent, even when the clip was cut


def test_unknown_and_malformed_ids_are_404(client):
    for bad in ("nope", "3f1c2b8e-9a4d-4e6f-8b21-5c7d9e0a1f34"):
        r = client.get(f"/audio/{bad}")
        assert r.status_code == 404 and r.json()["error"] == "not_found"
        assert r.headers["cache-control"] == "no-store"


def test_invalid_requests_are_400_not_422(client):
    cases = [
        {"text": "", "emotion": "x"},
        {"text": "hi"},
        {"text": "hi", "emotion": "x", "extra": 1},
        {"text": "x" * 101, "emotion": "x"},
        {"text": "hi", "emotion": "x" * 31},
    ]
    for body in cases:
        r = client.post("/audio", json=body)
        assert r.status_code == 400, body
        assert r.json()["error"] == "invalid_request"
    r = client.post("/audio", content=b"not json", headers={"Content-Type": "application/json"})
    assert r.status_code == 400


def test_text_errors(client):
    assert post(client, "J'ai 12 ans").json()["error"] == "text_has_digits"
    assert post(client, "!!! ???").json()["error"] == "text_empty"
    assert post(client, "you bitch", "calm").json()["error"] == "text_rejected"
    assert post(client, "hello", "fuck").json()["error"] == "text_rejected"


def test_duplicate_gets_a_new_id(client):
    a, b = post(client).json(), post(client).json()
    assert a["id"] != b["id"] and a["clipUrl"] != b["clipUrl"]


def test_provider_off_is_502(settings):
    settings.provider = "off"
    with TestClient(create_app(settings)) as c:
        r = post(c)
        assert r.status_code == 502 and r.json()["error"] == "provider_unavailable"
        assert c.get("/healthz").json()["generation_available"] is False


def test_generated_sounds_survive_a_restart(settings):
    with TestClient(create_app(settings)) as c:
        sound = post(c).json()
    with TestClient(create_app(settings)) as c:
        assert c.get(f"/audio/{sound['id']}").json() == sound
        assert sound["id"] in {s["id"] for s in c.get("/audio/list").json()}


def test_healthz(client):
    body = client.get("/healthz").json()
    assert body["status"] == "ok" and body["library"] == 3


def test_voice_id_is_used_when_given(client):
    sound = client.post("/audio", json={"text": "Trop tard !", "emotion": "angry", "voiceId": "YKeBw3OV1RgpdhLh"}).json()
    assert sound["voiceId"] == "YKeBw3OV1RgpdhLh"
    assert client.get(f"/audio/{sound['id']}").json()["voiceId"] == "YKeBw3OV1RgpdhLh"


def test_voice_id_chosen_from_emotion_when_absent(client):
    assert client.post("/audio", json={"text": "Trop tard !", "emotion": "angry"}).json()["voiceId"] == "25AzBFyp6svYnJsj"


def test_invalid_voice_id_is_400(client):
    for bad in ("", "a b", "x" * 65, "<script>"):
        r = client.post("/audio", json={"text": "Hi", "emotion": "calm", "voiceId": bad})
        assert r.status_code == 400 and r.json()["error"] == "invalid_request", bad


def test_unknown_voice_id_is_400(client):
    from audio_service.providers.base import UnknownVoice

    async def boom(*a, **k):
        raise UnknownVoice("Embeddings not found for nope")

    client.app.state.generator.provider.synthesize = boom
    r = client.post("/audio", json={"text": "Hi there", "emotion": "calm", "voiceId": "nope"})
    assert r.status_code == 400 and r.json()["error"] == "unknown_voice"
