#!/usr/bin/env node
// The spoken greeting on the listening page: a few seconds of Anant and Aman saying good
// morning, afternoon or evening before the first episode of a visit, in the hosts' ElevenLabs
// voices (the same dialogue model and settings as the episodes). Two modes:
//
//   node scripts/greet-clips.mjs --generic
//     Renders the show's three clips to public/audio/greet-{morning,afternoon,evening}.mp3
//     (committed with the site; run again only to change the lines below).
//
//   node scripts/greet-clips.mjs --named [--max N] [--dry-run] [--verbose]
//     For every subscriber who gave a first name and has no clips saying it yet, renders the
//     three clips with the name ("Good morning, Anurag!") and stores them on the worker
//     (PUT /api/greet/<id>/<slot>, then POST /api/greet/<id>/clips), so their next visit from
//     an email link greets them by name. Part of each publish (ADD-EPISODE.md, "Tell
//     subscribers"), before the emails go out. At most --max subscribers per run (25 unless
//     given), so a run can't spend more than a host expects; --dry-run only counts and prices.
//
// Needs ELEVENLABS_API_KEY and ffmpeg (both in the cloud environment); --named also INBOX_URL and
// INBOX_TOKEN. Names and addresses are printed only with --verbose, and never belong in a thread.
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const API = "https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_44100_128";
const MODEL = "eleven_v4";
const VOICES = { anant: "2VlXj8B3IygUVWIq1EAC", aman: "Nj6ChQDqm6Ghv0E6HlCu" };
const CREDITS_PER_CHAR = 0.44;
export const SLOTS = ["morning", "afternoon", "evening"];
// What the hosts say. "{name}" becomes ", <Name>" in a listener's own clip and nothing in the
// show's generic one. The second line is the same either way; who greets alternates by slot.
export const LINES = {
  morning: [["anant", "Good morning{name}!"], ["aman", "Grab your coffee. Here we go."]],
  afternoon: [["aman", "Good afternoon{name}!"], ["anant", "Perfect time for a break. Here we go."]],
  evening: [["anant", "Good evening{name}!"], ["aman", "Settle in. Here we go."]],
};
// Loudness to match the episodes (they measure about -23 LUFS integrated), with a short tail so
// the episode doesn't start on the greeting's last syllable.
const TARGET = { I: -23, TP: -3, LRA: 7 }, TAIL = 0.15;

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const fail = (msg) => { console.error(msg); process.exit(1); };
const verbose = flag("--verbose"), dry = flag("--dry-run");

export const script = (slot, name = "") => LINES[slot].map(([host, text]) => [host, text.replace("{name}", name ? `, ${name}` : "")]);
export const chars = (name = "") => SLOTS.reduce((n, s) => n + script(s, name).reduce((m, [, t]) => m + t.length, 0), 0);
const credits = (n) => Math.ceil(n * CREDITS_PER_CHAR);

