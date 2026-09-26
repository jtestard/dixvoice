"""Prototype written during planning, tested only against a local fake of Gradium, never against the
real API. To adapt before J2: output_format pcm_24000 and a rest_ndjson transport (plan §9.2).

Gradium latency / duration probe for 2-second voice clips (Dixvoice audio microservice).

Measures, per model (default vs gradium-tts-beta) and per transport:
  ws_cold   : new WebSocket per clip (connect + setup + text + eos sent back to back)
  ws_warm   : one persistent multiplexed WebSocket (close_ws_on_eos=false, client_req_id)
  ws_preset : same warm socket, but setup sent and `ready` received BEFORE the text is known
  rest      : POST /post/speech/tts, only_audio=true, HTTPS connection kept alive
and reports connect time, setup->ready, text->first audio, perceived TTFA (+ leading silence),
total time, audio duration, speech span, characters per second of speech.

Usage (Python >= 3.9, deps: websockets numpy):
    export GRADIUM_API_KEY=...            # never commit it
    python gradium_probe.py --n 3
    python gradium_probe.py --n 3 --padding=-2,-1,0 --transports ws_warm   # speed calibration
Cost estimate: 1 credit per character; printed before running.
Writes WAV files and results.jsonl into ./probe_out/ .
"""
import argparse
import asyncio
import base64
import http.client
import json
import os
import ssl
import statistics
import sys
import time
import urllib.parse
import uuid
import wave

import numpy as np
import websockets

SR = 48000  # output_format "pcm" = 48 kHz, 16-bit signed, mono (docs: guides/limits)

TEXTS = [
    ("en", "YTpq7expH9539ERJ", "Who ate my sandwich?!"),
    ("en", "YTpq7expH9539ERJ", "Houston, we have a problem."),
    ("en", "YTpq7expH9539ERJ", "I told you not to press the red button!"),
    ("fr", "YhIHaAfQ0cQPDV9R", "Bonjour, je suis ton père."),
    ("fr", "YhIHaAfQ0cQPDV9R", "Mais qui a mangé mon fromage ?!"),
    ("fr", "YhIHaAfQ0cQPDV9R", "Attention, le chat est sur la table !"),
]


def now():
    return time.perf_counter()


