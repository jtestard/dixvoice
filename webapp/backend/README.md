# Dixvoice backend

Go server implementing the rooms, game rules and protocol described in the root `README.md` (Web App > Back-End).
All state is in memory. Hands are dealt from the audio service's `GET /audio/list`; custom sounds are generated with
its `POST /audio`, in the background.

## Layout

- `cmd/server`: the backend binary.
- `cmd/mockaudio`: mock audio generator microservice for local development and tests (300 fixture sounds, 5 tone
  mp3 files served under `/clips/`; `POST /audio` "generates" a sound by picking a tone, after `-generate-delay`,
  800 ms by default).
- `internal/game`: rooms, players, phases, scoring and per-player state snapshots (no I/O).
- `internal/server`: HTTP endpoints, CORS, WebSocket protocol.
- `internal/audio`: client of the audio service; `internal/mockaudio`: the mock as a library.

## Run locally

Requires Go 1.27+ (`go.mod` pins the version).

```sh
cd webapp/backend
go run ./cmd/mockaudio            # mock audio service on :8081
go run ./cmd/server               # backend on :8080, talking to http://localhost:8081
```

Then, for example:

```sh
curl -s -X POST localhost:8080/rooms -d '{"nickname":"Ana"}'
# {"roomCode":"KXQP","playerId":"p1","token":"..."}
curl -s -X POST localhost:8080/rooms/KXQP/join -d '{"nickname":"Ben"}'
curl -s localhost:8080/audio/list | head -c 200
# WebSocket: ws://localhost:8080/ws?token=<token>
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Listen port. |
| `AUDIO_SERVICE_URL` | `http://localhost:8081` | Base URL of the audio service (or of the mock). |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated origins allowed for CORS and WebSocket upgrades, or `*` for any origin (production uses `*`: sessions are tokens, not cookies). |

Mock audio service: `-addr` (`MOCKAUDIO_ADDR`, default `:8081`), `-count` (default 300) and `-public-url`
(`MOCKAUDIO_PUBLIC_URL`) to force the prefix of the `clipUrl`s; by default it is derived from the request's `Host`.

## Test

```sh
go vet ./...
go test -race ./...
```

`internal/game` covers scoring, phase order, action validation, room limits, used sounds and snapshot visibility.
`internal/server` starts the mock audio service and the backend in-process and plays a whole game over WebSockets
with 4 clients, plus HTTP endpoints, CORS, reconnect, leave and stop.

## Docker

The image is built for the arm64 cluster nodes with `webapp/backend` as the build context; the Go binary is
cross-compiled from buildx's `TARGETARCH` (`CGO_ENABLED=0`) into a distroless image running as non-root:

```sh
docker buildx build --platform linux/arm64 -t dixvoice-backend .
docker build -t dixvoice-backend .   # local, native arch
docker run --rm -p 8080:8080 -e AUDIO_SERVICE_URL=http://host.docker.internal:8081 dixvoice-backend
```

Kubernetes manifests live in `deploy/k8s/` at the repository root. In production the backend is served at
`https://dixvoice.api.gcast.app` behind a Contour ingress (TLS terminated upstream); production
sets `ALLOWED_ORIGINS=*` so the frontend passes the CORS and WebSocket origin checks wherever it is hosted (our web
deployment, the sample page, itch.io). The server pings every WebSocket connection every 20 s so idle connections stay open
through the proxy.
