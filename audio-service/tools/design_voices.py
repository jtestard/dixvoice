"""Prototype written during planning, never run against the real API: try it on one voice first.

Pre-build character voices with Gradium Voice Design (run once, before the demo).

Flow (docs: https://docs.gradium.ai/guides/voices/voice-design.md):
  1. POST /voice-generator/generate  {prompt<=500, language, n_samples 1..5, json_config{cfg_scale}}
  2. GET  /voice-generator/embeddings?embedding_id=...   poll until ready (3 candidates ~3-5 s)
  3. POST /post/speech/tts  voice_id=<vox_emb_...>, text<=100 chars, REST only  -> audition WAVs
  4. POST /voices/from-embedding {voxium_embedding_id, name, description} -> permanent uid
     (free, uses one custom-voice slot; 409 when the allowance is reached)

Usage (stdlib only, Python >= 3.9):
    export GRADIUM_API_KEY=...
    python design_voices.py generate characters.json       # writes design_out/candidates.json + WAVs
    # listen to design_out/*.wav, then keep one candidate per character:
    python design_voices.py convert pirate_en=vox_emb_xxx grumpy_fr=vox_emb_yyy
    # -> design_out/voices.json  {tonality: {voice_id, language, ...}} to copy into the service config

characters.json example:
  [{"id": "pirate_en", "language": "en", "n": 3, "cfg_scale": 8.0,
    "line": "Arr, who stole my treasure?!",
    "prompt": "A gruff Bristolian English male pirate voice, 45 to 60, for game and character narration: ..."}]
Voice Design generation is billed per sample (SDK docstring; amount not documented) and each
audition is billed as normal TTS (1 credit per character).
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("GRADIUM_BASE_URL", "https://api.gradium.ai/api")
KEY = os.environ.get("GRADIUM_API_KEY")
MODEL = os.environ.get("GRADIUM_MODEL", "gradium-tts-beta")  # audition with the model you will ship
OUT = "design_out"


def call(method, path, body=None, raw=False):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"x-api-key": KEY, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {e.read()[:300]!r}") from None
    return data if raw else json.loads(data or b"null")


def generate(chars):
    os.makedirs(OUT, exist_ok=True)
    result = {}
    for c in chars:
        body = {"prompt": c["prompt"], "language": c["language"], "n_samples": c.get("n", 3)}
        if "cfg_scale" in c:
            body["json_config"] = {"cfg_scale": c["cfg_scale"]}  # the ONLY allowed key
        ids = [e["embedding_id"] for e in call("POST", "/voice-generator/generate", body)["embeddings"]]
        t0 = time.monotonic()
        pending = set(ids)
        while pending:  # unknown key / out-of-range value => never ready: bound the loop
            for i in sorted(pending):
                found = call("GET", f"/voice-generator/embeddings?embedding_id={i}")["embeddings"]
                if found and found[0]["ready"]:
                    pending.discard(i)
            if pending:
                if time.monotonic() - t0 > 120:
                    raise TimeoutError(f"{c['id']}: candidates not ready {sorted(pending)}")
                time.sleep(1.0)
        print(f"{c['id']}: {len(ids)} candidates ready in {time.monotonic() - t0:.1f}s")
        for k, i in enumerate(ids):
            wav = call("POST", "/post/speech/tts", {"text": c["line"][:100], "voice_id": i, "model_name": MODEL,
                                                    "output_format": "wav", "only_audio": True}, raw=True)
            with open(os.path.join(OUT, f"{c['id']}_{k}_{i}.wav"), "wb") as f:
                f.write(wav)
        result[c["id"]] = {"language": c["language"], "prompt": c["prompt"], "candidates": ids}
    path = os.path.join(OUT, "candidates.json")
    old = json.load(open(path)) if os.path.exists(path) else {}
    old.update(result)
    json.dump(old, open(path, "w"), indent=2, ensure_ascii=False)
    print("wrote", path)


def convert(pairs):
    cands = json.load(open(os.path.join(OUT, "candidates.json")))
    path = os.path.join(OUT, "voices.json")
    voices = json.load(open(path)) if os.path.exists(path) else {}
    for p in pairs:
        tid, emb = p.split("=", 1)
        v = call("POST", "/voices/from-embedding", {"voxium_embedding_id": emb, "name": f"dixvoice-{tid}",
                                                    "description": cands[tid]["prompt"][:200]})
        voices[tid] = {"voice_id": v["uid"], "language": cands[tid]["language"], "source": "voice-design",
                       "embedding_id": emb}
        print(tid, "->", v["uid"])
    json.dump(voices, open(path, "w"), indent=2, ensure_ascii=False)
    print("wrote", path)


if __name__ == "__main__":
    if not KEY:
        sys.exit("set GRADIUM_API_KEY")
    if len(sys.argv) >= 3 and sys.argv[1] == "generate":
        generate(json.load(open(sys.argv[2])))
    elif len(sys.argv) >= 3 and sys.argv[1] == "convert":
        convert(sys.argv[2:])
    else:
        sys.exit(__doc__)
