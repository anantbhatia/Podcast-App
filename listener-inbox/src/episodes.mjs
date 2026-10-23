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

const text = (s) => typeof s === "string" && s.trim();
// A special episode (kind "special", an out-of-cycle one) sits outside the weekly count: it has
// its own number, specialNo, and no weekly "episode" number, so the next weekly keeps its number.
export const isSpecial = (e) => !!e && typeof e === "object" && e.kind === "special";
// The badge on the card: the payload's badge or label when it says something of its own, else
// built from the number. A bare "Special episode" or "Episode" (what the Studio sends) is the
// generic kind, not the text, so it gets the number: "Special episode 1".
export const GENERIC_BADGE = /^(special\s+)?episode$/i;
export function label(e) {
  const given = [e.label, e.badge].map(text).find((s) => s && !GENERIC_BADGE.test(s));
  return given || (isSpecial(e) ? `Special episode ${e.specialNo}` : `Episode ${e.episode}`);
}
export const audioFile = (e) => (typeof e.audio === "string" ? e.audio : "");
// Payload fields that must not be stored: a local path, the Studio's link and the requester.
export const PRIVATE = ["mp3", "studio", "requestedBy", "requestedAt"];
// "Outlet: Headline", or the headline alone.
const refText = (r) => (text(r.outlet) ? `${r.outlet.trim()}: ${r.title}` : r.title);

// Newest first: that is the card that autoplays, and when it ends the next one down plays.
// The order is by publish date, so a special slots in where it aired; on the same day the
// weekly episode comes first, then the higher number.
const date = (e) => String((e && e.date) || "");
const number = (e) => (e && (isSpecial(e) ? e.specialNo : e.episode)) || 0;
export function sorted(list) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) =>
    date(b).localeCompare(date(a)) || (isSpecial(a) - isSpecial(b)) || (number(b) - number(a)));
}

// Everything a publish must get right, as a list of messages (empty when fine).
// audioExists(file) says whether public/audio/<file> is there; omit it to skip that check.
// The instant an episode went live, as the add-episode script records it: a UTC timestamp on the
// publish date or within the two days after it (a press late in the day can deploy the next).
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export function liveOn(stamp, date) {
  if (typeof stamp !== "string" || !STAMP.test(stamp)) return false;
  const t = Date.parse(stamp), day = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(t) && t >= day && t < day + 3 * 86400e3;
}

