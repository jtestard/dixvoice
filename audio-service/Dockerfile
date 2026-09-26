# Build: docker build -t audio-service ./audio-service   (context = this folder)
FROM ghcr.io/astral-sh/uv:python3.12-trixie-slim AS builder
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=0 UV_NO_DEV=1
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-install-project --no-editable
COPY README.md ./
COPY src ./src
RUN uv sync --locked --no-editable

FROM python:3.12-slim-trixie
RUN groupadd --system --gid 999 app && useradd --system --gid 999 --uid 999 --create-home app
COPY --from=builder --chown=app:app /app/.venv /app/.venv
COPY --chown=app:app config/ /app/config/
COPY --chown=app:app library/ /app/library/
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 PORT=8080 \
    CONFIG_DIR=/app/config LIBRARY_DIR=/app/library \
    LOCAL_CDN_DIR=/data/cdn DATA_DIR=/data/objects
RUN mkdir -p /data && chown app:app /data
WORKDIR /app
USER app
EXPOSE 8080
CMD ["audio-service"]
