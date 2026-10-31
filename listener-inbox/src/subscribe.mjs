// Email sign-ups for new episodes, in Workers KV next to the inbox:
//   subs/<token>.json  { email, since, ep, notified: [slugs already emailed about], name, clipsFor }
//   subidx/<sha256(email)>  -> token   (one sign-up per address)
//   greet/<gid>  -> token   (gid = sha256("greet:" + token): the id in a listen link)
//   greetclip/<gid>/<slot>  the spoken greeting with the name, rendered at a publish (MP3 bytes)
// The record is stored as the value AND as the key's metadata, so the hosts' listing
// reads it from a single list() call: on the free plan a request may make 50 calls to
// KV and the like in all, and one get per sign-up would hit that at 49 sign-ups.
// The worker can't send email. At each publish, the publishing session lists the
// sign-ups with INBOX_TOKEN (/api/subscribers?ep=), emails them from Anant's Gmail with
// each one's listen link and unsubscribe link, then marks them notified (/api/notified)
// so a re-run doesn't email anyone twice. See ADD-EPISODE.md.
//
// The greeting (Studio requests "Dynamic salutation" and "Call out the listener's name"):
// the listen link in a subscriber's email carries their gid (never the unsubscribe
// token), the page keeps it in that browser, and GET /api/greet?g= tells the page the
// name to greet them by and whether a spoken greeting with it is rendered. The name comes
// from the sign-up form, from the page (POST /api/greet/name, by whoever holds the link),
// or from a host (POST /api/subscribers/name). Names and addresses stay in KV: never in
// the stats, the repo or a thread.
import { recordEvent, countToday } from "./stats.js";

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const TOKEN = /^[0-9a-f]{32}$/;
const GID = /^[0-9a-f]{64}$/;
const MAX_EMAIL = 254;
const SLUG = /^[a-z0-9-]{1,60}$/;
const KEEP = 24;           // slugs remembered per sign-up (metadata is capped at 1 KB); only recent ones matter
export const MARK_MAX = 40; // addresses marked per /api/notified call (one KV write each, under the 50-call limit)
const MAX_NEW_PER_DAY = 50;  // new sign-ups a day: bounds what a script can add before a publish (each is three KV writes)
const INDEX_MAX = 20;        // sign-ups from before the greeting that one listing gives a greet index (two writes each)
export const MAX_NAME = 24;
// A first name as people write them: letters in any script, with hyphens or apostrophes inside,
// up to three words. Tight on purpose: the hosts' cloned voices say it and the episode email
// opens with it, so no sentences, dots, digits or links.
const WORD = "[\\p{L}\\p{M}]+(?:['’-][\\p{L}\\p{M}]+)*";
const NAME = new RegExp(`^${WORD}(?: ${WORD}){0,2}$`, "u");
const NAME_RULE = `A first name is letters only, up to three words and ${MAX_NAME} characters.`;
const MAX_NAME_CHANGES_PER_DAY = 100; // name changes from the page a day (each is a KV write; the free plan allows 1,000)
export const SLOTS = ["morning", "afternoon", "evening"];
export const MAX_CLIP_BYTES = 200 * 1024; // a few seconds of speech at 96 kbps is under 60 KB

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function normalizeEmail(raw) {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return email.length <= MAX_EMAIL && EMAIL.test(email) ? email : null;
}

// The name to greet someone by: "" when none was given, null when it isn't a name.
export function cleanName(raw) {
  if (raw == null) return "";
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return "";
  return name.length <= MAX_NAME && NAME.test(name) ? name : null;
}

async function sha256(s) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const hash = (email) => sha256(email);
// The id in a listen link. One way from the token, so a forwarded link can't unsubscribe anyone.
export const greetId = (token) => sha256(`greet:${token}`);

// Body as fields, whether the page sent a form or JSON.
async function fields(request) {
  const type = request.headers.get("content-type") || "";
  try {
    if (type.includes("json")) {
      const raw = await request.text();
      if (raw.length > 20000) return null;
      const o = JSON.parse(raw);
      return o && typeof o === "object" ? o : null;
    }
    const form = await request.formData();
    return Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
  } catch {
    return null;
  }
}

