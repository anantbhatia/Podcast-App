#!/usr/bin/env node
// Adds an episode to the site from the Studio's publish payload (ADD-EPISODE.md):
//   node scripts/add-episode.mjs payload.json
// payload.json holds the message the Studio sent (the JSON object, with or without the
// "Publish requested from the Studio:" line in front). This copies the MP3 named in
// "mp3" into public/audio, and appends an entry to episodes.json with only the fields
// the page shows. The repo is public, so the payload's Studio link, requester id and
// /mnt path are dropped here and the build check refuses them if they get in anyway.
// Pass --replace to overwrite an entry that already has the same slug.
import { readFileSync, writeFileSync, copyFileSync, existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { problems, sorted, label, seconds, clock, liveOn, AUDIO_FILE, GENERIC_BADGE } from "../src/episodes.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const replace = args.includes("--replace");
const src = args.find((a) => !a.startsWith("--"));
const fail = (msg) => { console.error(msg); process.exit(1); };
if (!src) fail("Usage: node scripts/add-episode.mjs payload.json [--replace]");

let payload;
try {
  const text = readFileSync(src, "utf8");
  payload = JSON.parse(text.slice(text.indexOf("{")));
} catch (e) {
  fail(`${src} doesn't hold a JSON object: ${e.message}`);
}

// Only what the page shows. Anything else in the payload stays out of the repo.
// A special (kind "special") carries its own number, specialNo (or the number in its slug,
// special-01), and no weekly number. A badge or label that only names the kind ("Special
// episode") isn't stored: the page builds "Special episode 1" from the number itself.
const special = payload.kind === "special";
const fromSlug = special && /^special-0*(\d+)$/.exec(String(payload.slug ?? ""));
const specialNo = payload.specialNo ?? (fromSlug ? Number(fromSlug[1]) : undefined);
const plain = (s) => typeof s !== "string" || !s.trim() || GENERIC_BADGE.test(s.trim());
const entry = {
  kind: payload.kind, episode: special ? undefined : payload.episode, specialNo,
  slug: payload.slug, label: plain(payload.label) ? undefined : payload.label, badge: plain(payload.badge) ? undefined : payload.badge,
  title: payload.title, date: payload.date,
  durationSec: payload.durationSec, description: payload.description, summary: payload.summary,
  sources: Array.isArray(payload.sources) ? payload.sources.map((g) => ({
    story: g?.story, refs: Array.isArray(g?.refs) ? g.refs.map((r) => ({ title: r?.title, outlet: r?.outlet, url: r?.url })) : g?.refs,
  })) : payload.sources,
};
for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
if (!special && /^special-/.test(String(payload.slug ?? ""))) fail(`The slug ${JSON.stringify(payload.slug)} looks like a special's, but the payload has no "kind": "special"; add it (and specialNo), or use a weekly slug like ep04`);
if (special && payload.episode !== undefined) console.log(`note: the payload's episode ${JSON.stringify(payload.episode)} is dropped; a special has no weekly number`);
if (special && payload.specialNo === undefined && fromSlug) console.log(`note: the payload has no specialNo; taking ${specialNo} from the slug`);
if (special && !/^special-/.test(String(payload.slug))) console.log(`note: a special's slug is usually special-NN, like special-01 (this one is ${JSON.stringify(payload.slug)})`);

// The MP3: copy it from the payload's path into public/audio, unless it is already there.
const mp3 = typeof payload.mp3 === "string" ? payload.mp3 : "";
const audio = typeof payload.audio === "string" && payload.audio ? payload.audio : basename(mp3);
if (!AUDIO_FILE.test(audio)) fail(`The payload's mp3 (${mp3 || "missing"}) must end in a file name like ep02-title.mp3`);
entry.audio = audio;
const dest = `${root}public/audio/${audio}`;
const haveMp3 = mp3 && existsSync(mp3);
if (!haveMp3 && !existsSync(dest)) {
  fail(`${mp3 || "the MP3"} is not there and public/audio/${audio} doesn't exist yet; copy the MP3 into public/audio first`);
}

// The MP3's size goes in the entry: the podcast feed's enclosure needs it, and the worker can't stat files.
entry.bytes = statSync(haveMp3 ? mp3 : dest).size;
// When the episode went live (UTC), for the feed's pubDate: the Studio stamps only the day, and
// the directories would hold an item dated noon of a day that has barely begun. A payload dated
// days ago is an older episode; it gets no instant and the feed lists it at noon of its date.
const now = new Date().toISOString();
if (liveOn(now, entry.date)) entry.publishedAt = now;

const file = `${root}episodes.json`;
let list;
try { list = JSON.parse(readFileSync(file, "utf8")); } catch (e) { fail(`episodes.json could not be read as JSON: ${e.message}`); }
if (!Array.isArray(list)) fail("episodes.json must be a JSON array");
const existing = list.findIndex((e) => e && e.slug === entry.slug);
if (existing >= 0 && !replace) fail(`episodes.json already has ${entry.slug}; pass --replace to overwrite it`);
// A re-publish keeps the day the episode first aired: the Studio stamps every payload with the
// day of the press, and the page orders by date, so a fix must not move the episode back to the top.
if (existing >= 0) {
  const was = list[existing];
  if (typeof was.date === "string" && was.date !== entry.date) {
    console.log(`note: keeping the published date ${was.date} (the payload says ${entry.date})`);
    entry.date = was.date;
  }
  // The instant it first went live stays with the date; an entry from before it was recorded
  // keeps none (the feed lists it at noon of its date) unless it is re-published on its own day.
  if (typeof was.publishedAt === "string") entry.publishedAt = was.publishedAt;
  else if (!liveOn(entry.publishedAt, entry.date)) delete entry.publishedAt;
}
if (!entry.publishedAt) console.log(`note: ${entry.slug} is dated ${JSON.stringify(entry.date)}, not today, with no recorded instant; the feed lists it at noon UTC of that day`);
if (existing >= 0 && typeof list[existing].audio === "string" && list[existing].audio !== entry.audio) {
  console.log(`note: public/audio/${list[existing].audio} is no longer used by ${entry.slug}; delete it unless another entry plays it`);
}
if (existing >= 0) list[existing] = entry; else list.push(entry);
list = sorted(list);

// Check everything before touching any file (the new MP3 counts as present once copied).
const errors = problems(list, (name) => name === audio || existsSync(`${root}public/audio/${name}`));
if (errors.length) {
  console.error(`Not written. The entry has ${errors.length} problem${errors.length > 1 ? "s" : ""}:`);
  for (const m of errors) console.error(`  - ${m}`);
  process.exit(1);
}
if (haveMp3) {
  copyFileSync(mp3, dest);
  console.log(`copied ${mp3} -> public/audio/${audio}`);
}
writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
console.log(`episodes.json: ${existing >= 0 ? "replaced" : "added"} ${entry.slug} (${label(entry)} · ${entry.title}, ${clock(seconds(entry.durationSec))}); ${list.length} episode${list.length === 1 ? "" : "s"} in all. Now deploy (DEPLOY.md).`);
