"""Render a two-host episode script to audio with local Kokoro TTS.

Script format: lines like `MARA: text` / `THEO: text`. `## ` headings mark
segments (a short pause is inserted). `[DEEPER: ...]` and other bracketed
stage directions are dropped. A line ending in an em-dash is an interruption:
the next speaker comes in slightly before the cut line finishes.
"""
import argparse
import re
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

SR = 24000
VOICES = {
    # Mara: calm, precise, deadpan. Theo: warm, fast, thinks out loud.
    "MARA": {"voice": "af_heart", "speed": 1.0},
    "THEO": {"voice": "am_michael", "speed": 1.08},
}
GAP = 0.28          # seconds of silence between ordinary turns
SEGMENT_GAP = 1.1   # silence at a section heading
OVERLAP = 0.35      # how far the interrupter steps on a cut-off line
LINE_RE = re.compile(r"^(MARA|THEO):\s*(.+)$")


def parse(script: str):
    """Yield ("segment", title) and ("line", speaker, text, cut_off)."""
    for raw in script.splitlines():
        s = raw.strip()
        if s.startswith("## "):
            yield ("segment", s[3:])
            continue
        m = LINE_RE.match(s)
        if not m:
            continue
        speaker, text = m.groups()
        text = re.sub(r"\[[^\]]*\]", "", text).strip()   # [laughs] etc.
        cut = text.endswith("—")
        text = text.rstrip("—").strip()
        text = text.replace("—", ", ").replace("*", "")
        if text:
            yield ("line", speaker, text, cut)


def trim(audio, thresh=0.01):
    idx = np.where(np.abs(audio) > thresh)[0]
    if len(idx) == 0:
        return audio
    return audio[max(idx[0] - 240, 0): idx[-1] + 480]


def render(script_path: Path, out_path: Path, model: Path, voices: Path, stop_at: str | None):
    tts = Kokoro(str(model), str(voices))
    timeline = np.zeros(0, dtype=np.float32)
    cursor = 0  # sample where the next clip starts
    first = True
    for item in parse(script_path.read_text()):
        if item[0] == "segment":
            if stop_at and item[1].upper().startswith(stop_at.upper()):
                break
            if not first:
                cursor += int(SEGMENT_GAP * SR)
            continue
        _, speaker, text, cut = item
        cfg = VOICES[speaker]
        clip, _ = tts.create(text, voice=cfg["voice"], speed=cfg["speed"], lang="en-us")
        clip = trim(clip.astype(np.float32))
        end = cursor + len(clip)
        if end > len(timeline):
            timeline = np.concatenate([timeline, np.zeros(end - len(timeline), dtype=np.float32)])
        timeline[cursor:end] += clip
        first = False
        print(f"{speaker}: {text[:70]}")
        cursor = end - int(OVERLAP * SR) if cut else end + int(GAP * SR)
    peak = np.max(np.abs(timeline)) or 1.0
    timeline = timeline / peak * 0.89
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(out_path, timeline, SR)
    print(f"wrote {out_path} ({len(timeline) / SR / 60:.1f} min)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("script", type=Path)
    ap.add_argument("out", type=Path, help=".wav output")
    ap.add_argument("--model", type=Path, default=Path("models/kokoro-v1.0.onnx"))
    ap.add_argument("--voices", type=Path, default=Path("models/voices-v1.0.bin"))
    ap.add_argument("--stop-at", help="stop before the section whose heading starts with this")
    a = ap.parse_args()
    render(a.script, a.out, a.model, a.voices, a.stop_at)