const key = (token) => `subs/${token}.json`;
const clipKey = (gid, slot) => `greetclip/${gid}/${slot}`;
function store(env, token, rec) {
  const record = {
    email: rec.email, since: rec.since, ep: rec.ep || "", notified: (rec.notified || []).slice(-KEEP),
    name: typeof rec.name === "string" ? rec.name.slice(0, MAX_NAME) : "",
    clipsFor: typeof rec.clipsFor === "string" ? rec.clipsFor.slice(0, MAX_NAME) : "", // the name the stored clips say
    gi: rec.gi ? 1 : 0, // the greet index is written
  };
  return env.INBOX.put(key(token), JSON.stringify(record), { metadata: record });
}
// Writes greet/<gid> -> token for a sign-up that has none yet (ones from before the greeting).
async function indexGreet(env, token, rec) {
  if (rec.gi) return rec;
  await env.INBOX.put(`greet/${await greetId(token)}`, token);
  const next = { ...rec, gi: 1 };
  await store(env, token, next);
  return next;
}

// POST /api/subscribe  (email, name = optional first name, website = honeypot, ep = episode on the page, listenerId)
export async function subscribe(request, env, ctx) {
  const f = await fields(request);
  if (!f) return json({ error: "Send the email address as a form or JSON." }, 400);
  if (typeof f.website === "string" && f.website.trim()) return json({ ok: true }); // bots fill every field
  const email = normalizeEmail(f.email);
  if (!email) return json({ error: "That doesn't look like an email address." }, 400);
  const name = cleanName(f.name);
  if (name === null) return json({ error: NAME_RULE }, 400);

  const idx = `subidx/${await hash(email)}`;
  const already = await env.INBOX.get(idx);
  // An address already signed up keeps its name: the form can't rename someone else's sign-up.
  if (already && (await env.INBOX.get(key(already)))) return json({ ok: true, already: true });

  if ((await countToday(env, "subscribe")) >= MAX_NEW_PER_DAY) return json({ error: "Sign-ups are paused for today. Try again tomorrow." }, 429);

  const token = crypto.randomUUID().replace(/-/g, "");
  const ep = typeof f.ep === "string" && SLUG.test(f.ep) ? f.ep : "";
  await env.INBOX.put(`greet/${await greetId(token)}`, token);
  await store(env, token, { email, since: new Date().toISOString(), ep, notified: [], name, gi: 1 });
  await env.INBOX.put(idx, token);
  // Counts as a conversion in the listening stats; the address and name are not copied there.
  ctx.waitUntil(recordEvent(request, env, { type: "subscribe", ep, v: typeof f.listenerId === "string" ? f.listenerId : null }).catch(() => {}));
  // The new sign-up's greet id, so this browser is greeted by the name from now on (an address
  // already signed up gets none: the form must not reveal whose name an address carries).
  return json({ ok: true, gid: await greetId(token) });
}

async function remove(env, token) {
  const rec = await env.INBOX.get(key(token), { type: "json" });
  if (!rec) return false;
  await env.INBOX.delete(key(token));
  await env.INBOX.delete(`subidx/${await hash(rec.email)}`);
  const gid = await greetId(token);
  await env.INBOX.delete(`greet/${gid}`);
  for (const slot of SLOTS) await env.INBOX.delete(clipKey(gid, slot));
  return true;
}

// Whether the token from an email's link still names a sign-up (the /unsubscribe page asks before removing it).
export async function signupExists(env, token) {
  return TOKEN.test(token || "") && (await env.INBOX.get(key(token))) !== null;
}

// POST /api/unsubscribe, from the /unsubscribe page: either `t`, the token from the link in an
// email (the page asks for a click first, so a mail scanner that opens every link can't
// unsubscribe anyone), or `email`, typed in by someone without their email.
export async function unsubscribeByEmail(request, env) {
  const f = await fields(request);
  if (!f) return json({ error: "Send the email address as a form or JSON." }, 400);
  if (typeof f.website === "string" && f.website.trim()) return json({ ok: true });
  if (typeof f.t === "string" && f.t) {
    if (!TOKEN.test(f.t)) return json({ error: "That link is incomplete." }, 400);
    return json({ ok: true, removed: await remove(env, f.t) });
  }
  const email = normalizeEmail(f.email);
  if (!email) return json({ error: "That doesn't look like an email address." }, 400);
  const token = await env.INBOX.get(`subidx/${await hash(email)}`);
  if (token) await remove(env, token);
  // The same answer whether or not the address was signed up, so the form can't be used to check addresses.
  return json({ ok: true });
}

