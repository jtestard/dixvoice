"""Free-text emotion -> internal preset (Gradium voice + settings). Internal detail, not part of the contract:
only the chosen voice leaves the service, in the voiceId field."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .textguard import normalize_word_key, strip_accents

_FRENCH_WORDS = {
    "le", "la", "les", "un", "une", "des", "du", "de", "je", "tu", "il", "elle", "on", "nous", "vous", "ils",
    "est", "et", "pas", "ne", "mon", "ma", "mes", "ton", "ta", "qui", "quoi", "ou", "oui", "non", "c", "j",
    "l", "d", "qu", "n", "s", "m", "t", "ce", "ca", "que", "au", "aux", "avec", "pour", "dans", "sur", "trop",
    "tard", "bonjour", "salut", "merci", "encore", "rien", "tout", "moi", "toi", "vite", "allez", "viens",
}
_FRENCH_LETTERS = set("éèêëàâùûüôîïçœæ")


@dataclass(frozen=True)
class Preset:
    id: str
    voice_fr: str
    voice_en: str
    temp: float
    padding_bonus: float

    def voice_for(self, language: str) -> str:
        return self.voice_fr if language == "fr" else self.voice_en


def guess_language(text: str) -> str:
    """'fr' or 'en', with no heavy dependency: accents, then French function words."""
    lowered = text.lower()
    if any(c in _FRENCH_LETTERS for c in lowered):
        return "fr"
    words = normalize_word_key(strip_accents(lowered).replace("'", " ")).split()
    french = sum(w in _FRENCH_WORDS for w in words)
    return "fr" if words and french * 3 >= len(words) else "en"


def length_padding(n_chars: int) -> float:
    """Extra speed (negative padding_bonus = faster) so that longer texts still fit in 2 s. To calibrate (plan §4.3)."""
    if n_chars <= 25:
        return 0.0
    if n_chars <= 32:
        return -1.0
    if n_chars <= 40:
        return -2.0
    if n_chars <= 50:
        return -3.0
    return -4.0


class EmotionMapper:
    def __init__(self, config_dir: Path):
        presets = json.loads((config_dir / "presets.json").read_text(encoding="utf-8"))
        self.presets = {p["id"]: Preset(p["id"], p["voice_fr"], p["voice_en"], p["temp"], p["padding_bonus"])
                        for p in presets["presets"]}
        self.default = presets["default"]
        table = json.loads((config_dir / "emotions.json").read_text(encoding="utf-8"))
        self.words: dict[str, str] = {}
        for preset_id, words in table.items():
            if preset_id.startswith("_"):
                continue
            if preset_id not in self.presets:
                raise ValueError(f"emotions.json points to unknown preset {preset_id!r}")
            for w in words:
                self.words[normalize_word_key(w)] = preset_id

    def preset_for(self, emotion: str) -> Preset:
        key = normalize_word_key(emotion)
        if key in self.words:
            return self.presets[self.words[key]]
        for token in key.split():
            if token in self.words:
                return self.presets[self.words[token]]
        return self.presets[self.default]

    def all_voice_ids(self) -> set[str]:
        return {v for p in self.presets.values() for v in (p.voice_fr, p.voice_en)}
