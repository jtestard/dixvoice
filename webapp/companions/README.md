# Dixvoice AI companions

Go service running the AI companions described in the root `README.md` (Web App > AI companions): fake players that
join a room through the backend's public HTTP + WebSocket protocol and play Dixit-with-sound-clips, choosing clips
from their `text` and `emotion` with the Google Gemini API.

## How it works

- `POST /companions {"roomCode": "KXQP"}` answers `202` and starts one companion in the background (call it again
  for another one). `GET /healthz` answers `200`.
- A companion picks a nickname ("Robo Ada", "Dr. Diode", ...), calls `POST {BACKEND_URL}/rooms/{code}/join` with
  `{"nickname": ..., "companion": true}`, then opens `GET {BACKEND_URL}/ws?token=...` (`ws`/`wss` derived from
  `BACKEND_URL`).
- On every `state` snapshot it decides whether a move is expected from it, at most once per round and phase:
  - storyteller phase, it is the storyteller: `submit_clue` with a clip from its hand and a short clue;
  - submit phase, not the storyteller, not submitted yet: `submit_clip` with the hand clip matching the clue;
  - vote phase, not the storyteller, not voted yet: `vote` for a table clip, never its own submission.
- Moves happen after a random 2–6 s pause. Gemini (`generateContent` with a JSON response schema whose `clipId` is an
  enum of the valid clips) is given ~10 s; on error, timeout or invalid answer the companion plays a random valid
  move (and a canned clue). If the backend rejects a move (`error` message), it retries up to 3 times.
- It never sends `start_game`, `stop_game`, `next_round`, `leave_room`, `add_companion` or `remove_companion`.
- `room_closed` (room stopped or companion removed) ends the companion. If the socket drops, it reconnects with the
  same token with exponential backoff (0.5 s up to 10 s, 20 attempts); a `401` on reconnect means the room is gone
  and the companion stops.
- Everything is in memory; companions are independent goroutines, so many rooms and companions run concurrently.
  Logs are JSON (`log/slog`).

## Layout

- `cmd/companions`: the binary.
- `internal/protocol`: the JSON messages of the backend protocol.
- `internal/gemini`: Gemini REST client, prompts and answer validation.
- `internal/companion`: one companion (join, WebSocket loop, decisions, fallback, reconnect).
- `internal/server`: HTTP API and the set of running companions.
- `e2e`: full game against the real backend (see Test).

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Listen port. |
| `BACKEND_URL` | `http://localhost:8080` | Backend base URL, e.g. `http://dixvoice-backend.dixvoice.svc.cluster.local:8080`. |
| `GEMINI_API_KEY` | | Google Gemini API key. Without it every decision falls back to a random move. |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Gemini model id (current stable Flash model). |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | Override for tests or proxies. |

## Run locally

Requires Go 1.27+. Start the backend with its mock audio service, then the companions:

```sh
cd webapp/backend
go run ./cmd/mockaudio                      # mock audio service on :8081
go run ./cmd/server                          # backend on :8080

cd ../companions
PORT=8090 BACKEND_URL=http://localhost:8080 GEMINI_API_KEY=... go run ./cmd/companions
```

Then either point the backend at it (`COMPANION_SERVICE_URL=http://localhost:8090`) and press "Add AI companion" in
the web app, or add companions by hand:

```sh
curl -s -X POST localhost:8080/rooms -d '{"nickname":"Ana"}'          # -> {"roomCode":"KXQP",...}
curl -i -X POST localhost:8090/companions -d '{"roomCode":"KXQP"}'   # 202, repeat for more companions
```

## Test

```sh
go vet ./...
go test -race ./...                  # unit tests, no network
DIXVOICE_E2E=1 go test -race ./e2e   # full game against the real backend
```

Unit tests use a fake Gemini HTTP server and a fake backend (HTTP join + WebSocket). The end-to-end test builds and
runs `webapp/backend` (`cmd/server` and `cmd/mockaudio`), creates a room with a scripted human, adds 4 companions
through `POST /companions`, plays a whole game with a fake Gemini server and checks that every companion leaves on
`stop_game`. It is skipped unless `DIXVOICE_E2E=1`.

## Docker

```sh
docker buildx build --platform linux/arm64 -t dixvoice-companions webapp/companions
docker run --rm -p 8090:8080 -e BACKEND_URL=http://host.docker.internal:8080 -e GEMINI_API_KEY=... dixvoice-companions
```

Multi-stage build: the Go binary is cross-compiled from buildx's `TARGETARCH` with `CGO_ENABLED=0` into a distroless
image running as non-root. Kubernetes manifests live in `deploy/k8s/companions.yaml` at the repository root.
