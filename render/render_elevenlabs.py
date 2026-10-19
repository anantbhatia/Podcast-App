"""Render a two-host episode script with ElevenLabs text-to-dialogue (v3 or v4).

Same script format as render_episode.py (`ANANT: text` / `AMAN: text`, or the
pilots' `MARA:` / `THEO:`, with `##`
and `###` headings), but v3 performs the lines as one conversation, so
`[laughs]` and other audio tags are kept and a line ending in an em-dash is
sent as-is for the model to play as a cut-off. `[DEEPER: ...]` notes are not
speaker lines and are skipped.

Production cues on a line of their own, `[THEME HIT]` (right after the title
call), `[TRANSITION]` (where the next story starts) and `[STING]` (between
game items), are not spoken. The
renderer ends a request at each one and writes where it fell in the audio to
`<out>.cues.json`, which score_episode.py reads to place the music.

Needs ELEVENLABS_API_KEY with text-to-speech permission, and ffmpeg to join
sections. Credits are charged per character, so check `--dry-run` first.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.elevenlabs.io/v1/text-to-dialogue"
MODEL = "eleven_v4"   # Anant picked v4 over v3 for the clones (2026-10-13)
VOICES = {
    "ANANT": "2VlXj8B3IygUVWIq1EAC",  # Anant's instant clone
    "AMAN": "Nj6ChQDqm6Ghv0E6HlCu",   # Aman's instant clone
    # Pilot hosts, default voices usable on the free tier.
    "MARA": "FGY2WhTYpPnrIDTdsKH5",  # Laura: high energy, conversational
    "THEO": "iP95p4xoKVk53GoZ742B",  # Chris: warm, quick, conversational
}
MAX_CHARS = 2500     # well under the v3 (5k) and v4 (10k) per-request limits
SECTION_GAP = 1.0    # seconds of silence between sections
LINE_RE = re.compile(rf"^({'|'.join(VOICES)}):\s*(.+)$")
HEADING_RE = re.compile(r"^#{2,3}\s+(.+)$")
CUE_RE = re.compile(r"^\[(THEME HIT|TRANSITION|STING)\]$")
# Names the voices get wrong, rewritten only in the text sent to the model.
# v4 reads IPA between slashes; v3 needs phonetic spellings instead.
PRONOUNCE = {
    "eleven_v4": {"Anant": "/əˈnənt/", "Anthropic": "/ænˈθrɑːpɪk/"},
    "eleven_v3": {"Anant": "Uh-nunt"},
}


def parse_sections(script: str, start_at: str | None, stop_at: str | None):
    """Return [(title, [(speaker, text), ...])] between the two headings."""
    sections, current, started = [], None, start_at is None
    for raw in script.splitlines():
        s = raw.strip()
        h = HEADING_RE.match(s)
        if h:
            title = h.group(1)
            if stop_at and title.upper().startswith(stop_at.upper()):
                break
            if start_at and title.upper().startswith(start_at.upper()):
                started = True
            if started and not s.startswith("# "):
                current = (title, [])
                sections.append(current)
            continue
        cue = CUE_RE.match(s)
        if started and cue and current is not None:
            current[1].append(("CUE", cue.group(1)))
            continue
        m = LINE_RE.match(s)
        if started and m and current is not None:
            speaker, text = m.groups()
            text = re.sub(r"\[DEEPER:[^\]]*\]", "", text).replace("*", "").strip()
            if text:
                current[1].append((speaker, text))
    return [sec for sec in sections if sec[1]]


def chars(lines) -> int:
    return sum(len(t) for s, t in lines if s != "CUE")


def chunk(lines):
    """Split a section's lines into requests of at most MAX_CHARS.

    A cue ends the request before it and is yielded on its own as ("CUE", name).
    """
    batch, size = [], 0
    for speaker, text in lines:
        if speaker == "CUE":
            if batch:
                yield batch
            yield (speaker, text)
            batch, size = [], 0
            continue
        if batch and size + len(text) > MAX_CHARS:
            yield batch
            batch, size = [], 0
        batch.append((speaker, text))
        size += len(text)
    if batch:
        yield batch


def pronounce(text: str, model: str) -> str:
    for word, said in PRONOUNCE.get(model, {}).items():
        text = re.sub(rf"\b{word}\b", said, text)
    return text


def request(lines, key: str, seed: int | None, stability: float | None, model: str) -> bytes:
    body = {
        "model_id": model,
        "inputs": [{"text": pronounce(t, model), "voice_id": VOICES[s]} for s, t in lines],
    }
    if seed is not None:
        body["seed"] = seed
    if stability is not None:
        body["settings"] = {"stability": stability}
    req = urllib.request.Request(
        f"{API}?output_format=mp3_44100_128",
        data=json.dumps(body).encode(),
        headers={"xi-api-key": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        sys.exit(f"ElevenLabs {e.code}: {e.read().decode()[:500]}")


RATE = 44100


def join(parts: list[tuple[Path, bool]], out: Path) -> list[float]:
    """Concatenate mp3 parts, adding a short silence where a section starts.

    Parts are decoded to PCM and joined sample by sample, so the returned end
    time of each part (seconds) is exact. Summing each mp3's own duration
    drifted by tens of milliseconds per part, which put late cues inside the
    next line's first word.
    """
    pcm, ends, n = [], [], 0
    gap = bytes(2 * int(SECTION_GAP * RATE))
    for i, (p, new_section) in enumerate(parts):
        if i and new_section:
            pcm.append(gap)
            n += len(gap)
        raw = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-i", str(p), "-f", "s16le", "-ac", "1",
             "-ar", str(RATE), "-"], capture_output=True, check=True).stdout
        pcm.append(raw)
        n += len(raw)
        ends.append(n / 2 / RATE)
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-f", "s16le", "-ac", "1", "-ar", str(RATE),
         "-i", "-", "-b:a", "128k", str(out)],
        input=b"".join(pcm), check=True)
    return ends


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("script", type=Path)
    ap.add_argument("out", type=Path, help=".mp3 output")
    ap.add_argument("--start-at", help="start at the heading that starts with this")
    ap.add_argument("--stop-at", help="stop before the heading that starts with this")
    ap.add_argument("--seed", type=int, help="fix the seed for a repeatable take")
    ap.add_argument("--model", default=MODEL, help="eleven_v4 (default) or eleven_v3")
    ap.add_argument("--stability", type=float, default=0.0,
                    help="v3 stability: 0.0 creative (default, most expressive), 0.5 natural, 1.0 robust")
    ap.add_argument("--voice", action="append", default=[], metavar="HOST=VOICE_ID",
                    help="override a host's voice, e.g. --voice ANANT=<voice id>")
    ap.add_argument("--dry-run", action="store_true", help="print sections and character count only")
    a = ap.parse_args()
    for override in a.voice:
        host, _, voice_id = override.partition("=")
        if host.upper() not in VOICES or not voice_id:
            sys.exit(f"bad --voice {override!r}; expected HOST=<id> for one of {sorted(VOICES)}")
        VOICES[host.upper()] = voice_id

    sections = parse_sections(a.script.read_text(), a.start_at, a.stop_at)
    total = sum(chars(lines) for _, lines in sections)
    for title, lines in sections:
        cues = [t for s, t in lines if s == "CUE"]
        print(f"{title}: {len(lines) - len(cues)} lines, {chars(lines)} chars"
              + (f", cues: {', '.join(cues)}" if cues else ""))
    print(f"total: {total} characters (about {total} credits)")
    if a.dry_run:
        return

    key = os.environ.get("ELEVENLABS_API_KEY") or sys.exit("ELEVENLABS_API_KEY is not set")
    a.out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        parts, cues = [], []
        for si, (title, lines) in enumerate(sections):
            first = True
            for ci, batch in enumerate(chunk(lines)):
                if isinstance(batch, tuple):  # a cue: note where it falls
                    cues.append({"cue": batch[1], "after": len(parts), "section": title})
                    continue
                print(f"rendering {title} ({ci + 1})...")
                p = Path(tmp) / f"{si:02d}_{ci:02d}.mp3"
                p.write_bytes(request(batch, key, a.seed, a.stability, a.model))
                parts.append((p, first))
                first = False
        ends = join(parts, a.out)
    for c in cues:  # a cue falls where the speech before it ends
        k = c.pop("after")
        c["at"] = round(ends[k - 1] if k else 0.0, 3)
    cue_file = a.out.with_suffix(".cues.json")
    cue_file.write_text(json.dumps(cues, indent=1))
    print(f"wrote {a.out} and {cue_file.name} ({len(cues)} cues)")


if __name__ == "__main__":
    main()
