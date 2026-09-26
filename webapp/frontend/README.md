# Dixvoice frontend

Vite + React + TypeScript single-page app. It holds no game logic: it renders the `state` snapshots sent by the
backend over WebSocket and sends player actions back (see the root `README.md` > Web App > Protocol).

## Run

```sh
npm install
npm run mock     # dev mock backend on http://localhost:8080 (terminal 1)
npm run dev      # Vite dev server on http://localhost:5173 (terminal 2)
```

The mock (`mock/server.mjs`) implements the Protocol, including `add_companion` / `remove_companion`, with a few
sample mp3 tones: press "Add AI companion" three times in the lobby and one person can click through a whole game
alone, or press "Quick start" on Home to do all of that in one tap. Mock companions join ~0.8 s after
`add_companion` and play random valid moves ~1.5 s after each phase change. Options (env vars): `PORT` (8080),
`MOCK_BOTS` (0, extra non-companion bots pre-seated in every room), `MOCK_BOT_DELAY_MS` (1500),
`MOCK_COMPANION_DELAY_MS` (800), `MOCK_POOL_SIZE` (240 sounds), `MOCK_COMPANIONS_DOWN=1` (make `add_companion` fail
with `companion_unavailable`).

Against a real backend, point `VITE_BACKEND_URL` at it (copy `.env.example` to `.env.local`):

```sh
VITE_BACKEND_URL=http://localhost:9000 npm run dev
```

## Env vars

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_BACKEND_URL` | `http://localhost:8080` | Base URL of the backend, used for HTTP (`/rooms`, ...) and WebSocket (`/ws`, scheme swapped to `ws`/`wss`). Build-time. |

## Scripts

- `npm run dev`, `npm run build`, `npm run preview`
- `npm run lint` (oxlint), `npm test` (Vitest + Testing Library)
- `npm run check:mobile [-- --shots]`: Playwright no-scroll check on phone viewports against the mock backend
  (needs `npx playwright install chromium` once); `--shots` writes screenshots to `mobile-fit/`
- `npm run mock`: dev mock backend
- `npm run package`: builds with the current `VITE_BACKEND_URL` and zips `dist/` into `dixvoice-frontend.zip`

## Package for itch.io

```sh
VITE_BACKEND_URL=https://backend.example.com npm run package
```

Upload `dixvoice-frontend.zip` as an HTML project: set "This file will be played in the browser", check
**Mobile friendly**, enable the **fullscreen button**, and set a viewport of at least 360x640. `vite.config.ts` uses
`base: './'` so the bundle works from itch.io's zip hosting. The backend's `ALLOWED_ORIGINS` must include the itch.io
domain the game is served from.

## Container (hosted at https://dixvoice-web.api.gcast.app)

Multi-stage `Dockerfile` (build context: `webapp/frontend`): Node builds `dist/` with `VITE_BACKEND_URL` (default
`https://dixvoice.api.gcast.app`), then `nginxinc/nginx-unprivileged` serves it as non-root on port 8080 with an SPA
fallback to `index.html`, `immutable` caching for `/assets/*` and `no-cache` for everything else. `GET /` returns 200
(readiness probe). Kubernetes manifests live in `deploy/k8s/`.

```sh
docker buildx build --platform linux/arm64 --build-arg VITE_BACKEND_URL=https://dixvoice.api.gcast.app -t dixvoice-frontend webapp/frontend
docker run --rm -p 8080:8080 dixvoice-frontend
```

## Notes

- The session token is kept in `localStorage`; the app reconnects automatically (exponential backoff, max 10 s) and
  returns to Home on `room_closed` or when the server closes the socket with a `4xxx` code.
- Audio is played through a single HTML `<audio>` element, always from a tap. On the first tap
  `navigator.audioSession.type = 'playback'` is set when available (iOS silent switch).