def silence_bounds(pcm16, sr=SR, frame_s=0.010, thresh=0.01):
    """Leading / trailing silence (s): first/last 10 ms frame whose mean-removed RMS > thresh."""
    x = pcm16.astype(np.float32) / 32768.0
    n = int(sr * frame_s)
    if len(x) < n:
        return None, None
    frames = x[: len(x) // n * n].reshape(-1, n)
    frames = frames - frames.mean(axis=1, keepdims=True)
    rms = np.sqrt((frames ** 2).mean(axis=1))
    loud = np.nonzero(rms > thresh)[0]
    if len(loud) == 0:
        return None, None
    lead = loud[0] * frame_s
    tail = (len(frames) - 1 - loud[-1]) * frame_s
    return lead, tail


def summarize(rec):
    pcm = np.frombuffer(rec.pop("_pcm"), dtype=np.int16)
    rec["audio_s"] = round(len(pcm) / SR, 3)
    lead, tail = silence_bounds(pcm)
    rec["lead_silence_s"] = None if lead is None else round(lead, 3)
    rec["tail_silence_s"] = None if tail is None else round(tail, 3)
    if lead is not None:
        speech = rec["audio_s"] - lead - tail
        rec["speech_s"] = round(speech, 3)
        rec["chars_per_speech_s"] = round(len(rec["text"]) / speech, 1) if speech > 0 else None
        if rec.get("first_audio_ms") is not None:
            rec["perceived_ttfa_ms"] = round(rec["first_audio_ms"] + 1000 * lead, 1)
    return pcm


def save_wav(path, pcm):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


class Api:
    def __init__(self, base, key):
        u = urllib.parse.urlparse(base.rstrip("/"))
        self.https = u.scheme == "https"
        self.host, self.port, self.prefix = u.hostname, u.port, u.path  # prefix e.g. /api
        self.ws_url = ("wss" if self.https else "ws") + "://" + u.netloc + self.prefix + "/speech/tts"
        self.key = key
        self._rest = None

    # ------------------------------------------------------------------ REST
    def rest_once(self, setup, text):
        if self._rest is None:
            if self.https:
                self._rest = http.client.HTTPSConnection(self.host, self.port or 443,
                                                         context=ssl.create_default_context(), timeout=30)
            else:
                self._rest = http.client.HTTPConnection(self.host, self.port or 80, timeout=30)
        body = {"text": text, "voice_id": setup["voice_id"], "output_format": "pcm",
                "model_name": setup["model_name"], "only_audio": True}
        if setup.get("json_config"):
            body["json_config"] = json.dumps(setup["json_config"])  # string form, as the SDK sends it
        t0 = now()
        try:
            self._rest.request("POST", self.prefix + "/post/speech/tts", body=json.dumps(body),
                               headers={"x-api-key": self.key, "Content-Type": "application/json"})
            resp = self._rest.getresponse()
        except (http.client.HTTPException, OSError):
            self._rest.close()
            self._rest = None
            raise
        t_head = now()
        first = resp.read(1)
        t_first = now()
        rest = resp.read()
        t_end = now()
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status}: {(first + rest)[:300]!r}")
        return {"headers_ms": round(1000 * (t_head - t0), 1),
                "first_audio_ms": round(1000 * (t_first - t0), 1),
                "total_ms": round(1000 * (t_end - t0), 1),
                "residency": resp.getheader("x-gradium-residency"),
                "_pcm": first + rest}

    # ------------------------------------------------------------ WebSocket cold
    async def ws_cold(self, setup, text):
        t0 = now()
        async with websockets.connect(self.ws_url, additional_headers={"x-api-key": self.key},
                                      max_size=None) as ws:
            t_conn = now()
            msg = {"type": "setup", **setup}
            if msg.get("json_config"):
                msg["json_config"] = json.dumps(msg["json_config"])
            await ws.send(json.dumps(msg))
            await ws.send(json.dumps({"type": "text", "text": text}))
            await ws.send(json.dumps({"type": "end_of_stream"}))
            t_sent = now()
            rec = {"connect_ms": round(1000 * (t_conn - t0), 1)}
            chunks, words = [], []
            t_first = None
            async for raw in ws:
                m = json.loads(raw)
                ty = m.get("type")
                if ty == "ready":
                    rec["ready_ms"] = round(1000 * (now() - t_sent), 1)
                    rec.update({k: m.get(k) for k in ("model_ext", "residency", "request_id")})
                elif ty == "audio":
                    if t_first is None:
                        t_first = now()
                    chunks.append(base64.b64decode(m["audio"]))
                elif ty == "text":
                    words.append((m.get("text"), m.get("start_s"), m.get("stop_s")))
                elif ty == "end_of_stream":
                    break
                elif ty == "error":
                    raise RuntimeError(m)
            t_end = now()
        rec["first_audio_ms"] = None if t_first is None else round(1000 * (t_first - t_sent), 1)
        rec["first_audio_incl_connect_ms"] = None if t_first is None else round(1000 * (t_first - t0), 1)
        rec["total_ms"] = round(1000 * (t_end - t_sent), 1)
        rec["words"] = words
        rec["_pcm"] = b"".join(chunks)
        return rec


