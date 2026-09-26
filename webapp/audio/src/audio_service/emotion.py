"""Free-text emotion -> how the line is delivered: a Gradium voice (from the emotion's preset and the language of the
text) plus a temperature and a speed (from the emotion's excitement level). Internal detail, not part of the
contract: only the chosen voice leaves the service, in the voiceId field."""

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

    def voice_for(self, language: str) -> str:
        return self.voice_fr if language == "fr" else self.voice_en


@dataclass(frozen=True)
class Delivery:
    preset: str
    voice_id: str
    language: str
    level: float  # excitement, 0 = very calm, 1 = very excited
    temp: float
    padding_bonus: float


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


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


class EmotionMapper:
    def __init__(self, config_dir: Path):
        presets = json.loads((config_dir / "presets.json").read_text(encoding="utf-8"))
        self.presets = {p["id"]: Preset(p["id"], p["voice_fr"], p["voice_en"]) for p in presets["presets"]}
        self.default = presets["default"]
        d = presets["delivery"]
        self.temp_calm, self.temp_excited = d["temp_calm"], d["temp_excited"]
        self.padding_calm, self.padding_excited = d["padding_calm"], d["padding_excited"]
        self.unknown_level, self.exclamation_bonus = d["unknown_level"], d["exclamation_bonus"]

        table = json.loads((config_dir / "emotions.json").read_text(encoding="utf-8"))
        self.modifiers = {normalize_word_key(k): v for k, v in table.get("_modifiers", {}).items() if not k.startswith("_")}
        self.words: dict[str, tuple[str, float]] = {}
        for preset_id, words in table.items():
            if preset_id.startswith("_"):
                continue
            if preset_id not in self.presets:
                raise ValueError(f"emotions.json points to unknown preset {preset_id!r}")
            for word, level in words.items():
                if not 0.0 <= level <= 1.0:
                    raise ValueError(f"level of {word!r} must be between 0 and 1")
                self.words[normalize_word_key(word)] = (preset_id, level)

    def _match(self, emotion: str) -> tuple[Preset, float | None]:
        """The preset and base level of the emotion: the whole text first, then word by word; (default, None) if
        no word is known."""
        key = normalize_word_key(emotion)
        found = self.words.get(key)
        if found is None:
            found = next((self.words[t] for t in key.split() if t in self.words), None)
        if found is None:
            return self.presets[self.default], None
        return self.presets[found[0]], found[1]

    def preset_for(self, emotion: str) -> Preset:
        return self._match(emotion)[0]

    def level(self, emotion: str, text: str = "") -> float:
        """Excitement level: the emotion word's level (or unknown_level), plus intensifiers such as "very" or
        "a bit" in the emotion, plus exclamation_bonus if "!" appears in the text or the emotion; kept in 0..1."""
        _, base = self._match(emotion)
        level = self.unknown_level if base is None else base
        padded = f" {normalize_word_key(emotion)} "
        level += sum(delta for word, delta in self.modifiers.items() if f" {word} " in padded)
        if "!" in text or "!" in emotion:
            level += self.exclamation_bonus
        return _clamp(level, 0.0, 1.0)

    def delivery(self, emotion: str, text: str, voice_override: str | None = None) -> Delivery:
        """How to speak `text` (already cleaned): voice, temperature and speed. Temperature and speed go linearly
        from the calm end (level 0) to the excited end (level 1); long texts are then sped up to fit in 2 s."""
        preset = self.preset_for(emotion)
        level = self.level(emotion, text)
        language = guess_language(text)
        temp = self.temp_calm + (self.temp_excited - self.temp_calm) * level
        padding = self.padding_calm + (self.padding_excited - self.padding_calm) * level + length_padding(len(text))
        return Delivery(preset.id, voice_override or preset.voice_for(language), language, round(level, 3),
                        round(temp, 3), round(_clamp(padding, -4.0, 4.0), 3))

    def all_voice_ids(self) -> set[str]:
        return {v for p in self.presets.values() for v in (p.voice_fr, p.voice_en)}
