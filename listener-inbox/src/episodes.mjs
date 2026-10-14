// Episodes come from episodes.json (next to wrangler.toml); this turns them into the
// cards on the listening page, the names on the stats page and the feed at /episodes.json.
// An entry is the public part of the Studio's publish payload, written by
// scripts/add-episode.mjs (fields in ADD-EPISODE.md). The repo is public, so the
// payload's Studio link, requester id and /mnt path never go in; problems() refuses them.
// Shared by the worker and scripts/check-episodes.mjs, so it must stay plain JavaScript
// with no Workers or Node APIs.

export const SLUG = /^[a-z0-9-]{1,60}$/;          // same shape the stats endpoint accepts
export const AUDIO_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.mp3$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Seconds from a number or an "m:ss" / "h:mm:ss" string; null when it isn't one.
export function seconds(d) {
  if (typeof d === "number") return Number.isFinite(d) && d > 0 ? Math.round(d) : null;
  if (typeof d !== "string" || !/^\d+(:[0-5]\d){1,2}$/.test(d.trim())) return null;
  return d.trim().split(":").reduce((a, p) => a * 60 + Number(p), 0) || null;
}

export function clock(s) {
  s = Math.max(0, Math.round(s || 0));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function parseDate(d) {
  const m = DATE.exec(typeof d === "string" ? d : "");
  if (!m) return null;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3] ? t : null;
}

// "Week of Oct 12, 2026": the Monday of the week the date falls in.
export function weekOf(date) {
  const t = parseDate(date);
  if (!t) return "";
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return `Week of ${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`;
}

export const label = (e) => (typeof e.label === "string" && e.label.trim()) || `Episode ${e.episode}`;
export const audioFile = (e) => (typeof e.audio === "string" ? e.audio : "");
// Payload fields that must not be stored: a local path, the Studio's link and the requester.
export const PRIVATE = ["mp3", "studio", "requestedBy", "requestedAt"];
const text = (s) => typeof s === "string" && s.trim();
// "Outlet: Headline", or the headline alone.
const refText = (r) => (text(r.outlet) ? `${r.outlet.trim()}: ${r.title}` : r.title);

// Newest first: that is the card that autoplays, and when it ends the next one down plays.
export function sorted(list) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => (b.episode - a.episode) || String(b.date).localeCompare(String(a.date)));
}

// Everything a publish must get right, as a list of messages (empty when fine).
// audioExists(file) says whether public/audio/<file> is there; omit it to skip that check.
export function problems(list, audioExists) {
  const errors = [];
  if (!Array.isArray(list)) return ["episodes.json must be a JSON array of episodes"];
  const slugs = new Set(), numbers = new Set(), files = new Set();
  list.forEach((e, i) => {
    const at = `episode ${i + 1}${e && typeof e.slug === "string" ? ` (${e.slug})` : ""}`;
    const bad = (msg) => errors.push(`${at}: ${msg}`);
    if (!e || typeof e !== "object" || Array.isArray(e)) return bad("must be an object");
    if (!SLUG.test(e.slug || "")) bad(`slug must be 1-60 lowercase letters, digits or dashes, like "ep02"`);
    else if (slugs.has(e.slug)) bad("slug is used twice"); else slugs.add(e.slug);
    if (!Number.isInteger(e.episode) || e.episode < 1) bad("episode must be the episode number as a whole number (1, 2, 3...)");
    else if (numbers.has(e.episode)) bad("episode number is used twice"); else numbers.add(e.episode);
    if (!text(e.title)) bad("title is missing");
    if (!parseDate(e.date)) bad("date must be a real date written YYYY-MM-DD");
    if (seconds(e.durationSec) == null) bad("durationSec must be the length in seconds (1067)");
    const kept = PRIVATE.filter((k) => k in e);
    if (kept.length) bad(`${kept.join(", ")} must not be stored (the repo is public); add the episode with node scripts/add-episode.mjs, which keeps only the page's fields`);
    const file = audioFile(e);
    if (!AUDIO_FILE.test(file)) bad(`audio must be the MP3's file name in public/audio, like "ep02-title.mp3"`);
    else if (files.has(file)) bad(`audio file ${file} is used twice`);
    else { files.add(file); if (audioExists && !audioExists(file)) bad(`public/audio/${file} is not there`); }
    const bullets = e.summary !== undefined;
    if (bullets && (!Array.isArray(e.summary) || !e.summary.length || !e.summary.every(text))) bad("summary must be a list of one or more sentences (strings)");
    if (!bullets && !text(e.description)) bad("description (one line about the episode) or summary (a list of bullets) is needed");
    if (!Array.isArray(e.sources) || !e.sources.length) bad("sources must list at least one story with its refs (every episode shows its sources)");
    else e.sources.forEach((g, j) => {
      const where = `sources[${j}]`;
      if (!g || typeof g !== "object" || Array.isArray(g)) return bad(`${where} must be an object with story and refs`);
      if (!text(g.story)) bad(`${where}.story (the story's name) is missing`);
      if (!Array.isArray(g.refs) || !g.refs.length) return bad(`${where}.refs must list at least one link`);
      g.refs.forEach((r, k) => {
        if (!r || typeof r !== "object" || !text(r.title)) bad(`${where}.refs[${k}].title (the headline) is missing`);
        if (!r || typeof r.url !== "string" || !/^https?:\/\/\S+$/.test(r.url)) bad(`${where}.refs[${k}].url must start with http:// or https://`);
      });
    });
  });
  return errors;
}

