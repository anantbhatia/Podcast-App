#!/usr/bin/env node
// Checks public/episodes.json before a deploy: every episode has what the page needs
// and its MP3 is in public/audio. wrangler runs this as the build step (wrangler.toml),
// so a bad entry stops `wrangler deploy` and `wrangler dev` with the reasons listed.
// Run it by hand: node scripts/check-episodes.mjs
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { problems, sorted, label, seconds, clock } from "../src/episodes.mjs";

const MAX_AUDIO = 25 * 1024 * 1024; // Workers static assets refuse larger files
const root = fileURLToPath(new URL("..", import.meta.url));
const file = `${root}public/episodes.json`;

let list;
try {
  list = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`public/episodes.json could not be read as JSON: ${e.message}`);
  process.exit(1);
}

const size = (name) => { try { return statSync(`${root}public/audio/${name}`).size; } catch { return -1; } };
const errors = problems(list, (name) => size(name) >= 0);
for (const e of Array.isArray(list) ? list : []) {
  if (e && typeof e.audio === "string" && size(e.audio) > MAX_AUDIO) {
    errors.push(`episode (${e.slug}): public/audio/${e.audio} is over 25 MiB; re-encode it at 96 kbps mono`);
  }
}
if (errors.length) {
  console.error(`public/episodes.json has ${errors.length} problem${errors.length > 1 ? "s" : ""}:`);
  for (const m of errors) console.error(`  - ${m}`);
  console.error("Fix them (see ADD-EPISODE.md) and run again.");
  process.exit(1);
}
const eps = sorted(list);
console.log(`episodes.json: ${eps.length} episode${eps.length === 1 ? "" : "s"} OK` + (eps.length ? `, newest ${eps[0].slug} (${label(eps[0])} · ${eps[0].title}, ${clock(seconds(eps[0].duration))})` : ""));