class WarmSocket:
    """One persistent multiplexed TTS socket; responses routed by client_req_id."""

    def __init__(self, api):
        self.api = api
        self.ws = None
        self.queues = {}
        self.reader = None

    async def open(self):
        t0 = now()
        self.ws = await websockets.connect(self.api.ws_url, additional_headers={"x-api-key": self.api.key},
                                           max_size=None, ping_interval=20)
        self.reader = asyncio.ensure_future(self._read())
        return round(1000 * (now() - t0), 1)

    async def _read(self):
        try:
            async for raw in self.ws:
                m = json.loads(raw)
                q = self.queues.get(m.get("client_req_id"))
                if q is not None:
                    q.put_nowait((now(), m))
                elif m.get("type") == "error":
                    print("socket-level error:", m, file=sys.stderr)
        except websockets.ConnectionClosed as e:
            for q in self.queues.values():
                q.put_nowait((now(), {"type": "error", "message": f"closed {e}"}))

    async def request(self, setup, text, preset=False):
        rid = uuid.uuid4().hex[:12]
        q = self.queues[rid] = asyncio.Queue()
        msg = {"type": "setup", **setup, "close_ws_on_eos": False, "client_req_id": rid}
        if msg.get("json_config"):
            msg["json_config"] = json.dumps(msg["json_config"])
        rec = {}
        t_setup = now()
        await self.ws.send(json.dumps(msg))
        if preset:  # setup done ahead of time: wait for ready, then start the clock at text
            t, m = await q.get()
            if m.get("type") != "ready":
                raise RuntimeError(m)
            rec["ready_ms"] = round(1000 * (t - t_setup), 1)
            rec.update({k: m.get(k) for k in ("model_ext", "residency", "request_id")})
        t_sent = now()
        await self.ws.send(json.dumps({"type": "text", "text": text, "client_req_id": rid}))
        await self.ws.send(json.dumps({"type": "end_of_stream", "client_req_id": rid}))
        chunks, words, t_first = [], [], None
        while True:
            t, m = await q.get()
            ty = m.get("type")
            if ty == "ready":
                rec["ready_ms"] = round(1000 * (t - t_setup), 1)
                rec.update({k: m.get(k) for k in ("model_ext", "residency", "request_id")})
            elif ty == "audio":
                t_first = t_first or t
                chunks.append(base64.b64decode(m["audio"]))
            elif ty == "text":
                words.append((m.get("text"), m.get("start_s"), m.get("stop_s")))
            elif ty == "end_of_stream":
                break
            elif ty == "error":
                del self.queues[rid]
                raise RuntimeError(m)
        del self.queues[rid]
        rec["first_audio_ms"] = None if t_first is None else round(1000 * (t_first - t_sent), 1)
        rec["total_ms"] = round(1000 * (t - t_sent), 1)
        rec["words"] = words
        rec["_pcm"] = b"".join(chunks)
        return rec

    async def close(self):
        if self.ws is not None:
            try:
                await self.ws.send(json.dumps({"type": "end_of_stream"}))
            except Exception:
                pass
            await self.ws.close()
        if self.reader is not None:
            self.reader.cancel()


