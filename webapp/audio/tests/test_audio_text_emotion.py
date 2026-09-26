import io

import numpy as np
import pytest

from audio_service import audio
from audio_service.audio import Word
from audio_service.emotion import EmotionMapper, guess_language
from audio_service.errors import ApiError
from audio_service.settings import PACKAGE_ROOT
from audio_service.textguard import TextGuard

SR = 24000


def speech(seconds: float, lead: float = 0.1) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    x = 0.3 * np.sin(2 * np.pi * 200 * t)
    x[: int(lead * SR)] = 0
    return (x * 32767).astype(np.int16)


def test_long_audio_is_cut_at_a_word_boundary():
    words = [Word(f"w{i}", 0.1 + 0.4 * i, 0.1 + 0.4 * (i + 1)) for i in range(9)]  # 3.6 s of words
    out = audio.process(speech(3.7), SR, words)
    assert out.truncated and out.duration_s <= 2.0
    assert out.spoken_text == "w0 w1 w2 w3"  # w4 would end after 1.97 s once the lead silence is trimmed


def test_cut_without_timestamps_and_mp3_length():
    out = audio.process(speech(3.5), SR, [])
    assert out.truncated and out.duration_s <= 2.0
    assert audio.decode_duration_s(audio.encode_mp3(out.samples, SR)) <= 2.0


def test_silence_is_trimmed_and_level_capped():
    out = audio.process(speech(1.0, lead=0.3), SR, [])
    assert out.duration_s < 0.8
    assert np.max(np.abs(out.samples)) <= 10 ** (-1 / 20) + 1e-6


@pytest.fixture
def guard():
    return TextGuard(PACKAGE_ROOT / "config" / "blocklist.txt")


def test_clean_keeps_typographic_apostrophe(guard):
    assert guard.clean("l’eau  «oui»  —  vite") == "l'eau oui - vite"


def test_clean_rejects_digits_and_empty(guard):
    with pytest.raises(ApiError) as e:
        guard.clean("1234567")
    assert e.value.code == "text_has_digits"
    with pytest.raises(ApiError) as e:
        guard.clean("?!")
    assert e.value.code == "text_empty"


def test_tags_cannot_reach_gradium(guard):
    cleaned = guard.clean('Salut <break time="deux" /> toi')
    assert "<" not in cleaned and ">" not in cleaned


def test_language_guess():
    assert guess_language("Où est passé mon sandwich ?") == "fr"
    assert guess_language("C'est trop tard") == "fr"
    assert guess_language("Is anyone there?") == "en"


def test_emotion_mapping():
    m = EmotionMapper(PACKAGE_ROOT / "config")
    assert m.preset_for("En colère").id == "intense"
    assert m.preset_for("JOYFUL").id == "joyful"
    assert m.preset_for("très triste").id == "calm"
    assert m.preset_for("zzz inconnu").id == m.default
