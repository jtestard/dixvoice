"""FastAPI app. Contract: spec/audio-service.openapi.json (GET /audio/list, GET /audio/{id}, POST /audio).
Out of contract: GET /healthz (Kubernetes probes) and, in local dev only, /cdn (a stand-in for the CDN)."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os

import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .emotion import EmotionMapper
from .errors import error_response, install_handlers
from .generator import Generator
from .models import UUID4_RE, AudioRequest, AudioResponse, ErrorBody
from .providers.base import Provider
from .providers.fake import FakeProvider, OffProvider
from .providers.gradium import GradiumProvider
from .registry import Registry
from .settings import Settings
from .storage import LocalStorage, S3Storage
from .textguard import TextGuard

log = logging.getLogger("audio_service")
ERRORS = {"model": ErrorBody}


def make_provider(s: Settings) -> Provider:
    if s.provider == "gradium":
        return GradiumProvider(s.gradium_api_key, s.gradium_base_url, s.gradium_model, s.gradium_fallback_model,
                               s.provider_timeout_s)
    if s.provider == "off":
        return OffProvider()
    return FakeProvider(s.fake_latency_ms)


def create_app(settings: Settings | None = None) -> FastAPI:
    s = settings or Settings()
    if s.storage == "s3":
        storage = S3Storage(s.s3_bucket, s.aws_region, s.data_dir)
    elif s.storage == "local":
        storage = LocalStorage(s.local_cdn_dir, s.data_dir)
    else:
        raise ValueError(f"unknown STORAGE={s.storage!r} (local or s3)")
    provider = make_provider(s)
    registry = Registry(s, storage)
    generator = Generator(s, provider, storage, registry, EmotionMapper(s.config_dir),
                          TextGuard(s.config_dir / "blocklist.txt"))

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        await registry.load()
        await provider.start()
        keepalive = asyncio.create_task(_keep_warm(provider))
        app.state.ready = True
        yield
        keepalive.cancel()
        await provider.close()

    app = FastAPI(
        title="Dixvoice audio generator microservice",
        version="0.1.0",
        description="Lists, returns and generates short speech clips (at most 2 seconds). "
                    "The mp3 files are served by a CDN at each object's clipUrl, not by this service. "
                    "Contract: spec/audio-service.openapi.json.",
        lifespan=lifespan,
    )
    app.state.ready = False
    install_handlers(app)

    # /audio/list must be declared before /audio/{id}, otherwise "list" is taken for an id.
    @app.get("/audio/list", response_model=list[AudioResponse], operation_id="listAudio",
             summary="List all available audio objects")
    async def list_audio(request: Request):
        etag, items = registry.listing()
        headers = {"ETag": etag, "Cache-Control": "no-cache"}
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers=headers)
        return JSONResponse(items, headers=headers)

    @app.get("/audio/{id}", response_model=AudioResponse, operation_id="getAudio", summary="Get one audio object",
             responses={404: ERRORS})
    async def get_audio(id: str):
        sound = registry.get(id) if UUID4_RE.match(id) else None
        if sound is None:
            return error_response(404, "not_found", f"No audio with id {id!r}.")
        return JSONResponse(sound.model_dump(), headers={"Cache-Control": "public, max-age=31536000, immutable"})

    @app.post("/audio", response_model=AudioResponse, status_code=201, operation_id="createAudio",
              summary="Generate a new audio object from text and emotion", responses={400: ERRORS, 502: ERRORS})
    async def create_audio(req: AudioRequest):
        sound = await generator.create(req)
        return JSONResponse(sound.model_dump(), status_code=201, headers={"Location": f"/audio/{sound.id}"})

    @app.get("/healthz", include_in_schema=False)
    async def healthz():
        body = {"status": "ok" if app.state.ready else "starting", "clips": len(registry.sounds),
                "library": len(registry.library_ids), "generated": registry.generated_count, **provider.status()}
        body["generation_available"] = body.get("provider_state") in ("ok", "degraded")
        return JSONResponse(body, status_code=200 if app.state.ready else 503)

    if s.serve_local_cdn and s.storage == "local":
        app.mount("/cdn", StaticFiles(directory=s.local_cdn_dir), name="cdn")

    def contract_openapi():
        # FastAPI documents its own 422; this service answers 400 instead (contract: 400, 404, 502 only).
        if app.openapi_schema is None:
            from fastapi.openapi.utils import get_openapi
            schema = get_openapi(title=app.title, version=app.version, description=app.description, routes=app.routes)
            for path in schema.get("paths", {}).values():
                for op in path.values():
                    op.get("responses", {}).pop("422", None)
            for name in ("HTTPValidationError", "ValidationError"):
                schema.get("components", {}).get("schemas", {}).pop(name, None)
            app.openapi_schema = schema
        return app.openapi_schema

    app.openapi = contract_openapi
    app.state.settings, app.state.registry, app.state.generator = s, registry, generator
    return app


async def _keep_warm(provider: Provider) -> None:
    """Keeps a connection to Gradium open and the credits fresh (Gradium's idle timeout is undocumented)."""
    refresh = getattr(provider, "refresh_credits", None)
    if refresh is None:
        return
    while True:
        await asyncio.sleep(30)
        await refresh()


def run() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(name)s %(levelname)s %(message)s")
    s = Settings()
    # One process, one worker: the registry lives in memory (plan §2).
    uvicorn.run(create_app(s), host=s.host, port=s.port, workers=1, timeout_graceful_shutdown=8)