export function problems(list, audioExists) {
  const errors = [];
  if (!Array.isArray(list)) return ["episodes.json must be a JSON array of episodes"];
  const slugs = new Set(), numbers = new Set(), specials = new Set(), files = new Set();
  list.forEach((e, i) => {
    const at = `episode ${i + 1}${e && typeof e.slug === "string" ? ` (${e.slug})` : ""}`;
    const bad = (msg) => errors.push(`${at}: ${msg}`);
    if (!e || typeof e !== "object" || Array.isArray(e)) return bad("must be an object");
    if (!SLUG.test(e.slug || "")) bad(`slug must be 1-60 lowercase letters, digits or dashes, like "ep02"`);
    else if (slugs.has(e.slug)) bad("slug is used twice"); else slugs.add(e.slug);
    if (e.kind !== undefined && e.kind !== "special") bad(`kind must be "special" for an out-of-cycle episode, or left out for a weekly one`);
    if (isSpecial(e)) {
      if (!Number.isInteger(e.specialNo) || e.specialNo < 1) bad("specialNo must be the special's own number as a whole number (1, 2, 3...)");
      else if (specials.has(e.specialNo)) bad("specialNo is used twice"); else specials.add(e.specialNo);
      if ("episode" in e) bad("a special has no weekly episode number; drop episode so the weekly count stays as it is");
    } else {
      if (!Number.isInteger(e.episode) || e.episode < 1) bad("episode must be the episode number as a whole number (1, 2, 3...)");
      else if (numbers.has(e.episode)) bad("episode number is used twice"); else numbers.add(e.episode);
      if ("specialNo" in e) bad(`specialNo belongs on a special only (kind: "special")`);
    }
    for (const k of ["label", "badge"]) if (e[k] !== undefined && !text(e[k])) bad(`${k} must be a short text for the card's badge, like "Special episode 1", or left out`);
    if (!text(e.title)) bad("title is missing");
    if (!parseDate(e.date)) bad("date must be a real date written YYYY-MM-DD");
    else if (e.publishedAt !== undefined && !liveOn(e.publishedAt, e.date)) bad("publishedAt must be when the episode went live, a UTC timestamp like 2026-10-19T08:05:24Z on the publish date or within the two days after it (the add-episode script records it; leave it out for an older entry)");
    if (seconds(e.durationSec) == null) bad("durationSec must be the length in seconds (1067)");
    const kept = PRIVATE.filter((k) => k in e);
    if (kept.length) bad(`${kept.join(", ")} must not be stored (the repo is public); add the episode with node scripts/add-episode.mjs, which keeps only the page's fields`);
    const file = audioFile(e);
    if (!AUDIO_FILE.test(file)) bad(`audio must be the MP3's file name in public/audio, like "ep02-title.mp3"`);
    if (!Number.isInteger(e.bytes) || e.bytes < 1) bad("bytes must be the MP3's size in bytes, a whole number (the add-episode script records it; the podcast feed needs it)");
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
  // The page orders by date, so an episode must not be dated before a lower-numbered one of its kind.
  const entries = list.filter((e) => e && typeof e === "object" && !Array.isArray(e) && parseDate(e.date));
  for (const [special, word] of [[false, "episode"], [true, "special"]]) {
    // Only entries whose number passed above; a duplicate was reported there too, so it is skipped here.
    const same = entries.filter((e) => isSpecial(e) === special && Number.isInteger(number(e)) && number(e) >= 1).sort((a, b) => number(a) - number(b));
    for (let i = 1; i < same.length; i++) {
      const prev = same[i - 1], e = same[i];
      if (number(e) === number(prev)) continue;
      if (e.date < prev.date) errors.push(`${word} ${number(e)} (${e.slug}) is dated ${e.date}, before ${word} ${number(prev)} (${prev.date}); the page orders by date, so check the dates`);
    }
  }
  return errors;
}

// What /episodes.json shows: the fields the page uses, nothing from the Studio's side.
export function feed(list) {
  return sorted(list).map((e) => ({
    episode: e.episode, kind: e.kind, specialNo: e.specialNo, slug: e.slug, label: label(e), title: e.title, date: e.date, durationSec: seconds(e.durationSec),
    audio: `audio/${audioFile(e)}`, bytes: e.bytes, description: e.description, summary: e.summary,
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
  const sources = (e.sources || []).map((g) => `      <div class="ref-group"><h3>${esc(g.story)}</h3><ul>
${(Array.isArray(g.refs) ? g.refs : []).map((r) => `      <li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(refText(r))}</a></li>`).join("\n")}
      </ul></div>`).join("\n");
  const about = Array.isArray(e.summary) && e.summary.length
    ? `      <ul>
${e.summary.map((s) => `        <li>${esc(s)}</li>`).join("\n")}
      </ul>`
    : `      <p class="ep-desc">${esc(e.description)}</p>`;
  return `    <article class="ep${newest ? " ep-new" : ""}${isSpecial(e) ? " ep-special" : ""}" id="${esc(e.slug)}" aria-labelledby="${esc(e.slug)}-title" data-ep="${esc(e.slug)}" data-src="audio/${esc(file)}" data-dur="${dur}">
      <div class="ep-meta"><span class="num">${esc(label(e))}</span><span>${esc(weekOf(e.date))}</span><span>${clock(dur)}</span></div>
      <h2 id="${esc(e.slug)}-title">${esc(e.title)}</h2>
      <div class="player">
        <div class="controls">
          <button type="button" class="skip back" aria-label="Back 15 seconds" title="Back 15 seconds"><svg aria-hidden="true"><use href="#i-back15"/></svg></button>
          <button type="button" class="play" aria-label="Play"><svg class="i-play" aria-hidden="true"><use href="#i-play"/></svg><svg class="i-pause" aria-hidden="true"><use href="#i-pause"/></svg></button>
          <button type="button" class="skip fwd" aria-label="Ahead 15 seconds" title="Ahead 15 seconds"><svg aria-hidden="true"><use href="#i-fwd15"/></svg></button>
        </div>
        <div class="scrub">
          <input type="range" class="seek" min="0" max="1000" value="0" step="1" aria-label="Position in the episode">
          <div class="times"><span class="cur">0:00</span><span class="dur">${clock(dur)}</span></div>
        </div>
        <noscript><a href="audio/${esc(file)}">Download the MP3</a></noscript>
      </div>
${about}
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

const SITE = "Two Hallucinating PMs";
const TAGLINE = "A weekly AI news show with Anant and Aman. AI trends that get outdated by Monday and obsolete by launch.";
export const bySlug = (list, slug) => (SLUG.test(slug || "") ? sorted(list).find((e) => e.slug === slug) : undefined) || null;

// What a shared link shows as a card (Substack, WhatsApp, LinkedIn, Slack read the Open Graph tags):
// the episode's title and description, with its length and a nudge to tap.
export function shareMeta(e, origin, path) {
  const mins = e ? Math.round((seconds(e.durationSec) || 0) / 60) : 0;
  return {
    TITLE: e && path !== "/" ? `${e.title} · ${SITE}` : SITE, // the tab title: the show on "/", the episode on "/<slug>"
    OGTITLE: e ? `${label(e)} · ${e.title} | ${SITE}` : SITE,
    DESC: e ? [e.description || "", mins ? `${mins} min` : "", "Tap to listen"].filter(Boolean).join(" · ") : TAGLINE,
    URL: origin + path, URLENC: encodeURIComponent(origin + path), ORIGIN: origin,
  };
}

// Fills "<!-- META:NAME -->" placeholders (escaped), and "<!-- META:BODY -->" with raw attributes.
function fillMeta(template, values, bodyAttrs = "") {
  return template.replace(/<!-- META:(\w+) -->/g, (m, k) => (k === "BODY" ? bodyAttrs : esc(values[k] ?? "")));
}

// Fills the placeholders in src/index.html and src/stats.html. The replacement is a
// function so that "$" sequences in episode text ("$$", "$&") are kept as written.
// `start` names the episode a "/<slug>" link opens on; "/" opens on the newest.
export function listeningPage(template, list, { origin = "", start = "" } = {}) {
  const a = latest(list), b = earlier(list);
  const e = start ? bySlug(list, start) : sorted(list)[0];
  const page = fillMeta(template, shareMeta(e, origin, start ? `/${start}` : "/"), start && e ? ` data-start="${esc(start)}"` : "");
  return page.replace("<!-- EPISODES:LATEST -->", () => a).replace("<!-- EPISODES:EARLIER -->\n", () => (b ? b + "\n" : ""));
}

// The compact player at "/embed" (newest) and "/embed/<slug>", for sites that allow an iframe.
export function embedPage(template, list, slug, origin = "") {
  const e = slug ? bySlug(list, slug) : sorted(list)[0];
  if (!e) return null;
  const dur = seconds(e.durationSec) || 0;
  const v = { SLUG: e.slug, LABEL: label(e), TITLE: e.title, SRC: `/audio/${audioFile(e)}`, DUR: String(dur), CLOCK: clock(dur), URL: `${origin}/${e.slug}?from=embed`, ORIGIN: origin };
  return template.replace(/<!-- EP:(\w+) -->/g, (m, k) => esc(v[k] ?? ""));
}

// oEmbed for a page link (used by sites that discover it: WordPress, Ghost, Notion and others).
export function oembed(list, origin, target) {
  let path = "", hash = "";
  try { const u = new URL(target); if (u.origin !== origin) return null; path = u.pathname.replace(/\/+$/, ""); hash = u.hash.slice(1); } catch { return null; }
  const m = /^\/(?:embed\/)?([a-z0-9-]{1,60})$/.exec(path);
  const e = m ? bySlug(list, m[1]) : path === "" || path === "/embed" ? (hash ? bySlug(list, hash) : sorted(list)[0]) : null;
  if (!e) return null;
  const title = `${label(e)} · ${e.title}`;
  return {
    version: "1.0", type: "rich", provider_name: SITE, provider_url: origin + "/", author_name: "Anant and Aman",
    title, width: 720, height: 210,
    html: `<iframe src="${origin}/embed/${e.slug}" width="100%" height="210" style="max-width:720px;border:0" frameborder="0" scrolling="no" loading="lazy" title="${esc(title)}"></iframe>`,
    thumbnail_url: `${origin}/img/og.jpg`, thumbnail_width: 1200, thumbnail_height: 630,
  };
}
export function statsPage(template, list) {
  const json = JSON.stringify(names(list)).replace(/</g, () => "\\u003c");
  return template.replace("/*EPISODE_NAMES*/{}", () => json);
}
