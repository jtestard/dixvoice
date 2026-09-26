"""POST /audio: text + emotion -> Gradium voice -> 2-second mp3 on the CDN -> AudioResponse."""

from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import json
import logging
import time
import uuid

from . import audio
from .emotion import EmotionMapper, guess_language, length_padding
from .errors import ApiError
from .models import AudioRequest, AudioResponse
from .providers.base import Provider, ProviderError, ProviderTimeout, ProviderUnavailable, UnknownVoice
from .registry import Registry
from .settings import Settings
from .storage import Storage
from .textguard import TextGuard, normalize_word_key

log = logging.getLogger("audio_service.generate")
PROCESSING_VERSION = "1"


class Generator:
    def __init__(self, settings: Settings, provider: Provider, storage: Storage, registry: Registry,
                 mapper: EmotionMapper, guard: TextGuard):
        self.settings = settings
        self.provider = provider
        self.storage = storage
        self.registry = registry
        self.mapper = mapper
        self.guard = guard
        self._slots = asyncio.Semaphore(settings.max_concurrency)
        self._budget_day = dt.date.today()
        self._budget_used = 0

    def _spend(self, n_chars: int) -> None:
        today = dt.date.today()
        if today != self._budget_day:
            self._budget_day, self._budget_used = today, 0
        if self._budget_used + n_chars > self.settings.daily_char_budget:
            raise ApiError(502, "busy", "Daily generation budget reached, try again tomorrow.")
        self._budget_used += n_chars

    async def create(self, req: AudioRequest) -> AudioResponse:
        t0 = time.perf_counter()
        spoken = self.guard.clean(req.text)
        if len(spoken) > self.settings.max_chars:
            raise ApiError(400, "text_too_long", f"At most {self.settings.max_chars} characters.")
        self.guard.check_blocked(req.text, req.emotion)
        preset = self.mapper.preset_for(req.emotion)
        language = guess_language(spoken)
        voice_id = req.voiceId or preset.voice_for(language)
        padding = max(-4.0, min(4.0, preset.padding_bonus + length_padding(len(spoken))))
        model_tag = getattr(self.provider, "model", self.provider.name)
        dedup_key = hashlib.sha256("|".join(
            [normalize_word_key(spoken), normalize_word_key(req.emotion), preset.id, voice_id, str(model_tag), PROCESSING_VERSION]
        ).encode()).hexdigest()

        timings: dict[str, float] = {}
        mp3 = None
        source_id = self.registry.duplicate_of(dedup_key)
        if source_id:
            mp3 = await self.storage.get_clip(source_id)
        truncated, spoken_text, model = False, None, "cache"
        if mp3 is None:
            source_id = None
            try:
                mp3, truncated, spoken_text, model = await self._synthesize(spoken, voice_id, preset.temp, padding, timings)
            except UnknownVoice as exc:
                if req.voiceId:
                    raise ApiError(400, "unknown_voice", f"Gradium has no voice {req.voiceId!r}.") from exc
                raise ApiError(502, "provider_error", f"Preset voice {voice_id!r} is unknown to Gradium.") from exc

        clip_id = str(uuid.uuid4())
        t_up = time.perf_counter()
        try:
            await asyncio.wait_for(self.storage.put_clip(clip_id, mp3), timeout=5)
        except Exception as exc:  # any storage failure: nothing is added to the list
            log.error("cdn upload failed for %s: %s", clip_id, exc)
            raise ApiError(502, "cdn_upload_failed", "Could not store the mp3 on the CDN.") from exc
        timings["cdn_upload"] = (time.perf_counter() - t_up) * 1000

        sound = AudioResponse(id=clip_id, text=req.text, emotion=req.emotion, voiceId=voice_id,
                              clipUrl=self.settings.clip_url(clip_id))
        await self.registry.add_generated(sound, dedup_key)
        timings["total"] = (time.perf_counter() - t0) * 1000
        log.info(json.dumps({  # never the text itself
            "event": "generated", "id": clip_id, "emotion": req.emotion, "preset": preset.id, "language": language,
            "chars": len(spoken), "model": model, "cached": source_id is not None, "truncated": truncated,
            "spoken_words": len(spoken_text.split()) if spoken_text else None,
            "timings_ms": {k: round(v, 1) for k, v in timings.items()},
        }))
        return sound

    async def _synthesize(self, text: str, voice_id: str, temp: float, padding: float, timings: dict):
        t_q = time.perf_counter()
        try:
            await asyncio.wait_for(self._slots.acquire(), timeout=self.settings.queue_timeout_s)
        except TimeoutError as exc:
            raise ApiError(502, "busy", "Too many generations at once, retry in a moment.") from exc
        timings["queue"] = (time.perf_counter() - t_q) * 1000
        try:
            self._spend(len(text))
            try:
                syn = await self.provider.synthesize(text, voice_id, temp, padding)
            except ProviderUnavailable as exc:
                raise ApiError(502, "provider_unavailable", str(exc)) from exc
            except UnknownVoice:
                raise
            except ProviderTimeout as exc:
                raise ApiError(502, "provider_timeout", str(exc)) from exc
            except ProviderError as exc:
                raise ApiError(502, "provider_error", str(exc)) from exc
        finally:
            self._slots.release()
        timings["provider_first_audio"] = syn.first_audio_ms or 0.0
        timings["provider_done"] = syn.total_ms
        t_p = time.perf_counter()
        processed, mp3 = await asyncio.to_thread(self._postprocess, syn)
        timings["postprocess"] = (time.perf_counter() - t_p) * 1000
        return mp3, processed.truncated, processed.spoken_text, syn.model

    def _postprocess(self, syn):
        processed = audio.process(syn.pcm16, syn.sample_rate, syn.words, self.settings.max_clip_s)
        return processed, audio.encode_mp3(processed.samples, processed.sample_rate)
