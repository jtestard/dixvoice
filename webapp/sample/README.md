# sample — audio library browser

A tiny static page (plain `index.html`, `app.js`, `style.css`; no build step) that lists every clip of the audio
library from `webapp/audio/library/manifest.json`, with text search, emotion / voice filters, sorting and playback
from the CDN (`https://dp1tbjxi4bfec.cloudfront.net/audio/{id}.mp3`). Filter state is kept in the URL query string
(e.g. `?q=gap&emotion=neutral`) so a view can be shared.

The page fetches `./manifest.json` from its own origin at runtime, so the served folder must contain a copy of the
library manifest.

## Run locally

```sh
cd webapp/sample
cp ../audio/library/manifest.json .
python3 -m http.server 8080
# open http://localhost:8080/
```

## Docker

Built from `webapp/` as context so the manifest can be copied in; served by `nginxinc/nginx-unprivileged` on port 8080.

```sh
docker buildx build --platform linux/arm64 -f webapp/sample/Dockerfile -t dixvoice-sample --load webapp
docker run --rm -p 8080:8080 dixvoice-sample
curl -i localhost:8080/            # 200, readiness probe
curl -s localhost:8080/manifest.json | head
```
