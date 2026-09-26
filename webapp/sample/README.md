# sample — audio clip browser

A tiny static page (plain `index.html`, `app.js`, `style.css`; no build step) that lists every sound of the audio
service, library and generated, with text search, emotion / voice filters, sorting and playback. Filter state is
kept in the URL query string (e.g. `?q=gap&emotion=neutral`) so a view can be shared.

It loads `https://dixvoice.api.gcast.app/audio/list` (the backend's proxy of the audio service, which returns full
AudioResponse objects) and plays each clip from its `clipUrl` on the CDN. The backend must list the page's origin in
`ALLOWED_ORIGINS` (`https://dixvoice-sample.api.gcast.app` in production; `http://localhost:8080` is not allowed, so
locally point `API` in `app.js` at a local backend started with that origin).

## Docker

Served by `nginxinc/nginx-unprivileged` on port 8080.

```sh
docker buildx build --platform linux/arm64 -t dixvoice-sample --load webapp/sample
docker run --rm -p 8080:8080 dixvoice-sample
```

Deploy with `make deploy-sample` from the repository root.
