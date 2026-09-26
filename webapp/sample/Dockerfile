# Build context: webapp (so the library manifest can be copied in)
# docker buildx build --platform linux/arm64 -f webapp/sample/Dockerfile -t <image> webapp

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY sample/nginx.conf /etc/nginx/conf.d/default.conf
COPY sample/index.html sample/app.js sample/style.css /usr/share/nginx/html/
COPY audio/library/manifest.json /usr/share/nginx/html/manifest.json
EXPOSE 8080
