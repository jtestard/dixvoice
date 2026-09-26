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
- The storyteller move gets a longer budget (~20 s) because it runs the clue search described below.
- It never sends `start_game`, `stop_game`, `next_round`, `leave_room`, `add_companion` or `remove_companion`.
- `room_closed` (room stopped or companion removed) ends the companion. If the socket drops, it reconnects with the
  same token with exponential backoff (0.5 s up to 10 s, 20 attempts); a `401` on reconnect means the room is gone
  and the companion stops.
- Everything is in memory; companions are independent goroutines, so many rooms and companions run concurrently.
  Logs are JSON (`log/slog`).

## Storyteller clue search

Under Dixit scoring the storyteller scores 0 when every guesser or no guesser finds the clip, and 3 (plus 3 per
finder) otherwise, so the best clue is one that *some* players find. A single prompt tends to paraphrase the clip's
text, which every player finds. `internal/gemini/storyteller.go` therefore searches:

1. **Candidates** — one Gemini call returns ~4 `(clipId, clue)` pairs on different clips of the hand at different
   levels of indirection (metaphor, a scene where you would hear it, a feeling, a cultural reference). The prompt
   spells out the scoring rule and the recent history (below).
2. **Lexical filter** (Go, no model) — a candidate is rejected if it is longer than 8 words or shares any
   non-stopword with the clip's text or emotion, case-insensitively and after stripping a trailing `s`/`es`/`ed`/`ing`.
3. **Simulated guessers** — for each surviving candidate, 3 parallel "guesser" calls (temperature 1) receive the clue
   and the companion's whole hand, shuffled, without being told the answer, and pick the storyteller's clip. The share
   of guessers that pick the target is `p`.
4. **Expected score** — with `g` = players in the room minus 1, the storyteller's expected score under the binomial
   model is `3 * P(1 <= finders <= g-1) = 3 * (1 - (1-p)^g - p^g)`. The candidate maximising it wins, ties go to the
   lower `p`. The chosen `p` and expected score are logged at debug level.
5. **Fallback** — if the candidates call fails, every candidate is filtered out, all guesser calls fail or the search
   exceeds its 12 s timeout, the companion uses the previous single-shot prompt (`ChooseClueSingle`), and after that
   the random clip + canned clue, so the game never stalls.

**Learning within a game.** After each reveal in which the companion was the storyteller, it records how many of the
`g` guessers found its clip. The last 5 results go into the candidate prompt ("everyone found *X*, be more oblique" /
"nobody found *Y*, be a bit more direct").

**Live evaluation.** `cmd/evalclues` deals hands from `webapp/audio/library/manifest.json`, asks both the old
single-shot prompt and the new search for a clue and reports the distribution of simulated find rates:

```sh
GEMINI_API_KEY=... go run ./cmd/evalclues -hands 20 -players 4
```

## Layout

- `cmd/companions`: the binary.
- `cmd/evalclues`: opt-in live comparison of the storyteller strategies against the real Gemini API.
- `internal/protocol`: the JSON messages of the backend protocol.
- `internal/gemini`: Gemini REST client, prompts and answer validation; `storyteller.go` is the clue search.
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
