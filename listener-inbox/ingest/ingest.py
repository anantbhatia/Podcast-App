#!/usr/bin/env python3
"""Pull new listener notes from the inbox worker, transcribe voice notes, save them.

Each note becomes <out>/<id>.json with the listener's text plus a transcript.
After a note is saved, it is marked done on the worker so it isn't pulled again.
Transcription runs locally with faster-whisper, so it costs nothing per note.

Usage:
  INBOX_URL=https://hpm-listener-inbox.<account>.workers.dev INBOX_TOKEN=... \
    python3 ingest.py --out /mnt/project-files/listeners/inbox
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path


def api(base, token, path, method="GET"):
    req = urllib.request.Request(base.rstrip("/") + path, method=method,
                                 # Cloudflare blocks the default Python user agent, so name ourselves.
                                 headers={"authorization": f"Bearer {token}", "user-agent": "hpm-ingest/1.0"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read()


def decode(raw_audio: bytes):
    """Decode any browser recording (webm, m4a, ogg, mp3) to 16 kHz mono floats."""
    import numpy as np
    pcm = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"],
        input=raw_audio, capture_output=True, check=True).stdout
    return np.frombuffer(pcm, np.int16).astype(np.float32) / 32768


_model = None


def transcribe(raw_audio: bytes, model_size: str):
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel(model_size, device="cpu", compute_type="int8")
    audio = decode(raw_audio)
    segments, info = _model.transcribe(audio, vad_filter=True)
    text = " ".join(s.text.strip() for s in segments).strip()
    return text, info.language, round(len(audio) / 16000, 1)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="/mnt/project-files/listeners/inbox")
    p.add_argument("--model", default="small")
    p.add_argument("--keep", action="store_true", help="don't mark notes done on the worker")
    args = p.parse_args()
    base, token = os.environ.get("INBOX_URL"), os.environ.get("INBOX_TOKEN")
    if not base or not token:
        sys.exit("Set INBOX_URL and INBOX_TOKEN.")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    items = json.loads(api(base, token, "/api/inbox"))["items"]
    print(f"{len(items)} new note(s)")
    for item in items:
        if item.get("audioKey"):
            try:
                text, lang, seconds = transcribe(api(base, token, f"/api/audio/{item['id']}"), args.model)
                item.update(transcript=text, language=lang, audioSeconds=seconds)
            except Exception as e:  # keep the note; a person can listen to it instead
                item.update(transcript=None, transcribeError=str(e)[:300])
        dest = out / f"{item['id']}.json"
        dest.write_text(json.dumps(item, indent=2, ensure_ascii=False))
        if not args.keep:
            api(base, token, f"/api/done/{item['id']}", method="POST")
        print(f"saved {dest.name} ({item['kind']}, {'voice' if item.get('audioKey') else 'text'})")


if __name__ == "__main__":
    main()
