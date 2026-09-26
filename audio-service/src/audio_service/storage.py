"""Where the files go: public mp3 files (served by the CDN at clipUrl) and private objects of generated sounds.

Backends: LocalStorage (dev: mp3 files in a local folder served under /cdn) and S3Storage (production: mp3 files in
the dixvoice-clips bucket, served by CloudFront). In both cases the objects of generated sounds (text, emotion) stay on
the service's own disk: CloudFront serves the whole bucket, so an object stored there would be public and would reveal
which sounds were generated."""

from __future__ import annotations

import asyncio
import os
from functools import partial
import tempfile
from pathlib import Path
from typing import Protocol

# Every mp3 gets the same modification time, so Last-Modified (and ETags derived from it) never reveal that a
# sound was created during the game (indistinguishability requirement, plan §3).
FIXED_MTIME = 1_767_225_600  # 2026-01-01T00:00:00Z


class Storage(Protocol):
    async def put_clip(self, clip_id: str, mp3: bytes) -> None: ...

    async def has_clip(self, clip_id: str) -> bool: ...

    async def get_clip(self, clip_id: str) -> bytes | None: ...

    async def put_object(self, clip_id: str, data: bytes) -> None: ...

    async def list_objects(self) -> list[bytes]: ...


def _atomic_write(path: Path, data: bytes, mtime: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.chmod(tmp, 0o644)
    if mtime is not None:
        os.utime(tmp, (mtime, mtime))
    os.replace(tmp, path)


class LocalStorage:
    """mp3 files in <cdn_dir>/audio/<id>.mp3 (public), objects in <data_dir>/objects/<id>.json (private)."""

    def __init__(self, cdn_dir: Path, data_dir: Path):
        self.audio_dir = cdn_dir / "audio"
        self.objects_dir = data_dir / "objects"
        self.audio_dir.mkdir(parents=True, exist_ok=True)
        self.objects_dir.mkdir(parents=True, exist_ok=True)

    async def put_clip(self, clip_id: str, mp3: bytes) -> None:
        await asyncio.to_thread(_atomic_write, self.audio_dir / f"{clip_id}.mp3", mp3, FIXED_MTIME)

    async def has_clip(self, clip_id: str) -> bool:
        return (self.audio_dir / f"{clip_id}.mp3").exists()

    async def get_clip(self, clip_id: str) -> bytes | None:
        path = self.audio_dir / f"{clip_id}.mp3"
        return path.read_bytes() if path.exists() else None

    async def put_object(self, clip_id: str, data: bytes) -> None:
        await asyncio.to_thread(_atomic_write, self.objects_dir / f"{clip_id}.json", data)

    async def list_objects(self) -> list[bytes]:
        return [p.read_bytes() for p in sorted(self.objects_dir.glob("*.json"))]


CACHE_CONTROL = "public, max-age=31536000, immutable"


class S3Storage(LocalStorage):
    """mp3 files in s3://<bucket>/audio/<id>.mp3 (private bucket, read by CloudFront); objects on local disk.
    S3 sets Last-Modified to the upload time: the CloudFront distribution must not forward it (checked 2026-09-26)."""

    def __init__(self, bucket: str, region: str, data_dir: Path, timeout_s: float = 5.0):
        import boto3
        from botocore.config import Config

        self.bucket = bucket
        self.s3 = boto3.client("s3", region_name=region, config=Config(
            connect_timeout=timeout_s, read_timeout=timeout_s, retries={"max_attempts": 2, "mode": "standard"},
            max_pool_connections=10))
        self.objects_dir = data_dir / "objects"
        self.objects_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _key(clip_id: str) -> str:
        return f"audio/{clip_id}.mp3"

    async def put_clip(self, clip_id: str, mp3: bytes) -> None:
        await asyncio.to_thread(partial(self.s3.put_object, Bucket=self.bucket, Key=self._key(clip_id), Body=mp3,
                                        ContentType="audio/mpeg", CacheControl=CACHE_CONTROL))

    async def has_clip(self, clip_id: str) -> bool:
        from botocore.exceptions import ClientError
        try:
            await asyncio.to_thread(partial(self.s3.head_object, Bucket=self.bucket, Key=self._key(clip_id)))
            return True
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    async def get_clip(self, clip_id: str) -> bytes | None:
        from botocore.exceptions import ClientError
        try:
            obj = await asyncio.to_thread(partial(self.s3.get_object, Bucket=self.bucket, Key=self._key(clip_id)))
            return obj["Body"].read()
        except ClientError:
            return None