// The sign-up a listen link's gid names, with its token; null for an unknown or spent id.
async function byGreetId(env, gid) {
  if (!GID.test(gid || "")) return null;
  const token = await env.INBOX.get(`greet/${gid}`);
  const rec = token && (await env.INBOX.get(key(token), { type: "json" }));
  return rec ? { token, gid, ...rec } : null;
}
const greeting = (rec) => ({ name: rec.name || "", clips: Boolean(rec.name) && rec.clipsFor === rec.name });
// A changed or cleared name drops the clips that say the old one (they would stay downloadable otherwise).
async function rename(env, token, gid, plain, name) {
  if (plain.clipsFor) for (const slot of SLOTS) await env.INBOX.delete(clipKey(gid, slot));
  await store(env, token, { ...plain, name, clipsFor: "" });
  return { ...plain, name, clipsFor: "" };
}

// GET /api/greet?g=<gid>: who the page is greeting (the name may be empty: then the page asks
// for one) and whether the spoken greeting with that name is there (/greet/<gid>/<slot>.mp3).
export async function greet(request, env) {
  const rec = await byGreetId(env, new URL(request.url).searchParams.get("g"));
  if (!rec) return json({ error: "unknown" }, 404);
  return new Response(JSON.stringify(greeting(rec)), { headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
}

// POST /api/greet/name { g, name }: the listener sets, changes or clears the name on their
// own sign-up, from the page their link opened. New clips come at the next publish; until
// then `clips` is false and the page plays the generic greeting. Counted per day like the
// other public writes, so a script holding one id can't use up the plan's KV writes.
export async function setGreetName(request, env, ctx) {
  const f = await fields(request);
  if (!f) return json({ error: "Send { g, name }." }, 400);
  if (typeof f.website === "string" && f.website.trim()) return json({ ok: true });
  const name = cleanName(f.name);
  if (name === null) return json({ error: NAME_RULE }, 400);
  const rec = await byGreetId(env, typeof f.g === "string" ? f.g : "");
  if (!rec) return json({ error: "That link is spent. Sign up again on the page to be greeted by name." }, 404);
  const { token, gid, ...plain } = rec;
  if (plain.name === name) return json({ ok: true, ...greeting(plain) });
  if ((await countToday(env, "greet_name")) >= MAX_NAME_CHANGES_PER_DAY) return json({ error: "Name changes are paused for today. Try again tomorrow." }, 429);
  const next = await rename(env, token, gid, plain, name);
  ctx.waitUntil(recordEvent(request, env, { type: "greet_name", ep: "" }).catch(() => {}));
  return json({ ok: true, ...greeting(next) });
}

// Hosts only. POST /api/subscribers/name { email, name }: a host sets the name for a sign-up.
export async function setSubscriberName(request, env) {
  const f = await fields(request);
  const email = f && normalizeEmail(f.email);
  if (!email) return json({ error: "Send { email, name }." }, 400);
  const name = cleanName(f.name);
  if (name === null) return json({ error: NAME_RULE }, 400);
  const token = await env.INBOX.get(`subidx/${await hash(email)}`);
  const rec = token && (await env.INBOX.get(key(token), { type: "json" }));
  if (!rec) return json({ error: "That address isn't signed up." }, 404);
  const gid = await greetId(token);
  let next = await indexGreet(env, token, rec);
  if (next.name !== name) next = await rename(env, token, gid, next, name);
  return json({ ok: true, name, gid, ...greeting(next) });
}

// GET /greet/<gid>/<slot>.mp3: the spoken greeting with this listener's name, or 404 before
// one is rendered (the page then plays the show's generic one). The bytes, for the range helper.
export async function greetClip(env, gid, slot) {
  if (!GID.test(gid || "") || !SLOTS.includes(slot)) return null;
  return env.INBOX.get(clipKey(gid, slot), { type: "arrayBuffer" });
}

// Hosts only. PUT /api/greet/<gid>/<slot> with the MP3 as the body stores a rendered
// greeting; POST /api/greet/<gid>/clips { for: <name> } then records which name the three
// clips say (scripts/greet-clips.mjs does both at a publish).
export async function putGreetClip(request, env, gid, slot) {
  if (!GID.test(gid || "") || !SLOTS.includes(slot)) return json({ error: "bad id or slot" }, 400);
  if (!(await env.INBOX.get(`greet/${gid}`))) return json({ error: "unknown" }, 404);
  const buf = await request.arrayBuffer();
  if (buf.byteLength < 1000 || buf.byteLength > MAX_CLIP_BYTES) return json({ error: `an MP3 between 1 KB and ${MAX_CLIP_BYTES} bytes` }, 400);
  await env.INBOX.put(clipKey(gid, slot), buf);
  return json({ ok: true, slot, bytes: buf.byteLength });
}
export async function markGreetClips(request, env, gid) {
  const f = await fields(request);
  const name = f && cleanName(f.for);
  if (!name) return json({ error: "Send { for: <the name the clips say> }." }, 400);
  const rec = await byGreetId(env, gid);
  if (!rec) return json({ error: "unknown" }, 404);
  const { token, gid: g, ...plain } = rec;
  await store(env, token, { ...plain, clipsFor: name });
  return json({ ok: true, clipsFor: name, current: plain.name === name });
}

// Every sign-up from the list's metadata (a record written without it is read once and repaired).
async function* records(env) {
  let cursor;
  do {
    const page = await env.INBOX.list({ prefix: "subs/", cursor });
    for (const { name, metadata } of page.keys) {
      const token = name.slice("subs/".length, -".json".length);
      let rec = metadata && metadata.email ? metadata : null;
      if (!rec) {
        rec = await env.INBOX.get(name, { type: "json" });
        if (rec) await store(env, token, rec);
      }
      if (rec) yield { token, ...rec };
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

// Hosts only. GET /api/subscribers?ep=<slug> lists sign-ups not yet emailed about that
// episode (all of them without ep), each with its name, its listen link for the email (it
// carries the gid, so the page greets them) and its own unsubscribe link. `clipsFor` is the
// name the stored spoken greeting says ("" before one is rendered). Sign-ups from before the
// greeting get their greet index here, INDEX_MAX per call; one still without it has a plain
// listen link (`greet` false) and `unindexed` counts them, so the caller lists again until 0.
export async function listSubscribers(request, env) {
  const url = new URL(request.url);
  const ep = url.searchParams.get("ep") || "";
  if (ep && !SLUG.test(ep)) return json({ error: "bad ep" }, 400);
  const items = [];
  let count = 0, indexed = 0, unindexed = 0;
  for await (let r of records(env)) {
    count++;
    if (!r.gi && indexed < INDEX_MAX) { r = { ...r, ...(await indexGreet(env, r.token, r)) }; indexed++; }
    if (!r.gi) unindexed++;
    if (ep && (r.notified || []).includes(ep)) continue;
    const gid = r.gi ? await greetId(r.token) : "";
    items.push({
      email: r.email, name: r.name || "", since: r.since, notified: r.notified || [], gid, greet: Boolean(r.gi), clipsFor: r.clipsFor || "",
      listen: `${url.origin}/${ep}?from=email${gid ? `&l=${gid}` : ""}`,
      unsubscribe: `${url.origin}/unsubscribe?t=${r.token}`,
    });
  }
  items.sort((a, b) => a.since.localeCompare(b.since));
  return json({ count, ep, pending: items.length, unindexed, items });
}

// Hosts only. POST /api/notified { ep, emails: [...] } after the emails went out; up to
// MARK_MAX addresses per call (the answer's `skipped` says how many it didn't get to).
export async function markNotified(request, env) {
  const f = await fields(request);
  if (!f || !SLUG.test(f.ep || "") || !Array.isArray(f.emails)) return json({ error: "Send { ep, emails: [...] }." }, 400);
  const given = [...new Set(f.emails.map(normalizeEmail).filter(Boolean))];
  const wanted = new Set(given.slice(0, MARK_MAX));
  let marked = 0, already = 0;
  for await (const r of records(env)) {
    if (!wanted.delete(r.email)) continue;
    if ((r.notified || []).includes(f.ep)) { already++; continue; }
    await store(env, r.token, { ...r, notified: [...(r.notified || []), f.ep] });
    marked++;
  }
  return json({ ok: true, ep: f.ep, marked, already, unknown: wanted.size, skipped: given.length - Math.min(given.length, MARK_MAX) });
}

// How many sign-ups there are, for the stats page.
export async function subscriberCount(env) {
  let n = 0, cursor;
  do {
    const page = await env.INBOX.list({ prefix: "subs/", cursor });
    n += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return n;
}
