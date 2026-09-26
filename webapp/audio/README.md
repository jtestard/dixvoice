# Dixvoice audio service

Python service implementing the audio generator microservice described in the root `README.md` (Audio Generator
Microservice) and specified in [`spec/`](../../spec): it lists, returns and generates speech clips of at most
2 seconds, spoken with an emotion by [Gradium](https://gradium.ai) text-to-speech. The mp3 files are stored in the
S3 bucket `dixvoice-clips` and served by CloudFront at each clip's `clipUrl`. The backend is its only caller.
Implementation plan (French): [`docs/plan-microservice-audio.md`](../../docs/plan-microservice-audio.md).

## Layout

- `src/audio_service/main.py`: FastAPI app, the three contract endpoints (`GET /audio/list`, `GET /audio/{id}`,
  `POST /audio`) and `GET /healthz`.
- `src/audio_service/generator.py`: `POST /audio` pipeline (clean the text, pick the voice, synthesize, fit in 2 s,
  encode, store, list).
- `src/audio_service/providers/`: `gradium.py` (Gradium REST client), `fake.py` (offline voices for dev and tests).
- `src/audio_service/audio.py`: trim, cut at a word boundary, fades, level, mp3 (no I/O).
- `src/audio_service/emotion.py`, `textguard.py`: free-text emotion to voice preset, text cleaning and blocklist.
- `src/audio_service/storage.py`, `registry.py`: S3 or local storage, in-memory list of every sound.
- `config/`: voice presets, emotion words, blocklist. `library/`: the pre-generated clips and their manifest.
- `tools/`: `build_library.py` (renders `library/lines.json`), `probe_latency.py` and `design_voices.py` (prototypes).
- `tests/`: API, contract against `spec/`, indistinguishability, audio, Gradium client (mocked).

## Run locally

Requires [uv](https://docs.astral.sh/uv/) (it installs Python 3.12 itself).

```sh
cd webapp/audio
uv sync
uv run dixvoice-audio       # fake voices, local stand-in CDN under /cdn, on :8080 (API docs at /docs)
```

With the real Gradium voices and the real bucket (keys in `secret/`, ignored by git):

```sh
set -a; source ../../secret/audio.env; source ../../secret/aws.env; set +a
STORAGE=s3 CDN_PUBLIC_URL=https://dp1tbjxi4bfec.cloudfront.net uv run dixvoice-audio
```

Then, for example:

```sh
curl -s localhost:8080/audio/list | head -c 200
curl -s -X POST localhost:8080/audio -H 'Content-Type: application/json' -d '{"text":"Is anyone there?","emotion":"eerie"}'
# {"id":"5d2b8f60-…","text":"Is anyone there?","emotion":"eerie","voiceId":"6MFfc37kq0sBjBjy","clipUrl":"https://…/audio/5d2b8f60-….mp3"}
curl -s -X POST localhost:8080/audio -H 'Content-Type: application/json' -d '{"text":"Trop tard !","emotion":"angry","voiceId":"YKeBw3OV1RgpdhLh"}'
```

To run the backend against it: `AUDIO_SERVICE_URL=http://localhost:8080 PORT=9000 go run ./cmd/server` in
`webapp/backend`.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Listen port. |
| `PROVIDER` | `fake` | `gradium`, `fake` (dev and tests) or `off` (generation disabled). |
| `GRADIUM_API_KEY` | | Gradium key (Kubernetes secret in production). |
| `GRADIUM_MODEL` / `GRADIUM_FALLBACK_MODEL` | `gradium-tts-beta` / `default` | TTS model, and the one retried on error. |
| `PROVIDER_TIMEOUT_S` | `5` | Max time for one Gradium call. |
| `STORAGE` | `local` | `local` (mp3 in `LOCAL_CDN_DIR`, served under `/cdn`) or `s3`. |
| `S3_BUCKET` / `AWS_REGION` | `dixvoice-clips` / `eu-west-1` | Bucket of the mp3 files; keys in `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. |
| `CDN_PUBLIC_URL` | `http://localhost:8080/cdn` | Prefix of every `clipUrl` (production: `https://dp1tbjxi4bfec.cloudfront.net`). |
| `SERVE_LOCAL_CDN` | `1` | Dev only: serve `LOCAL_CDN_DIR` under `/cdn`. |
| `LOCAL_CDN_DIR` / `DATA_DIR` | `/tmp/dixvoice-cdn` / `/tmp/dixvoice-data` | Local mp3 files / objects of generated sounds. |
| `MAX_CONCURRENCY` | `4` | Simultaneous generations. |
| `DAILY_CHAR_BUDGET` | `50000` | Gradium credits per day (1 credit per character). |

## Endpoints and errors

The contract is [`spec/audio-service.openapi.json`](../../spec/audio-service.openapi.json). `POST /audio` takes
`text` (1-100 characters), `emotion` (1-30, free text) and an optional `voiceId` (a Gradium voice to force). Errors are
flat, `{"error": "<code>", "message": "…"}`:

| HTTP | `error` | When |
| --- | --- | --- |
| 400 | `invalid_request` | Bad JSON, missing or extra field, a field too long. |
| 400 | `text_empty` | No letters left after cleaning. |
| 400 | `text_has_digits` | Digits: Gradium reads numbers out in full, which never fits in 2 s. Write them in words. |
| 400 | `text_rejected` | A blocked word in `text` or `emotion` ([`config/blocklist.txt`](config/blocklist.txt)). |
| 400 | `unknown_voice` | The request's `voiceId` is not a Gradium voice. |
| 404 | `not_found` | Unknown or malformed id. |
| 502 | `busy` | Too many generations at once, or daily budget reached. |
| 502 | `provider_unavailable` | No key, revoked key, no credits, or `PROVIDER=off`. |
| 502 | `provider_timeout` / `provider_error` | Gradium too slow or failing (after one retry on the fallback model). |
| 502 | `cdn_upload_failed` | The mp3 could not be stored. |

## How a clip is made

1. Text cleaning: typographic quotes normalized, `<` and `>` removed (no Gradium tags from players), digits refused.
2. Voice: the request's `voiceId` if given; otherwise the free-text emotion is matched against
   [`config/emotions.json`](config/emotions.json) (French and English words) to a preset of
   [`config/presets.json`](config/presets.json): a Gradium voice (French or English, from the language of the text), a
   liveliness (`temp`) and a speed (`padding_bonus`). Gradium has no emotion parameter: the emotion lives in the voice.
3. Gradium TTS (`POST /post/speech/tts`, raw 24 kHz audio with word timestamps) over one kept-alive HTTP client.
4. Fit in 2 s: silences trimmed, longer texts spoken faster, then cut after the last whole word; 30 ms fade-out.
5. mp3 (soundfile/LAME, 24 kHz mono VBR, exact length in Chrome and Safari), uploaded to
   `s3://dixvoice-clips/audio/{id}.mp3` under a new UUID v4, then listed. Library and generated clips share the id
   format, fields, encoder and headers, so players cannot tell them apart.

## Library

144 English lines over 19 emotions and the 9 English preset voices (0.6 to 1.95 s each, about 1.1 MB), enough for a
full game of 4 players (6 fresh clips per player per round). Edit `library/lines.json`, then:

```sh
GRADIUM_API_KEY=… uv run python tools/build_library.py --provider gradium
uv run python tools/build_library.py --check
```

Ids are drawn once per line and kept on rebuilds. The service uploads missing library clips to the bucket at startup.

## Test

```sh
uv run pytest
```

No network, no credits: the Gradium client runs against a mocked transport and the service against the fake provider.
`tests/test_contract.py` validates every response against `spec/` and compares the paths, methods and status codes of
the generated OpenAPI with `spec/audio-service.openapi.json`. CI ([`.github/workflows/audio.yml`](../../.github/workflows/audio.yml))
also builds the image and smoke-tests it.

## Docker

The image is built for the arm64 cluster nodes with `webapp/audio` as the build context (uv in a builder stage,
then a slim Python 3.12 image running as non-root):

```sh
docker buildx build --platform linux/arm64 -t dixvoice-audio .
docker run --rm -p 8080:8080 -e PROVIDER=fake dixvoice-audio
```

Kubernetes manifests live in `deploy/k8s/` at the repository root ([`audio.yaml`](../../deploy/k8s/audio.yaml)): one
replica, Service `dixvoice-audio` on port 80 (the backend's `AUDIO_SERVICE_URL` is
`http://dixvoice-audio.dixvoice.svc.cluster.local`), no Ingress, and a NetworkPolicy that only lets the backend in.
From the repository root: `make audio-secret` (Gradium and AWS keys from `secret/`), then `make deploy-audio`.

## Measured

First run on 2026-09-26 from Paris, 5 clips of 10 to 24 characters, model `gradium-tts-beta`: Gradium first audio 63
to 138 ms, whole clip 553 to 624 ms, trim/fit/mp3 4 to 9 ms, upload to S3 87 to 205 ms, **`POST /audio` total 645 to
764 ms**. French lines were spoken at about 24 characters per second, so about 40 characters fit in 2 seconds.

Voices generated with Gradium AI.
