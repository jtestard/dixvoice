"""In-memory registry of every sound (library and generated), rebuilt at startup from the library manifest and from
the stored objects of generated sounds. The list is sorted by id, so it never reveals the order sounds were added."""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path

from .models import AudioResponse
from .settings import Settings
from .storage import Storage

log = logging.getLogger("audio_service.registry")


class Registry:
    def __init__(self, settings: Settings, storage: Storage):
        self.settings = settings
        self.storage = storage
        self.sounds: dict[str, AudioResponse] = {}
        self.library_ids: set[str] = set()
        self._list_cache: tuple[str, list[dict]] | None = None

    async def load(self) -> None:
        manifest_path = self.settings.library_dir / self.settings.library_manifest
        entries = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else []
        uploaded = 0
        for e in entries:
            if not (e.get("enabled", True) and e.get("deal", True)):
                continue
            clip_id = e["id"]
            if not await self.storage.has_clip(clip_id):
                await self.storage.put_clip(clip_id, (self.settings.library_dir / e["file"]).read_bytes())
                uploaded += 1
            self._add(AudioResponse(id=clip_id, text=e["text"], emotion=e["emotion"], voiceId=e["voice_id"],
                                    clipUrl=self.settings.clip_url(clip_id)))
            self.library_ids.add(clip_id)
        generated = 0
        for raw in await self.storage.list_objects():
            obj = json.loads(raw)
            self._add(AudioResponse(**obj["sound"]))
            generated += 1
        log.info("registry loaded: %d library clips (%d uploaded), %d generated", len(self.library_ids), uploaded, generated)

    def _add(self, sound: AudioResponse) -> None:
        self.sounds[sound.id] = sound
        self._list_cache = None

    async def add_generated(self, sound: AudioResponse) -> None:
        """The object is stored before the sound appears in the list, so a restart never loses it."""
        record = {"sound": sound.model_dump()}
        await self.storage.put_object(sound.id, json.dumps(record, ensure_ascii=False).encode())
        self._add(sound)

    def get(self, clip_id: str) -> AudioResponse | None:
        return self.sounds.get(clip_id)

    def listing(self) -> tuple[str, list[dict]]:
        """(etag, sorted list of AudioResponse dicts)."""
        if self._list_cache is None:
            ids = sorted(self.sounds)
            etag = '"' + hashlib.sha256("\n".join(ids).encode()).hexdigest()[:32] + '"'
            self._list_cache = (etag, [self.sounds[i].model_dump() for i in ids])
        return self._list_cache

    @property
    def generated_count(self) -> int:
        return len(self.sounds) - len(self.library_ids)
