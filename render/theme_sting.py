"""Synthesize the show's theme sting and mix it under the title call.

The sting is 112 bpm in D major: three quiet bars of plucked arpeggios and
brushed drums as a bed under the host intros, a marimba hook bar that lands
right after "This is Terms and Conditions", a button chord, then a soft pad
that fades under the first lines of the next section. Everything is
generated with numpy, so there are no samples or licenses to track.

    python render/theme_sting.py sting.wav                      # sting only
    python render/theme_sting.py sting.wav --mix ep.mp3 --title-end 50.96 --out ep_scored.mp3

`--title-end` is the second where the title call finishes; the hook starts
there and `--gap` seconds of room are opened in the voice track so the hook
plays in the clear.
"""
import argparse
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100
BPM = 112
BEAT = 60 / BPM
BAR = 4 * BEAT
BED_BARS = 3
rng = np.random.default_rng(7)


def hz(note: str) -> float:
    names = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6,
             "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
    name, octave = note[:-1], int(note[-1])
    return 440.0 * 2 ** ((names[name] + 12 * (octave + 1) - 69) / 12)


def t(n):
    return np.arange(int(n * SR)) / SR


def marimba(f, dur=0.6):
    x = t(dur)
    env = np.exp(-x * 7)
    tone = np.sin(2 * np.pi * f * x) + 0.25 * np.sin(2 * np.pi * 3.98 * f * x) * np.exp(-x * 30)
    return tone * env * np.minimum(x / 0.002, 1)


def pluck(f, dur=0.5):
    """Karplus-Strong string, damped like a palm-muted guitar."""
    n = int(dur * SR)
    period = int(SR / f)
    buf = rng.uniform(-1, 1, period)
    out = np.empty(n)
    for i in range(n):
        out[i] = buf[i % period]
        buf[i % period] = 0.494 * (buf[i % period] + buf[(i + 1) % period])
    return out * np.exp(-t(dur) * 5)


def bass(f, dur):
    x = t(dur)
    tone = np.tanh(1.6 * np.sin(2 * np.pi * f * x))
    return tone * np.minimum(x / 0.01, 1) * np.exp(-x * 2.5)


def kick():
    x = t(0.25)
    return np.sin(2 * np.pi * (50 + 90 * np.exp(-x * 30)) * x) * np.exp(-x * 14)


def brush(dur=0.18, decay=18):
    x = t(dur)
    noise = rng.normal(0, 1, len(x))
    noise = np.convolve(noise, np.ones(3) / 3, mode="same")  # take the hiss off
    return noise * np.exp(-x * decay) * 0.35


def pad(freqs, dur):
    x = t(dur)
    s = sum(np.sin(2 * np.pi * f * d * x) for f in freqs for d in (0.997, 1.003))
    s = np.convolve(s, np.ones(24) / 24, mode="same")
    env = np.minimum(x / 0.4, 1) * np.clip((dur - x) / (dur * 0.7), 0, 1)
    return s / (2 * len(freqs)) * env


def place(track, clip, at, gain=1.0):
    i = int(at * SR)
    j = min(i + len(clip), len(track))
    track[i:j] += clip[: j - i] * gain


