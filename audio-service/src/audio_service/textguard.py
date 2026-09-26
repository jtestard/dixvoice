"""Cleans the text before it is sent to Gradium, and rejects what cannot become a 2-second clip."""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

from .errors import ApiError

_TYPOGRAPHIC = str.maketrans({
    "’": "'", "‘": "'", "ʼ": "'", "´": "'",
    "«": '"', "»": '"', "“": '"', "”": '"',
    "–": "-", "—": "-", " ": " ", " ": " ",
})
# Letters of any alphabet, spaces and a little punctuation. "<" and ">" are dropped, so a player cannot slip
# a Gradium tag such as <break time="2.0s"/> into the text.
_KEEP = re.compile(r"[^\w\s.,!?'\-…:;]|_")
_SPACES = re.compile(r"\s+")


def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def normalize_word_key(s: str) -> str:
    """Lowercase, no accents, letters and spaces only: used for the blocklist and the emotion table."""
    s = strip_accents(unicodedata.normalize("NFC", s).translate(_TYPOGRAPHIC)).lower()
    return _SPACES.sub(" ", re.sub(r"[^a-z ]", " ", s)).strip()


class TextGuard:
    def __init__(self, blocklist_path: Path | None = None):
        self.blocked: set[str] = set()
        if blocklist_path and blocklist_path.exists():
            for line in blocklist_path.read_text(encoding="utf-8").splitlines():
                word = normalize_word_key(line.split("#", 1)[0])
                if word:
                    self.blocked.add(word)

    def clean(self, text: str) -> str:
        """Returns the text as it will be spoken, or raises a 400 ApiError."""
        s = unicodedata.normalize("NFC", text).translate(_TYPOGRAPHIC)
        s = "".join(c for c in s if unicodedata.category(c)[0] != "C")
        if any(c.isdigit() for c in s):
            raise ApiError(400, "text_has_digits", "Write numbers in words: digits are read out in full and do not fit in 2 seconds.")
        s = _SPACES.sub(" ", _KEEP.sub(" ", s)).strip()
        if not any(c.isalpha() for c in s):
            raise ApiError(400, "text_empty", "The text has no letters left after cleaning.")
        return s

    def check_blocked(self, *values: str) -> None:
        for value in values:
            words = normalize_word_key(value)
            padded = f" {words} "
            if any(f" {b} " in padded for b in self.blocked):
                raise ApiError(400, "text_rejected", "The text or the emotion contains a blocked word.")
