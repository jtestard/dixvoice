# Dixvoice audio service

Generates and lists the game's sound clips: short speech clips of **at most 2 seconds**, spoken with an emotion, made
with [Gradium](https://gradium.ai) text-to-speech. The Go backend is its only caller.

- **Contract** (source of truth): [`../spec/`](../spec) — `AudioRequest`, `AudioResponse`, OpenAPI.
- **Implementation plan** (French): [`../docs/plan-microservice-audio.md`](../docs/plan-microservice-audio.md).
- Interactive API docs when running: `http://localhost:8080/docs`.

```
Go backend ──(cluster network)──► audio service ──► Gradium TTS
                                        └──► mp3 files on the CDN, played by the browser from clipUrl
```

## Quick start (no key, no Docker)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh && source $HOME/.local/bin/env
cd audio-service
uv sync
uv run audio-service            # fake voices, local stand-in CDN at /cdn -> http://localhost:8080/docs
uv run pytest                   # 34 tests, no network, no credits
```

With the real Gradium voices and the real storage (keys in `../secret/`, ignored by git):

```bash
set -a; source ../secret/audio.env; source ../secret/aws.env; set +a
STORAGE=s3 CDN_PUBLIC_URL=https://dp1tbjxi4bfec.cloudfront.net uv run audio-service
```

Storage: the mp3 files go to the private S3 bucket `dixvoice-clips` (eu-west-1) at `audio/<id>.mp3`, served by
CloudFront at `https://dp1tbjxi4bfec.cloudfront.net/audio/<id>.mp3` (no `Last-Modified` header, `Range` supported). The
objects of generated sounds (text, emotion) stay on the service's disk (`DATA_DIR`, a persistent volume in
Kubernetes): CloudFront serves the whole bucket, so storing them there would make them public.

## Endpoints

| Method and path | Body | Response |
| --- | --- | --- |
| `GET /audio/list` | | `200` array of `AudioResponse`, library and generated sounds mixed, sorted by id (`ETag`, `304`) |
| `GET /audio/{id}` | | `200` `AudioResponse`; `404` if unknown |
| `POST /audio` | `AudioRequest` (`text`, `emotion`, optional `voiceId`) | `201` `AudioResponse`; `400` invalid input; `502` generation failed |
| `GET /healthz` | | `200` when ready, with the provider state (Kubernetes probes; not in the contract) |

```bash
curl -s localhost:8080/audio -H 'Content-Type: application/json' -d '{"text": "Is anyone there?", "emotion": "eerie"}'
# {"id":"5d2b8f60-…","text":"Is anyone there?","emotion":"eerie","voiceId":"6MFfc37kq0sBjBjy","clipUrl":"http://localhost:8080/cdn/audio/5d2b8f60-….mp3"}
curl -s localhost:8080/audio -H "Content-Type: application/json" -d '{"text": "Trop tard !", "emotion": "angry", "voiceId": "YKeBw3OV1RgpdhLh"}'   # force a voice
```

Errors are flat: `{"error": "<code>", "message": "…"}`.

| HTTP | `error` | When |
| --- | --- | --- |
| 400 | `invalid_request` | bad JSON, missing or extra field, `text` over 100 or `emotion` over 30 characters |
| 400 | `text_empty` | no letters left after cleaning |
| 400 | `text_has_digits` | digits (Gradium reads numbers out in full, which never fits in 2 s): write them in words |
| 400 | `text_rejected` | a blocked word in `text` or `emotion` ([`config/blocklist.txt`](config/blocklist.txt)) |
| 400 | `unknown_voice` | the request's `voiceId` is not a Gradium voice |
| 404 | `not_found` | unknown or malformed id |
| 502 | `busy` | too many generations at once, or daily budget reached |
| 502 | `provider_unavailable` | no key, revoked key, no credits, or `PROVIDER=off` |
| 502 | `provider_timeout` / `provider_error` | Gradium too slow or failing (after one retry on the fallback model) |
| 502 | `cdn_upload_failed` | the mp3 could not be stored |

## How a clip is made

1. **Text cleaning**: typographic quotes normalised, `<` `>` removed (no Gradium tags from players), digits refused.
2. **Emotion → voice**: if the request has a `voiceId`, that voice is used. Otherwise: Gradium has no emotion
   parameter; the emotion lives in the voice. The free-text emotion is
   matched against [`config/emotions.json`](config/emotions.json) (FR and EN words) to a preset of
   [`config/presets.json`](config/presets.json): a Gradium voice (French or English, from the language of the text),
   a liveliness (`temp`) and a speed (`padding_bonus`). Unknown emotions use the `neutral` preset.
