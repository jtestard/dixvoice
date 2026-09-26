"""Builds the library: short spoken lines (text + emotion) rendered once with the same pipeline as live generation
(same presets, cleaning, 2-second fit, levels and mp3 encoder), so library and generated clips cannot be told apart.

    uv run python tools/build_library.py                    # PROVIDER=fake by default: placeholder clips, no credits
    GRADIUM_API_KEY=... uv run python tools/build_library.py --provider gradium
    uv run python tools/build_library.py --check            # files present, <= 2 s, fields filled

Input:  library/lines.json   [{"text": "Trop tard !", "emotion": "angry", "voiceId": "<optional>"}, ...]
Output: library/clips/<uuid>.mp3 and library/manifest.json. Ids are UUID v4 drawn once per (text, emotion) and kept
across rebuilds, so ids already dealt stay valid. Existing clips are not regenerated unless --force.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid
from pathlib import Path

from audio_service import audio
from audio_service.emotion import EmotionMapper, guess_language, length_padding
from audio_service.errors import ApiError
from audio_service.main import make_provider
from audio_service.settings import Settings
from audio_service.textguard import TextGuard

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "library"


def load_manifest() -> list[dict]:
    path = LIB / "manifest.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def save_manifest(entries: list[dict]) -> None:
    (LIB / "manifest.json").write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def check(entries: list[dict]) -> int:
    errors = 0
    for e in entries:
        path = LIB / e["file"]
        if not path.exists():
            print(f"missing file {e['file']}"); errors += 1; continue
        dur = audio.decode_duration_s(path.read_bytes())
        if dur > 2.0:
            print(f"{e['id']} lasts {dur:.3f} s"); errors += 1
        for field in ("text", "emotion", "voice_id"):
            if not e.get(field):
                print(f"{e['id']} has no {field}"); errors += 1
    print(f"{len(entries)} clips, {errors} problem(s)")
    return errors


async def build(provider_name: str, force: bool) -> None:
    settings = Settings(provider=provider_name)
    provider = make_provider(settings)
    mapper, guard = EmotionMapper(settings.config_dir), TextGuard(settings.config_dir / "blocklist.txt")
    lines = json.loads((LIB / "lines.json").read_text(encoding="utf-8"))
    entries = {(e["text"], e["emotion"]): e for e in load_manifest()}
    (LIB / "clips").mkdir(exist_ok=True)
    await provider.start()
    try:
        for line in lines:
            key = (line["text"], line["emotion"])
            old = entries.get(key)
            if old and (LIB / old["file"]).exists() and not force:
                continue
            try:
                spoken = guard.clean(line["text"])
                guard.check_blocked(line["text"], line["emotion"])
            except ApiError as exc:
                print(f"skip {line['text']!r}: {exc.code}"); continue
            preset = mapper.preset_for(line["emotion"])
            voice = line.get("voiceId") or preset.voice_for(guess_language(spoken))
            padding = max(-4.0, min(4.0, preset.padding_bonus + length_padding(len(spoken))))
            syn = await provider.synthesize(spoken, voice, preset.temp, padding)
            out = audio.process(syn.pcm16, syn.sample_rate, syn.words)
            clip_id = old["id"] if old else str(uuid.uuid4())
            (LIB / "clips" / f"{clip_id}.mp3").write_bytes(audio.encode_mp3(out.samples, out.sample_rate))
            entries[key] = {"id": clip_id, "file": f"clips/{clip_id}.mp3", "text": line["text"],
                            "emotion": line["emotion"], "voice_id": voice, "model": syn.model,
                            "duration_ms": round(out.duration_s * 1000), "truncated": out.truncated,
                            "deal": line.get("deal", True), "enabled": line.get("enabled", True)}
            print(f"{clip_id}  {out.duration_s:.2f}s  {syn.model:>16}  {line['emotion']:<12} {line['text']}")
    finally:
        await provider.close()
    save_manifest(sorted(entries.values(), key=lambda e: e["id"]))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--provider", default="fake", choices=["fake", "gradium"])
    ap.add_argument("--force", action="store_true", help="regenerate clips that already exist")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    if args.check:
        sys.exit(1 if check(load_manifest()) else 0)
    asyncio.run(build(args.provider, args.force))
    sys.exit(1 if check(load_manifest()) else 0)


if __name__ == "__main__":
    main()