def fmt(v):
    return "-" if v is None else f"{v:.0f}"


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="https://api.gradium.ai/api")
    ap.add_argument("--rest-base-url", default=None, help="testing only: REST base if different")
    ap.add_argument("--models", default="default,gradium-tts-beta")
    ap.add_argument("--transports", default="ws_cold,ws_warm,ws_preset,rest")
    ap.add_argument("--padding", default="", help="comma list of padding_bonus values, e.g. -2,-1,0")
    ap.add_argument("--temp", type=float, default=None)
    ap.add_argument("--n", type=int, default=3, help="repetitions per (model, transport, text)")
    ap.add_argument("--out", default="probe_out")
    ap.add_argument("--yes", action="store_true", help="skip the cost confirmation")
    a = ap.parse_args()

    key = os.environ.get("GRADIUM_API_KEY")
    if not key:
        sys.exit("set GRADIUM_API_KEY")
    models = [m for m in a.models.split(",") if m]
    transports = [t for t in a.transports.split(",") if t]
    paddings = [float(p) for p in a.padding.split(",") if p != ""] or [None]
    n_req = len(models) * len(transports) * len(paddings) * a.n * len(TEXTS)
    chars = len(models) * len(transports) * len(paddings) * a.n * sum(len(t) for *_, t in TEXTS)
    print(f"{n_req} requests, ~{chars} characters = ~{chars} credits (1 credit/char, docs: guides/credits)")
    if not a.yes and input("continue? [y/N] ").strip().lower() != "y":
        return
    os.makedirs(a.out, exist_ok=True)
    api = Api(a.base_url, key)
    if a.rest_base_url:  # local mock testing: REST served on another port
        ra = Api(a.rest_base_url, key)
        api.https, api.host, api.port, api.prefix = ra.https, ra.host, ra.port, ra.prefix
        api.ws_url = Api(a.base_url, key).ws_url
    results = []
    out = open(os.path.join(a.out, "results.jsonl"), "a")

    warm = None
    if {"ws_warm", "ws_preset"} & set(transports):
        warm = WarmSocket(api)
        print(f"warm socket connect: {await warm.open()} ms")

    for model in models:
        for pad in paddings:
            for tr in transports:
                for i in range(a.n):
                    for lang, voice, text in TEXTS:
                        setup = {"model_name": model, "voice_id": voice, "output_format": "pcm"}
                        cfg = {}
                        if pad is not None:
                            cfg["padding_bonus"] = pad
                        if a.temp is not None:
                            cfg["temp"] = a.temp
                        if cfg:
                            setup["json_config"] = cfg
                        try:
                            if tr == "rest":
                                rec = await asyncio.get_running_loop().run_in_executor(
                                    None, api.rest_once, setup, text)
                            elif tr == "ws_cold":
                                rec = await api.ws_cold(setup, text)
                            else:
                                rec = await warm.request(setup, text, preset=(tr == "ws_preset"))
                        except Exception as e:  # keep going, record the failure
                            rec = {"error": str(e)[:300], "_pcm": b""}
                            if tr in ("ws_warm", "ws_preset"):
                                await warm.close()
                                warm = WarmSocket(api)
                                await warm.open()
                        rec.update({"model": model, "transport": tr, "padding_bonus": pad, "lang": lang,
                                    "voice_id": voice, "text": text, "rep": i})
                        pcm = summarize(rec) if "error" not in rec else None
                        if pcm is not None and len(pcm) and i == 0:
                            name = f"{model}_{tr}_{pad}_{lang}_{TEXTS.index((lang, voice, text))}.wav"
                            save_wav(os.path.join(a.out, name), pcm)
                        out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                        out.flush()
                        results.append(rec)
                        print(f"{model:18} {tr:9} pad={pad} {lang} ttfa={fmt(rec.get('first_audio_ms'))}ms "
                              f"perceived={fmt(rec.get('perceived_ttfa_ms'))}ms total={fmt(rec.get('total_ms'))}ms "
                              f"audio={rec.get('audio_s')}s lead={rec.get('lead_silence_s')} "
                              f"cps={rec.get('chars_per_speech_s')} {rec.get('error', '')}")
    if warm is not None:
        await warm.close()

    print("\n=== medians (ms) ===")
    print(f"{'model':18} {'transport':9} {'pad':>5} {'n':>3} {'conn':>6} {'ready':>6} {'1st':>6} {'perc':>6} "
          f"{'total':>6} {'lead_s':>6} {'cps_en':>6} {'cps_fr':>6} {'err':>3}")
    for model in models:
        for pad in paddings:
            for tr in transports:
                rs = [r for r in results if r["model"] == model and r["transport"] == tr
                      and r["padding_bonus"] == pad]
                ok = [r for r in rs if "error" not in r]

                def med(k, rows=ok):
                    v = [r[k] for r in rows if r.get(k) is not None]
                    return statistics.median(v) if v else None
                print(f"{model:18} {tr:9} {str(pad):>5} {len(rs):>3} {fmt(med('connect_ms')):>6} {fmt(med('ready_ms')):>6} "
                      f"{fmt(med('first_audio_ms')):>6} {fmt(med('perceived_ttfa_ms')):>6} "
                      f"{fmt(med('total_ms')):>6} {str(med('lead_silence_s')):>6} "
                      f"{str(med('chars_per_speech_s', [r for r in ok if r['lang'] == 'en'])):>6} "
                      f"{str(med('chars_per_speech_s', [r for r in ok if r['lang'] == 'fr'])):>6} "
                      f"{len(rs) - len(ok):>3}")


if __name__ == "__main__":
    asyncio.run(main())
