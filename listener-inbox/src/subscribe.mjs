// Email sign-ups for new episodes, in Workers KV next to the inbox:
//   subs/<token>.json  { email, since, ep, notified: [slugs already emailed about] }
//   subidx/<sha256(email)>  -> token   (one sign-up per address)
// The record is stored as the value AND as the key's metadata, so the hosts' listing
// reads it from a single list() call: on the free plan a request may make 50 calls to
// KV and the like in all, and one get per sign-up would hit that at 49 sign-ups.
// The worker can't send email. At each publish, the publishing session lists the
// sign-ups with INBOX_TOKEN (/api/subscribers?ep=), emails them from Anant's Gmail with
// each one's unsubscribe link, then marks them notified (/api/notified) so a re-run
// doesn't email anyone twice. See ADD-EPISODE.md.
import { recordEvent, countToday } from "./stats.js";

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const TOKEN = /^[0-9a-f]{32}$/;
const MAX_EMAIL = 254;
const SLUG = /^[a-z0-9-]{1,60}$/;
const KEEP = 30;           // slugs remembered per sign-up (metadata is capped at 1 KB); only recent ones matter
export const MARK_MAX = 40; // addresses marked per /api/notified call (one KV write each, under the 50-call limit)
const MAX_NEW_PER_DAY = 50;  // new sign-ups a day: bounds what a script can add before a publish (each is two KV writes)

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function normalizeEmail(raw) {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return email.length <= MAX_EMAIL && EMAIL.test(email) ? email : null;
}

async function hash(email) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
function store(env, token, rec) {
  const record = { email: rec.email, since: rec.since, ep: rec.ep || "", notified: (rec.notified || []).slice(-KEEP) };
  return env.INBOX.put(key(token), JSON.stringify(record), { metadata: record });
}

// POST /api/subscribe  (email, website = honeypot, ep = episode on the page, listenerId)
export async function subscribe(request, env, ctx) {
  const f = await fields(request);
  if (!f) return json({ error: "Send the email address as a form or JSON." }, 400);
  if (typeof f.website === "string" && f.website.trim()) return json({ ok: true }); // bots fill every field
  const email = normalizeEmail(f.email);
  if (!email) return json({ error: "That doesn't look like an email address." }, 400);

  const idx = `subidx/${await hash(email)}`;
  const already = await env.INBOX.get(idx);
  if (already && (await env.INBOX.get(key(already)))) return json({ ok: true, already: true });

  if ((await countToday(env, "subscribe")) >= MAX_NEW_PER_DAY) return json({ error: "Sign-ups are paused for today. Try again tomorrow." }, 429);

  const token = crypto.randomUUID().replace(/-/g, "");
  const ep = typeof f.ep === "string" && SLUG.test(f.ep) ? f.ep : "";
  await store(env, token, { email, since: new Date().toISOString(), ep, notified: [] });
  await env.INBOX.put(idx, token);
  // Counts as a conversion in the listening stats; the address is not copied there.
  ctx.waitUntil(recordEvent(request, env, { type: "subscribe", ep, v: typeof f.listenerId === "string" ? f.listenerId : null }).catch(() => {}));
  return json({ ok: true });
}

async function remove(env, token) {
  const rec = await env.INBOX.get(key(token), { type: "json" });
  if (!rec) return false;
  await env.INBOX.delete(key(token));
  await env.INBOX.delete(`subidx/${await hash(rec.email)}`);
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
// episode (all of them without ep), each with its own unsubscribe link.
export async function listSubscribers(request, env) {
  const url = new URL(request.url);
  const ep = url.searchParams.get("ep") || "";
  if (ep && !SLUG.test(ep)) return json({ error: "bad ep" }, 400);
  const items = [];
  let count = 0;
  for await (const r of records(env)) {
    count++;
    if (ep && (r.notified || []).includes(ep)) continue;
    items.push({ email: r.email, since: r.since, notified: r.notified || [], unsubscribe: `${url.origin}/unsubscribe?t=${r.token}` });
  }
  items.sort((a, b) => a.since.localeCompare(b.since));
  return json({ count, ep, pending: items.length, items });
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
