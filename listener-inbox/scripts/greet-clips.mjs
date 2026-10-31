#!/usr/bin/env node
// The spoken greeting on the listening page: a few seconds of Anant and Aman saying good
// morning, afternoon or evening before the first episode of a visit, in the hosts' ElevenLabs
// voices (the same dialogue model and settings as the episodes). Two modes:
//
//   node scripts/greet-clips.mjs --generic
//     Renders the show's three clips to public/audio/greet-{morning,afternoon,evening}.mp3
//     (committed with the site; run again only to change the lines below).
//
//   node scripts/greet-clips.mjs --named --dry-run [--verbose]
//   node scripts/greet-clips.mjs --named --approve <code> [--max N]
//     For every subscriber who gave a first name and has no clips saying it yet, renders the
//     three clips with the name ("Good morning, Anurag!") and stores them on the worker
//     (PUT /api/greet/<id>/<slot>, then POST /api/greet/<id>/clips), so their next visit from
//     an email link greets them by name. Part of each publish (ADD-EPISODE.md, "Tell
//     subscribers"), before the emails go out. The dry run spends nothing: it counts, prices
//     and lists the names due, for the operator's eyes (the hosts' voices will say them; clear
//     one that isn't a first name with POST /api/subscribers/name first), and prints the
//     --approve code for exactly that list. The real run takes that code and refuses if the
//     list has changed since (a name typed in between waits for the next dry run), and stops
//     above --max subscribers (25 unless given), so a run can't spend more than a host expects.
//
// Needs ELEVENLABS_API_KEY and ffmpeg (both in the cloud environment); --named also INBOX_URL and
// INBOX_TOKEN. Addresses are printed only with --verbose; neither names nor addresses belong in a thread.
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
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

// Renders the three clips; `after(slot, file)` runs as soon as each one is ready (so a store
// failure stops the run before the next clip is paid for).
async function renderSet(name, key, dir, into, after) {
  const made = {};
  for (const slot of SLOTS) {
    const raw = await render(script(slot, name), key);
    const out = into(slot);
    made[slot] = { out, ...finishClip(raw, out, dir) };
    if (after) await after(slot, out);
  }
  return made;
}
// A worker answer the run can't recover from: the token is wrong or the route is missing. Any
// other answer is one person's (a sign-up removed mid-run is a 404; a 5xx is tried again next run).
class WorkerRefused extends Error {}
async function check(res, what) {
  if (res.ok) return;
  const text = (await res.text()).slice(0, 200);
  if (res.status === 401 || res.status === 405) throw new WorkerRefused(`${what}: the worker answered ${res.status} ${text}`);
  throw new Error(`${what}: ${res.status} ${text}`);
}

const key = process.env.ELEVENLABS_API_KEY;
if (!flag("--generic") && !flag("--named")) fail("Usage: node scripts/greet-clips.mjs --generic | --named [--max N] [--dry-run] [--verbose]");
if (!dry && !key) fail("ELEVENLABS_API_KEY is not set.");
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { if (!dry) fail("ffmpeg is not installed; the clips can't be finished without it."); }
const dir = mkdtempSync(join(tmpdir(), "greet-"));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130)); // so the clips with names don't outlive an interrupted run

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
  const rawMax = opt("--max", "25");
  if (!/^\d+$/.test(rawMax) || Number(rawMax) < 1) fail(`--max needs a whole number, for example --max 30 (got "${rawMax}").`);
  const max = Number(rawMax);
  let res;
  try { res = await fetch(`${base}/api/subscribers`, { headers: auth }); } catch (e) { fail(`Couldn't reach ${base}: ${e.cause ? e.cause.message : e.message}`); }
  if (!res.ok) fail(`${base}/api/subscribers answered ${res.status}.`);
  const { items, count, unindexed } = await res.json();
  if (unindexed) console.log(`Note: ${unindexed} older sign-ups still have no greeting link; list /api/subscribers again until the answer's unindexed is 0.`);
  const due = items.filter((s) => s.name && s.clipsFor !== s.name && /^[0-9a-f]{64}$/.test(s.gid));
  const total = due.reduce((n, s) => n + chars(s.name), 0);
  // The code for exactly this list of people and names; the real run must be given it.
  const code = createHash("sha256").update(JSON.stringify(due.map((s) => [s.gid, s.name]).sort())).digest("hex").slice(0, 10);
  console.log(`${count} sign-ups, ${items.filter((s) => s.name).length} with a name, ${due.length} without clips in that name: ${total} characters, about ${credits(total)} credits.`);
  if (dry) {
    for (const s of due) console.log(`  would render for "${s.name}" (id ${s.gid.slice(0, 8)}…${verbose ? `, ${s.email}` : ""}): ${script("morning", s.name)[0][1]}`);
    if (due.length > max) console.log(`That is more than ${max} in one run: the real run stops unless given --max ${due.length}.`);
    if (due.length) console.log(`If every name above is a first name, render exactly this list with: node scripts/greet-clips.mjs --named --approve ${code}`);
    process.exit(0);
  }
  if (!due.length) { console.log("Nothing to render."); process.exit(0); }
  const approved = opt("--approve", "");
  if (!approved) fail("Run with --dry-run first, read the names, then run again with the --approve code it prints.");
  if (approved !== code) fail("The list of names has changed since that dry run (someone signed up or changed a name). Run --dry-run again and read the new list.");
  if (due.length > max) fail(`That is more than ${max} subscribers in one run; a host should expect the spend. Run again with --max ${due.length} to go ahead.`);
  // Before any credit is spent: the worker must carry the greeting routes and take the token.
  // An empty body gets the route's own "an MP3 between ..." refusal; anything else means stop.
  const probe = await fetch(`${base}/api/greet/${due[0].gid}/morning`, { method: "PUT", headers: { ...auth, "content-type": "audio/mpeg" }, body: new Uint8Array(0) });
  if (probe.status !== 400) fail(`The worker at ${base} doesn't take greeting clips yet (answered ${probe.status} to a probe): deploy this version first (DEPLOY.md), then run again.`);
  let done = 0;
  for (const s of due) {
    const who = verbose ? `${s.name} <${s.email}>` : `id ${s.gid.slice(0, 8)}…`;
    try {
      const made = await renderSet(s.name, key, dir, (slot) => join(dir, `${s.gid.slice(0, 8)}-${slot}.mp3`), async (slot, file) => {
        const put = await fetch(`${base}/api/greet/${s.gid}/${slot}`, { method: "PUT", headers: { ...auth, "content-type": "audio/mpeg" }, body: readFileSync(file) });
        try { rmSync(file, { force: true }); } catch {}
        await check(put, `storing the ${slot} clip`);
      });
      const mark = await fetch(`${base}/api/greet/${s.gid}/clips`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ for: s.name }) });
      await check(mark, "marking the clips");
      done++;
      console.log(`  ${who}: 3 clips stored (${SLOTS.map((x) => made[x].seconds.toFixed(1) + " s").join(", ")})`);
    } catch (e) {
      console.error(`  ${who}: ${e.message}`);
      if (e instanceof WorkerRefused) { console.error("Stopping: the worker refuses the token or the route, so nothing more is rendered."); process.exit(1); }
    }
  }
  console.log(`${done} of ${due.length} subscribers have their greeting now${done < due.length ? "; run again for the rest" : ""}.`);
  process.exit(done === due.length ? 0 : 1);
}