// What /episodes.json shows: the fields the page uses, nothing from the Studio's side.
export function feed(list) {
  return sorted(list).map((e) => ({
    episode: e.episode, slug: e.slug, label: e.label, title: e.title, date: e.date, durationSec: seconds(e.durationSec),
    audio: `audio/${audioFile(e)}`, description: e.description, summary: e.summary,
    sources: (Array.isArray(e.sources) ? e.sources : []).map((g) => ({
      story: g.story, refs: (Array.isArray(g.refs) ? g.refs : []).map((r) => ({ title: r.title, outlet: r.outlet, url: r.url })),
    })),
  }));
}

// { ep01: "Episode 1 · The Agent Did What?" } for the stats page.
export function names(list) {
  return Object.fromEntries(sorted(list).map((e) => [e.slug, `${label(e)} · ${e.title}`]));
}

function card(e, newest) {
  const dur = seconds(e.durationSec) || 0, file = audioFile(e);
  const links = (e.sources || []).reduce((n, g) => n + (Array.isArray(g.refs) ? g.refs.length : 0), 0);
  const sources = (e.sources || []).map((g) => `      <div class="ref-group"><h4>${esc(g.story)}</h4><ul>
${(Array.isArray(g.refs) ? g.refs : []).map((r) => `      <li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(refText(r))}</a></li>`).join("\n")}
      </ul></div>`).join("\n");
  const about = Array.isArray(e.summary) && e.summary.length
    ? `      <ul>
${e.summary.map((s) => `        <li>${esc(s)}</li>`).join("\n")}
      </ul>`
    : `      <p class="ep-desc">${esc(e.description)}</p>`;
  return `    <article class="ep${newest ? " ep-new" : ""}" id="${esc(e.slug)}" aria-labelledby="${esc(e.slug)}-title" data-ep="${esc(e.slug)}" data-src="audio/${esc(file)}" data-dur="${dur}">
      <div class="ep-meta"><span class="num">${esc(label(e))}</span><span>${esc(weekOf(e.date))}</span><span>${clock(dur)}</span></div>
      <h3 id="${esc(e.slug)}-title">${esc(e.title)}</h3>
${about}
      <div class="player">
        <button type="button" class="play" aria-label="Play"><svg class="i-play" aria-hidden="true"><use href="#i-play"/></svg><svg class="i-pause" aria-hidden="true"><use href="#i-pause"/></svg></button>
        <div class="scrub">
          <input type="range" class="seek" min="0" max="1000" value="0" step="1" aria-label="Position in the episode">
          <div class="times"><span class="cur">0:00</span><span class="dur">${clock(dur)}</span></div>
        </div>
        <noscript><a href="audio/${esc(file)}">Download the MP3</a></noscript>
      </div>
${links ? `      <details class="refs"><summary>Sources and further reading <span class="cnt">${links}</span></summary><div class="refs-body">
${sources}
      </div></details>
` : ""}      <a class="ep-ask" href="/ask?ep=${esc(e.slug)}" data-ask="${esc(e.slug)}"><svg aria-hidden="true"><use href="#i-bubble"/></svg>Ask about this episode</a>
    </article>`;
}

// The "New this week" section with the newest episode.
export function latest(list) {
  const [newest] = sorted(list);
  if (!newest) {
    return `  <section class="latest" aria-labelledby="latest-title">
    <span class="sticker pink tilt-l" id="latest-title">Coming soon</span>
    <div class="next"><h2>Episode 1 is on its way.</h2><p>Ask us something in the meantime and we may answer it on air.</p></div>
  </section>`;
  }
  return `  <section class="latest" aria-labelledby="latest-title">
    <span class="sticker pink tilt-l" id="latest-title">New this week</span>
${card(newest, true)}
  </section>`;
}

// "Earlier episodes" with the rest, or nothing.
export function earlier(list) {
  const rest = sorted(list).slice(1);
  if (!rest.length) return "";
  return `  <section class="archive" aria-labelledby="archive-title">
    <div class="archive-head"><span class="sticker cyan tilt-r" id="archive-title">Earlier episodes</span></div>
${rest.map((e) => card(e, false)).join("\n\n")}
  </section>`;
}

export const sections = (list) => [latest(list), earlier(list)].filter(Boolean).join("\n\n");

// Fills the placeholders in src/index.html and src/stats.html. The replacement is a
// function so that "$" sequences in episode text ("$$", "$&") are kept as written.
export function listeningPage(template, list) {
  const a = latest(list), b = earlier(list);
  return template.replace("<!-- EPISODES:LATEST -->", () => a).replace("<!-- EPISODES:EARLIER -->\n", () => (b ? b + "\n" : ""));
}
export function statsPage(template, list) {
  const json = JSON.stringify(names(list)).replace(/</g, () => "\\u003c");
  return template.replace("/*EPISODE_NAMES*/{}", () => json);
}