async function render(lines, key) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ model_id: MODEL, inputs: lines.map(([host, text]) => ({ text, voice_id: VOICES[host] })), settings: { stability: 0.0 } }),
  });
  if (!res.ok) throw new Error(`ElevenLabs answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

// Trims leading silence, matches the episodes' loudness (two-pass loudnorm) and writes the
// clip as the episodes are encoded: 44.1 kHz stereo MP3 at 96 kbps, with TAIL seconds of room.
function finishClip(raw, out, dir) {
  const src = join(dir, "raw.mp3");
  writeFileSync(src, raw);
  const trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08";
  const norm = `loudnorm=I=${TARGET.I}:TP=${TARGET.TP}:LRA=${TARGET.LRA}`;
  const pass1 = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", src, "-af", `${trim},${norm}:print_format=json`, "-f", "null", "-"], { encoding: "utf8" });
  const j = /\{[^{}]*"input_i"[\s\S]*?\}/.exec(pass1.stderr || ""); // ffmpeg prints the measurement on stderr
  if (!j) throw new Error(`ffmpeg gave no loudness measurement${pass1.error ? ` (${pass1.error.message})` : ""}`);
  const v = JSON.parse(j[0]);
  const second = `${norm}:measured_I=${v.input_i}:measured_TP=${v.input_tp}:measured_LRA=${v.input_lra}:measured_thresh=${v.input_thresh}:offset=${v.target_offset}:linear=true`;
  execFileSync("ffmpeg", ["-hide_banner", "-nostats", "-loglevel", "error", "-y", "-i", src, "-af", `${trim},${second},apad=pad_dur=${TAIL}`, "-ar", "44100", "-ac", "2", "-b:a", "96k", out]);
  const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size", "-of", "csv=p=0", out], { encoding: "utf8" }).trim().split(",");
  return { seconds: Number(probe[0]), bytes: Number(probe[1]) };
}

async function renderSet(name, key, dir, into) {
  const made = {};
  for (const slot of SLOTS) {
    const raw = await render(script(slot, name), key);
    const out = into(slot);
    made[slot] = { out, ...finishClip(raw, out, dir) };
  }
  return made;
}

const key = process.env.ELEVENLABS_API_KEY;
if (!flag("--generic") && !flag("--named")) fail("Usage: node scripts/greet-clips.mjs --generic | --named [--max N] [--dry-run] [--verbose]");
if (!dry && !key) fail("ELEVENLABS_API_KEY is not set.");
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { if (!dry) fail("ffmpeg is not installed; the clips can't be finished without it."); }
const dir = mkdtempSync(join(tmpdir(), "greet-"));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

if (flag("--generic")) {
  const n = chars();
  console.log(`The show's greeting: ${n} characters, about ${credits(n)} ElevenLabs credits.`);
  for (const slot of SLOTS) console.log(`  ${slot}: ${script(slot).map(([h, t]) => `${h}: "${t}"`).join("  ")}`);
  if (!dry) {
    const made = await renderSet("", key, dir, (slot) => join(root, "public", "audio", `greet-${slot}.mp3`));
    for (const slot of SLOTS) console.log(`  wrote public/audio/greet-${slot}.mp3 (${made[slot].seconds.toFixed(1)} s, ${made[slot].bytes} bytes)`);
  }
}

if (flag("--named")) {
  const base = (process.env.INBOX_URL || "").replace(/\/+$/, ""), token = process.env.INBOX_TOKEN;
  if (!base || !token) fail("INBOX_URL and INBOX_TOKEN are needed to reach the subscriber list.");
  const auth = { authorization: `Bearer ${token}` };
  const res = await fetch(`${base}/api/subscribers`, { headers: auth });
  if (!res.ok) fail(`${base}/api/subscribers answered ${res.status}.`);
  const { items, count } = await res.json();
  const due = items.filter((s) => s.name && s.clipsFor !== s.name && /^[0-9a-f]{64}$/.test(s.gid));
  const max = Number(opt("--max", 25));
  const total = due.reduce((n, s) => n + chars(s.name), 0);
  console.log(`${count} sign-ups, ${items.filter((s) => s.name).length} with a name, ${due.length} without clips in that name: ${total} characters, about ${credits(total)} credits.`);
  if (due.length > max) fail(`That is more than ${max} subscribers in one run; a host should expect the spend. Run again with --max ${due.length} to go ahead.`);
  if (dry) process.exit(0);
  let done = 0;
  for (const s of due) {
    const who = verbose ? `${s.name} <${s.email}>` : `id ${s.gid.slice(0, 8)}…`;
    try {
      const made = await renderSet(s.name, key, dir, (slot) => join(dir, `${s.gid.slice(0, 8)}-${slot}.mp3`));
      for (const slot of SLOTS) {
        const put = await fetch(`${base}/api/greet/${s.gid}/${slot}`, { method: "PUT", headers: { ...auth, "content-type": "audio/mpeg" }, body: readFileSync(made[slot].out) });
        if (!put.ok) throw new Error(`storing the ${slot} clip failed (${put.status}: ${(await put.text()).slice(0, 200)})`);
      }
      const mark = await fetch(`${base}/api/greet/${s.gid}/clips`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ for: s.name }) });
      if (!mark.ok) throw new Error(`marking the clips failed (${mark.status})`);
      done++;
      console.log(`  ${who}: 3 clips stored (${SLOTS.map((x) => made[x].seconds.toFixed(1) + " s").join(", ")})`);
    } catch (e) {
      console.error(`  ${who}: ${e.message}`);
    }
  }
  console.log(`${done} of ${due.length} subscribers have their greeting now${done < due.length ? "; run again for the rest" : ""}.`);
}
