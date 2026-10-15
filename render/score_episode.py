"""Score an episode with a theme track, placed the way a tech-news show uses it.

The theme comes in quietly under the host intros, opens up in a pause right
after the title call, ducks and fades as the next line starts, and its last
seconds come back as a button at the end of the episode.

    python render/score_episode.py out/ep01.mp3 theme.mp3 --title-end 50.96 --out out/ep01_scored.mp3

At every story change a short transition plays in a pause of its own: a
slice of the same theme rises out of the last line, plays in the clear for
a couple of seconds, and ducks away under the next story's first line. The
title call and the transitions come from the `<voice>.cues.json` file that
render_elevenlabs.py writes next to the voice track (or from --title-end and
--transition by hand).

The theme can be anything with a steady groove and a clean ending; the
pilot uses a 15-second clip from ElevenLabs sound generation (the Music API
needs a paid plan), and render/theme_sting.py makes a synthesized fallback.
"""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100


def load(path: Path, tmp: str) -> np.ndarray:
    wav = Path(tmp) / (path.stem + ".wav")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(path), "-ac", "2",
                    "-ar", str(SR), str(wav)], check=True)
    return sf.read(wav)[0]


def rms_db(x: np.ndarray) -> float:
    loud = x[np.abs(x).max(axis=1) > 0.01]
    return 20 * np.log10(np.sqrt(np.mean(loud ** 2)) + 1e-9)


def ramp(n, points):
    """Piecewise-linear gain from [(second, gain), ...]."""
    x = np.arange(n) / SR
    secs, gains = zip(*points)
    return np.interp(x, secs, gains)[:, None]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("voice", type=Path)
    ap.add_argument("theme", type=Path)
    ap.add_argument("--title-end", type=float, help="second where the title call ends (default: from the cues file)")
    ap.add_argument("--transition", type=float, action="append", default=[], metavar="SECONDS",
                    help="second where a new story starts (default: from the cues file); repeatable")
    ap.add_argument("--cues", type=Path, help="cue file (default: <voice>.cues.json if it exists)")
    ap.add_argument("--sting", type=float, default=2.5, help="seconds a transition plays in the clear (0 = none)")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--lead", type=float, default=4.5, help="seconds of quiet bed before the title ends")
    ap.add_argument("--hold", type=float, default=4.0, help="seconds the theme plays in the clear")
    ap.add_argument("--outro", type=float, default=4.0, help="seconds of the theme's ending used as the closing button (0 = none)")
    ap.add_argument("--bed", type=float, default=-15.0, help="bed level under speech, dB relative to full")
    ap.add_argument("--level", type=float, default=-1.5, help="theme level relative to the voice, dB")
    a = ap.parse_args()
    cue_file = a.cues or a.voice.with_suffix(".cues.json")
    if cue_file.exists():
        cues = json.loads(cue_file.read_text())
        if a.title_end is None:
            a.title_end = next((c["at"] for c in cues if c["cue"] == "THEME HIT"), None)
        if not a.transition:
            a.transition = [c["at"] for c in cues if c["cue"] == "TRANSITION"]
    if a.title_end is None:
        raise SystemExit("no title call: pass --title-end or a cues file with a THEME HIT")

    with tempfile.TemporaryDirectory() as tmp:
        voice, theme = load(a.voice, tmp), load(a.theme, tmp)

    # Trim the theme's trailing silence and match it to the voice level.
    end = np.where(np.abs(theme).max(axis=1) > 0.003)[0][-1] + 1
    theme = theme[:end] * 10 ** ((rms_db(voice) + a.level - rms_db(theme)) / 20)
    bed = 10 ** (a.bed / 20)
    tail = 3.0  # seconds the theme keeps going (ducked, fading) under the next line

    need = a.lead + a.hold + tail
    if len(theme) / SR < need:
        raise SystemExit(f"theme is {len(theme) / SR:.1f} s; needs {need:.1f} s for these settings")

    # Open a pause after the title call and at each transition for the music
    # to play in, latest first so the earlier positions stay put.
    pauses = {a.title_end: a.hold}
    if a.sting > 0:
        pauses.update({t: a.sting for t in a.transition})
    for t in sorted(pauses, reverse=True):
        i = int(t * SR)
        voice = np.concatenate([voice[:i], np.zeros((int(pauses[t] * SR), 2)), voice[i:]])

    def shifted(t):  # where a point of the original voice track lands now
        return t + sum(d for p, d in pauses.items() if p < t)

    cut = int(shifted(a.title_end) * SR)

    intro = theme[: int(need * SR)] * ramp(int(need * SR), [
        (0, 0), (1.0, bed),                       # fade in under the intros
        (a.lead - 0.2, bed), (a.lead + 0.1, 1),   # open up on the title
        (a.lead + a.hold - 0.3, 1),
        (a.lead + a.hold + 0.2, bed * 1.5),       # duck for the next line
        (need, 0),
    ])
    start = cut - int(a.lead * SR)
    voice[start:start + len(intro)] += intro

    # Transitions: the theme's opening hit, rising out of the last line of the
    # story, in the clear through the pause, then ducking under the next one.
    if a.sting > 0:
        rise, duck = 0.8, 2.0
        length = rise + a.sting + duck
        start = max(0.0, a.lead - rise)  # so the pause lines up with the theme's hit
        sting = theme[int(start * SR): int((start + length) * SR)]
        sting = sting * ramp(len(sting), [
            (0, bed), (rise, 0.85),
            (rise + a.sting - 0.3, 0.85),
            (rise + a.sting + 0.2, bed),
            (length, 0),
        ])
        for t in a.transition:
            i = int((shifted(t) - rise) * SR)
            voice[i:i + len(sting)] += sting[: len(voice) - i]

    if a.outro > 0:
        button = theme[-int(a.outro * SR):] * ramp(int(a.outro * SR), [(0, 0), (0.4, 1), (a.outro, 1)])
        voice = np.concatenate([voice, np.zeros((int(0.4 * SR), 2)), button])

    voice /= max(1.0, np.abs(voice).max() / 0.95)
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "mixed.wav"
        sf.write(wav, voice, SR)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(wav), "-b:a", "160k",
                        str(a.out)], check=True)
    print(f"wrote {a.out} ({len(voice) / SR / 60:.2f} min)")


if __name__ == "__main__":
    main()
