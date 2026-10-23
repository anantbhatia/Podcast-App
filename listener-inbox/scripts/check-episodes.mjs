#!/usr/bin/env node
// Checks episodes.json before a deploy: every episode has what the page needs
// (the Studio's publish payload fields, see ADD-EPISODE.md) and its MP3 is in public/audio.
// wrangler runs this as the build step (wrangler.toml), so a bad entry stops
// `wrangler deploy` and `wrangler dev` with the reasons listed.
// Run it by hand: node scripts/check-episodes.mjs
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { problems, sorted, label, audioFile, seconds, clock } from "../src/episodes.mjs";

const MAX_AUDIO = 25 * 1024 * 1024; // Workers static assets refuse larger files
const root = fileURLToPath(new URL("..", import.meta.url));
const file = `${root}episodes.json`;

let list;
try {
  list = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`episodes.json could not be read as JSON: ${e.message}`);
  process.exit(1);
}

const size = (name) => { try { return statSync(`${root}public/audio/${name}`).size; } catch { return -1; } };
const errors = problems(list, (name) => size(name) >= 0);
for (const e of Array.isArray(list) ? list : []) {
  const name = e && typeof e === "object" ? audioFile(e) : "";
  if (name && size(name) > MAX_AUDIO) {
    errors.push(`episode (${e.slug}): public/audio/${name} is over 25 MiB; re-encode it at 96 kbps mono`);
  }
  if (name && size(name) >= 0 && Number.isInteger(e.bytes) && e.bytes !== size(name)) {
    errors.push(`episode (${e.slug}): bytes is ${e.bytes} but public/audio/${name} is ${size(name)} bytes; set bytes to the file's size (the podcast feed sends it)`);
  }
}
if (errors.length) {
  console.error(`episodes.json has ${errors.length} problem${errors.length > 1 ? "s" : ""}:`);
  for (const m of errors) console.error(`  - ${m}`);
  console.error("Fix them (see ADD-EPISODE.md) and run again.");
  process.exit(1);
}
const eps = sorted(list);
console.log(`episodes.json: ${eps.length} episode${eps.length === 1 ? "" : "s"} OK` + (eps.length ? `, newest ${eps[0].slug} (${label(eps[0])} · ${eps[0].title}, ${clock(seconds(eps[0].durationSec))})` : ""));
