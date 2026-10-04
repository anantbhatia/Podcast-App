"""Render a two-host episode script with ElevenLabs v3 text-to-dialogue.

Same script format as render_episode.py (`MARA: text` / `THEO: text`, `##`
and `###` headings), but v3 performs the lines as one conversation, so
`[laughs]` and other audio tags are kept and a line ending in an em-dash is
sent as-is for the model to play as a cut-off. `[DEEPER: ...]` notes are not
speaker lines and are skipped.

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
MODEL = "eleven_v3"
# Default voices usable on the free tier (library voices need a paid plan).
VOICES = {
    "MARA": "EXAVITQu4vr4xnSDxMaL",  # Sarah: calm, precise, deadpan
    "THEO": "iP95p4xoKVk53GoZ742B",  # Chris: warm, quick, conversational
}
MAX_CHARS = 2500     # keep each request well under the v3 per-request limit
SECTION_GAP = 1.0    # seconds of silence between sections
LINE_RE = re.compile(r"^(MARA|THEO):\s*(.+)$")
HEADING_RE = re.compile(r"^#{2,3}\s+(.+)$")


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
        m = LINE_RE.match(s)
        if started and m and current is not None:
            speaker, text = m.groups()
            text = re.sub(r"\[DEEPER:[^\]]*\]", "", text).replace("*", "").strip()
            if text:
                current[1].append((speaker, text))
    return [sec for sec in sections if sec[1]]


def chunk(lines):
    """Split a section's lines into requests of at most MAX_CHARS."""
    batch, size = [], 0
    for speaker, text in lines:
        if batch and size + len(text) > MAX_CHARS:
            yield batch
            batch, size = [], 0
        batch.append((speaker, text))
        size += len(text)
    if batch:
        yield batch


def request(lines, key: str, seed: int | None) -> bytes:
    body = {
        "model_id": MODEL,
        "inputs": [{"text": t, "voice_id": VOICES[s]} for s, t in lines],
    }
    if seed is not None:
        body["seed"] = seed
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


def join(parts: list[tuple[Path, bool]], out: Path):
    """Concatenate mp3 parts, adding a short silence where a section starts."""
    with tempfile.TemporaryDirectory() as tmp:
        gap = Path(tmp) / "gap.mp3"
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i",
             "anullsrc=r=44100:cl=mono", "-t", str(SECTION_GAP), "-b:a", "128k", str(gap)],
            check=True,
        )
        listing = Path(tmp) / "list.txt"
        entries = []
        for i, (p, new_section) in enumerate(parts):
            if i and new_section:
                entries.append(f"file '{gap}'")
            entries.append(f"file '{p.resolve()}'")
        listing.write_text("\n".join(entries))
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
             "-i", str(listing), "-ar", "44100", "-b:a", "128k", str(out)],
            check=True,
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("script", type=Path)
    ap.add_argument("out", type=Path, help=".mp3 output")
    ap.add_argument("--start-at", help="start at the heading that starts with this")
    ap.add_argument("--stop-at", help="stop before the heading that starts with this")
    ap.add_argument("--seed", type=int, help="fix the seed for a repeatable take")
    ap.add_argument("--dry-run", action="store_true", help="print sections and character count only")
    a = ap.parse_args()

    sections = parse_sections(a.script.read_text(), a.start_at, a.stop_at)
    total = sum(len(t) for _, lines in sections for _, t in lines)
    for title, lines in sections:
        print(f"{title}: {len(lines)} lines, {sum(len(t) for _, t in lines)} chars")
    print(f"total: {total} characters (about {total} credits)")
    if a.dry_run:
        return

    key = os.environ.get("ELEVENLABS_API_KEY") or sys.exit("ELEVENLABS_API_KEY is not set")
    a.out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        parts = []
        for si, (title, lines) in enumerate(sections):
            for ci, batch in enumerate(chunk(lines)):
                print(f"rendering {title} ({ci + 1})...")
                p = Path(tmp) / f"{si:02d}_{ci:02d}.mp3"
                p.write_bytes(request(batch, key, a.seed))
                parts.append((p, ci == 0))
        join(parts, a.out)
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
