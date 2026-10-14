// Episodes come from public/episodes.json; this turns them into the cards on the
// listening page and the names on the stats page. Publishing an episode is adding
// the MP3 to public/audio, adding one entry to the JSON and deploying (ADD-EPISODE.md).
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

export const label = (e) => (typeof e.label === "string" && e.label.trim()) || `Episode ${e.number}`;

// Newest first: that is the card that autoplays, and when it ends the next one down plays.
export function sorted(list) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => (b.number - a.number) || String(b.date).localeCompare(String(a.date)));
}

// Everything a publish must get right, as a list of messages (empty when fine).
// audioExists(file) says whether public/audio/<file> is there; omit it to skip that check.
export function problems(list, audioExists) {
  const errors = [];
  if (!Array.isArray(list)) return ["episodes.json must be a JSON array of episodes"];
  const slugs = new Set(), numbers = new Set();
  list.forEach((e, i) => {
    const at = `episode ${i + 1}${e && typeof e.slug === "string" ? ` (${e.slug})` : ""}`;
    const bad = (msg) => errors.push(`${at}: ${msg}`);
    if (!e || typeof e !== "object" || Array.isArray(e)) return bad("must be an object");
    if (!SLUG.test(e.slug || "")) bad(`slug must be 1-60 lowercase letters, digits or dashes, like "ep02"`);
    else if (slugs.has(e.slug)) bad("slug is used twice"); else slugs.add(e.slug);
    if (!Number.isInteger(e.number) || e.number < 1) bad("number must be a whole number from 1 (1, 2, 3...)");
    else if (numbers.has(e.number)) bad("number is used twice"); else numbers.add(e.number);
    if (typeof e.title !== "string" || !e.title.trim()) bad("title is missing");
    if (!parseDate(e.date)) bad(`date must be a real date written YYYY-MM-DD`);
    if (seconds(e.duration) == null) bad(`duration must be seconds (1067) or "m:ss" (17:47)`);
    if (!AUDIO_FILE.test(e.audio || "")) bad(`audio must be the MP3's file name in public/audio, like "ep02-title.mp3"`);
    else if (audioExists && !audioExists(e.audio)) bad(`public/audio/${e.audio} is not there`);
    if (!Array.isArray(e.summary) || !e.summary.length || !e.summary.every((s) => typeof s === "string" && s.trim())) bad("summary must be a list of one or more sentences (strings)");
    if (!Array.isArray(e.sources) || !e.sources.length) bad("sources must list at least one story with its links (every episode shows its sources)");
    else e.sources.forEach((g, j) => {
      const where = `sources[${j}]`;
      if (!g || typeof g !== "object") return bad(`${where} must be an object with story and links`);
      if (typeof g.story !== "string" || !g.story.trim()) bad(`${where}.story (the story's name) is missing`);
      if (!Array.isArray(g.links) || !g.links.length) return bad(`${where}.links must list at least one link`);
      g.links.forEach((l, k) => {
        if (!l || typeof l.title !== "string" || !l.title.trim()) bad(`${where}.links[${k}].title is missing`);
        if (!l || typeof l.url !== "string" || !/^https?:\/\/\S+$/.test(l.url)) bad(`${where}.links[${k}].url must start with http:// or https://`);
      });
    });
  });
  return errors;
}

// { ep01: "Episode 1 · The Agent Did What?" } for the stats page.
export function names(list) {
  return Object.fromEntries(sorted(list).map((e) => [e.slug, `${label(e)} · ${e.title}`]));
}

function card(e, newest) {
  const dur = seconds(e.duration) || 0;
  const links = (e.sources || []).reduce((n, g) => n + (g.links || []).length, 0);
  const sources = (e.sources || []).map((g) => `      <div class="ref-group"><h4>${esc(g.story)}</h4><ul>
${(g.links || []).map((l) => `      <li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a></li>`).join("\n")}
      </ul></div>`).join("\n");
  return `    <article class="ep${newest ? " ep-new" : ""}" aria-labelledby="${esc(e.slug)}-title" data-ep="${esc(e.slug)}" data-src="audio/${esc(e.audio)}" data-dur="${dur}">
      <div class="ep-meta"><span class="num">${esc(label(e))}</span><span>${esc(weekOf(e.date))}</span><span>${clock(dur)}</span></div>
      <h3 id="${esc(e.slug)}-title">${esc(e.title)}</h3>
      <ul>
${(e.summary || []).map((s) => `        <li>${esc(s)}</li>`).join("\n")}
      </ul>
      <div class="player">
        <button type="button" class="play" aria-label="Play"><svg class="i-play" aria-hidden="true"><use href="#i-play"/></svg><svg class="i-pause" aria-hidden="true"><use href="#i-pause"/></svg></button>
        <div class="scrub">
          <input type="range" class="seek" min="0" max="1000" value="0" step="1" aria-label="Position in the episode">
          <div class="times"><span class="cur">0:00</span><span class="dur">${clock(dur)}</span></div>
        </div>
        <noscript><a href="audio/${esc(e.audio)}">Download the MP3</a></noscript>
      </div>
${links ? `      <details class="refs"><summary>Sources and further reading <span class="cnt">${links}</span></summary><div class="refs-body">
${sources}
      </div></details>
` : ""}      <a class="ep-ask" href="/ask?ep=${esc(e.slug)}" data-ask="${esc(e.slug)}"><svg aria-hidden="true"><use href="#i-bubble"/></svg>Ask about this episode</a>
    </article>`;
}

// The "New this week" section with the newest episode, then "Earlier episodes" with the rest.
export function sections(list) {
  const [newest, ...rest] = sorted(list);
  if (!newest) {
    return `  <section class="latest" aria-labelledby="latest-title">
    <span class="sticker pink tilt-l" id="latest-title">Coming soon</span>
    <div class="next"><h2>Episode 1 is on its way.</h2><p>Ask us something in the meantime and we may answer it on air.</p></div>
  </section>`;
  }
  let out = `  <section class="latest" aria-labelledby="latest-title">
    <span class="sticker pink tilt-l" id="latest-title">New this week</span>
${card(newest, true)}
  </section>`;
  if (rest.length) {
    out += `

  <section class="archive" aria-labelledby="archive-title">
    <div class="archive-head"><span class="sticker cyan tilt-r" id="archive-title">Earlier episodes</span></div>
${rest.map((e) => card(e, false)).join("\n\n")}
  </section>`;
  }
  return out;
}

// Fills the placeholders in src/index.html and src/stats.html.
export function listeningPage(template, list) {
  return template.replace("<!-- EPISODES -->", sections(list));
}
export function statsPage(template, list) {
  return template.replace("/*EPISODE_NAMES*/{}", JSON.stringify(names(list)).replace(/</g, "\\u003c"));
}