3. **Gradium TTS**: `POST /post/speech/tts`, model `gradium-tts-beta` (falls back to `default` on error), raw 24 kHz
   audio with word timestamps, over one kept-alive HTTP client.
4. **2-second fit**: silences trimmed; longer texts are spoken faster, then cut after the last whole word before
   1.97 s; 30 ms fade-out; level normalised.
5. **mp3** (soundfile / LAME, 24 kHz mono VBR, exact length in Chrome and Safari), stored under a new **UUID v4**, then
   listed. Generated and library clips share the same id format, fields, encoder and file dates, so players cannot
   tell them apart.

## Library

The library is made of short spoken lines rendered with the same pipeline: currently **144 English lines** over 19
emotions and the 9 English preset voices (0.6 to 1.95 s each, about 1.1 MB in total), enough for a full game of 4
players (6 fresh clips per player per round).

```bash
# edit library/lines.json, then
GRADIUM_API_KEY=… uv run python tools/build_library.py --provider gradium
uv run python tools/build_library.py --check
```

Ids are drawn once per (text, emotion) and kept on rebuilds. The service uploads missing library clips to the CDN at
startup.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROVIDER` | `fake` | `gradium`, `fake` (dev/tests) or `off` |
| `GRADIUM_API_KEY` | | Gradium key (Kubernetes Secret in production) |
| `GRADIUM_MODEL` / `GRADIUM_FALLBACK_MODEL` | `gradium-tts-beta` / `default` | TTS models |
| `PROVIDER_TIMEOUT_S` | `5` | max time for one Gradium call |
| `STORAGE` | `local` | `local` (dev) or `s3` |
| `S3_BUCKET` / `AWS_REGION` | `dixvoice-clips` / `eu-west-1` | bucket of the mp3 files (keys: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) |
| `CDN_PUBLIC_URL` | `http://localhost:8080/cdn` | base of every `clipUrl` (production: `https://dp1tbjxi4bfec.cloudfront.net`) |
| `SERVE_LOCAL_CDN` | `1` | dev only: serve the stored mp3 under `/cdn` |
| `LOCAL_CDN_DIR` / `DATA_DIR` | `/tmp/dixvoice-cdn` / `/tmp/dixvoice-data` | stored mp3 files / generated objects |
| `MAX_CONCURRENCY` | `4` | simultaneous generations |
| `DAILY_CHAR_BUDGET` | `50000` | Gradium credits per day (1 credit per character) |
| `PORT` | `8080` | |

## Deployment

One pod on the gcast EKS cluster (namespace `dixvoice`), next to the Go backend, never exposed outside the cluster.
Manifest: [`../deploy/k8s/audio.yaml`](../deploy/k8s/audio.yaml) (Deployment with 1 replica, Service
`dixvoice-audio` on port 80, NetworkPolicy letting only the backend in). From the repository root:

```bash
make audio-secret    # Gradium and AWS keys from secret/ into the Kubernetes secret
make deploy-audio    # build the arm64 image, push it to ECR, roll out
make logs-audio
```

The backend reaches it at `AUDIO_SERVICE_URL=http://dixvoice-audio.dixvoice.svc.cluster.local`. CI
([`../.github/workflows/audio-service.yml`](../.github/workflows/audio-service.yml)) runs the tests, checks the library
and builds and smoke-tests the image.

## Measured

First run on 2026-09-26, from Paris, 5 clips (10 to 24 characters), model `gradium-tts-beta`:

| Step | Measured |
| --- | --- |
| Gradium, first audio | 63 to 138 ms |
| Gradium, whole clip | 553 to 624 ms |
| Trim, fit, mp3 | 4 to 9 ms |
| Upload to S3 | 87 to 205 ms |
| **`POST /audio` total** | **645 to 764 ms** |

Clips last 0.5 to 1.5 s; the French lines were spoken at about 24 characters per second, so about 40 characters fit in
2 seconds.

## Status

- Done: the three contract endpoints, Gradium client, fake provider, 2-second fit, mp3, UUIDs, persistence of
  generated sounds across restarts, library builder, tests (contract checked against `spec/`).
- To do: more latency measurements (`tools/probe_latency.py`, to adapt), more library content, Voice Design voices for emotions the catalogue lacks
  (`tools/design_voices.py`).

## Tools used

Gradium TTS (`gradium-tts-beta`), AWS S3 + CloudFront (boto3), FastAPI, uvicorn, httpx, numpy, soundfile (libsndfile + LAME), uv, pytest,
jsonschema, Docker, Kubernetes. Voices generated with Gradium AI.