def compose():
    """Return (stereo sting, seconds where the hook bar starts)."""
    hook_at = BED_BARS * BAR
    total = hook_at + BAR + BEAT + 4.5
    L = np.zeros(int(total * SR))
    R = np.zeros_like(L)

    chords = [("D3", "F#3", "A3", "D4"), ("B2", "D3", "F#3", "B3"),
              ("G2", "B2", "D3", "G3"), ("A2", "C#3", "E3", "A3")]
    roots = ["D2", "B1", "G1", "A1"]
    for b in range(BED_BARS + 1):
        bar0 = b * BAR
        notes = chords[b]
        for e in range(8):  # eighth-note arpeggio, panned left
            f = hz(notes[[0, 2, 1, 3, 2, 1, 3, 2][e]])
            place(L, pluck(f * 2), bar0 + e * BEAT / 2, 0.30)
            place(R, pluck(f * 2), bar0 + e * BEAT / 2, 0.12)
        for beat in (0, 2.5):
            place(L, bass(hz(roots[b]), BEAT * 1.4), bar0 + beat * BEAT, 0.32)
            place(R, bass(hz(roots[b]), BEAT * 1.4), bar0 + beat * BEAT, 0.32)
        for beat in range(4):
            if beat in (0, 2):
                place(L, kick(), bar0 + beat * BEAT, 0.45)
                place(R, kick(), bar0 + beat * BEAT, 0.45)
            else:
                place(L, brush(0.3, 9), bar0 + beat * BEAT, 0.5)
                place(R, brush(0.3, 9), bar0 + beat * BEAT, 0.5)
            for half in (0, 0.5):  # hats on eighths, panned right
                place(R, brush(0.05, 70), bar0 + (beat + half) * BEAT, 0.35)

    # The hook: a marimba run over the A chord that resolves on the button.
    riff = [("D5", 0), ("F#5", 0.5), ("A5", 1), ("B5", 1.5), ("A5", 2), ("F#5", 2.75), ("E5", 3.25)]
    for note, beat in riff:
        clip = marimba(hz(note))
        place(L, clip, hook_at + beat * BEAT, 0.42)
        place(R, clip, hook_at + beat * BEAT, 0.48)

    button = hook_at + BAR
    for note in ("D4", "F#4", "A4", "D5"):
        place(L, marimba(hz(note), 1.2), button, 0.28)
        place(R, marimba(hz(note), 1.2), button, 0.28)
    for ch in (L, R):
        place(ch, bass(hz("D2"), 1.2), button, 0.4)
        place(ch, kick(), button, 0.55)
        place(ch, brush(0.6, 6), button, 0.4)
        place(ch, pad([hz(n) for n in ("D3", "A3", "D4", "F#4")], total - button), button, 0.35)

    mix = np.stack([L, R], axis=1)
    mix /= np.max(np.abs(mix))
    return mix * 0.89, hook_at


def bed_gain(n_samples, hook_at, dur_after):
    """Quiet under speech, full for the hook bar and button, ducked again after."""
    x = np.arange(n_samples) / SR
    under = 0.22
    g = np.full(n_samples, under)
    g *= np.minimum(x / 1.5, 1)                                   # fade in
    rise = np.clip((x - (hook_at - 0.25)) / 0.25, 0, 1)          # open up on the hook
    fall = np.clip((x - (hook_at + dur_after)) / 0.6, 0, 1)      # duck for the next line
    return g + rise * (1 - under) - fall * (1 - under) * 0.8


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sting", type=Path, help=".wav output for the sting alone")
    ap.add_argument("--mix", type=Path, help="voice track to score")
    ap.add_argument("--title-end", type=float, help="second where the title call ends")
    ap.add_argument("--gap", type=float, default=2.4, help="seconds of room to open after the title")
    ap.add_argument("--out", type=Path, help="scored .mp3 output")
    a = ap.parse_args()

    sting, hook_at = compose()
    sf.write(a.sting, sting, SR)
    print(f"wrote {a.sting} ({len(sting) / SR:.1f} s, hook at {hook_at:.2f} s)")
    if not a.mix:
        return

    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "voice.wav"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(a.mix), "-ac", "2",
                        "-ar", str(SR), str(wav)], check=True)
        voice, _ = sf.read(wav)
        cut = int(a.title_end * SR)
        voice = np.concatenate([voice[:cut], np.zeros((int(a.gap * SR), 2)), voice[cut:]])

        start = a.title_end - hook_at
        music = sting * bed_gain(len(sting), hook_at, a.gap - 0.3)[:, None]
        i = int(start * SR)
        voice[i:i + len(music)] += music[: len(voice) - i] * 0.5
        voice /= max(1.0, np.max(np.abs(voice)) / 0.95)
        mixed = Path(tmp) / "mixed.wav"
        sf.write(mixed, voice, SR)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(mixed),
                        "-b:a", "160k", str(a.out)], check=True)
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
