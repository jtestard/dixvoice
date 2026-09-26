"""A generated sound must not be distinguishable from a library sound (README, spec/)."""

import io

import soundfile as sf

from audio_service.models import UUID4_RE


def test_ids_are_uuid4_and_list_is_sorted(client):
    client.post("/audio", json={"text": "Bonjour", "emotion": "joyful"})
    ids = [s["id"] for s in client.get("/audio/list").json()]
    assert all(UUID4_RE.match(i) for i in ids)
    assert ids == sorted(ids)


def test_generated_and_library_look_the_same(client, settings):
    created = client.post("/audio", json={"text": "Bonjour", "emotion": "joyful"}).json()
    items = client.get("/audio/list").json()
    library = next(s for s in items if s["id"] != created["id"])
    assert set(created) == set(library)
    assert created["clipUrl"].rsplit("/", 1)[0] == library["clipUrl"].rsplit("/", 1)[0]

    def fetch(sound):
        return client.get(sound["clipUrl"].replace("http://testserver", ""))

    a, b = fetch(created), fetch(library)
    for header in ("content-type", "last-modified"):
        assert a.headers.get(header) == b.headers.get(header), header
    ia, ib = sf.info(io.BytesIO(a.content)), sf.info(io.BytesIO(b.content))
    assert (ia.samplerate, ia.channels, ia.format) == (ib.samplerate, ib.channels, ib.format)
    assert not a.content.startswith(b"ID3") and not b.content.startswith(b"ID3")
