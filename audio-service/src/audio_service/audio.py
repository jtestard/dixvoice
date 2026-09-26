"""Post-processing of a synthesized voice: trim silences, fit in 2 s (cut at a word boundary), fade, level, mp3."""

from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
import soundfile as sf

FRAME_S = 0.010
SILENCE_DBFS = -45.0
MARGIN_S = 0.020
FADE_OUT_S = 0.030
FADE_IN_S = 0.005
TARGET_RMS_DBFS = -20.0  # to calibrate against the library once (plan §4.4)
PEAK_DBFS = -1.0


@dataclass
class Word:
    text: str
    start_s: float
    stop_s: float


@dataclass
class Processed:
    samples: np.ndarray  # float32, mono
    sample_rate: int
    truncated: bool
    spoken_text: str | None  # words kept when the clip was cut on a word boundary

    @property
    def duration_s(self) -> float:
        return len(self.samples) / self.sample_rate


def _frame_db(x: np.ndarray, sr: int) -> np.ndarray:
    n = max(1, int(sr * FRAME_S))
    frames = len(x) // n
    if frames == 0:
        return np.array([-120.0])
    rms = np.sqrt(np.mean(x[: frames * n].reshape(frames, n) ** 2, axis=1) + 1e-12)
    return 20 * np.log10(rms)


def trim_silence(x: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
    """Removes leading and trailing silence; returns the audio and the seconds removed at the start."""
    db = _frame_db(x, sr)
    loud = np.nonzero(db > SILENCE_DBFS)[0]
    if len(loud) == 0:
        return x, 0.0
    n = int(sr * FRAME_S)
    margin = int(sr * MARGIN_S)
    start = max(0, loud[0] * n - margin)
    stop = min(len(x), (loud[-1] + 1) * n + margin)
    return x[start:stop], start / sr


def _quietest_cut(x: np.ndarray, sr: int, lo_s: float, hi_s: float) -> int:
    n = int(sr * FRAME_S)
    lo, hi = int(lo_s * sr), min(int(hi_s * sr), len(x))
    best, best_energy = hi, None
    for i in range(lo, max(lo + 1, hi - n), n):
        e = float(np.mean(x[i:i + n] ** 2))
        if best_energy is None or e < best_energy:
            best, best_energy = i + n // 2, e
    return best


def fit(x: np.ndarray, sr: int, words: list[Word], lead_trim_s: float, max_s: float) -> tuple[np.ndarray, bool, str | None]:
    """Cuts at the end of the last whole word before max_s - 30 ms; without timestamps, at the quietest 10 ms."""
    if len(x) <= int(max_s * sr):
        return x, False, None
    limit = max_s - 0.030
    kept = [w for w in words if w.stop_s - lead_trim_s <= limit and w.stop_s > lead_trim_s]
    if kept:
        cut = int(min(max_s, kept[-1].stop_s - lead_trim_s + MARGIN_S) * sr)
        spoken = " ".join(w.text for w in kept)
    else:
        cut = _quietest_cut(x, sr, max_s * 0.8, max_s)
        spoken = None
    return x[:cut], True, spoken


def level(x: np.ndarray) -> np.ndarray:
    rms = float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0
    if rms < 1e-6:
        return x
    y = x * (10 ** (TARGET_RMS_DBFS / 20) / rms)
    peak = float(np.max(np.abs(y)))
    ceiling = 10 ** (PEAK_DBFS / 20)
    if peak > ceiling:
        y = y * (ceiling / peak)
    return y


def fades(x: np.ndarray, sr: int) -> np.ndarray:
    y = x.copy()
    n_in, n_out = min(len(y), int(sr * FADE_IN_S)), min(len(y), int(sr * FADE_OUT_S))
    if n_in:
        y[:n_in] *= np.linspace(0.0, 1.0, n_in, dtype=np.float32)
    if n_out:
        y[-n_out:] *= np.linspace(1.0, 0.0, n_out, dtype=np.float32)
    return y


def process(pcm16: np.ndarray, sr: int, words: list[Word], max_s: float = 2.0) -> Processed:
    x = pcm16.astype(np.float32) / 32768.0
    x, lead = trim_silence(x, sr)
    x, truncated, spoken = fit(x, sr, words, lead, max_s)
    x = fades(level(x), sr)
    x = x[: int(max_s * sr)]  # absolute ceiling
    return Processed(x.astype(np.float32), sr, truncated, spoken)


def encode_mp3(x: np.ndarray, sr: int) -> bytes:
    """MP3 mono VBR with a LAME/Xing header: decodes to the exact length in Chromium and Safari (plan §2)."""
    buf = io.BytesIO()
    sf.write(buf, x, sr, format="MP3", subtype="MPEG_LAYER_III", bitrate_mode="VARIABLE", compression_level=0.5)
    return buf.getvalue()


def decode_duration_s(mp3: bytes) -> float:
    info = sf.info(io.BytesIO(mp3))
    return info.frames / info.samplerate
