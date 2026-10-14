// Email sign-ups for new episodes, in Workers KV next to the inbox:
//   subs/<token>.json  { email, since, ep, notified: [slugs already emailed about] }
//   subidx/<sha256(email)>  -> token   (one sign-up per address)
// The worker can't send email. At each publish, the publishing session lists the
// sign-ups with INBOX_TOKEN (/api/subscribers?ep=), emails them from Anant's Gmail with
// each one's unsubscribe link, then marks them notified (/api/notified) so a re-run
// doesn't email anyone twice. See ADD-EPISODE.md.
import { recordEvent } from "./stats.js";

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const TOKEN = /^[0-9a-f]{32}$/;
const MAX_EMAIL = 254;
const SLUG = /^[a-z0-9-]{1,60}$/;

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
      if (raw.length > 2000) return null;
      const o = JSON.parse(raw);
      return o && typeof o === "object" ? o : null;
    }
    const form = await request.formData();
    return Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
  } catch {
    return null;
  }
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
  if (already && (await env.INBOX.get(`subs/${already}.json`))) return json({ ok: true, already: true });

  const token = crypto.randomUUID().replace(/-/g, "");
  const ep = typeof f.ep === "string" && SLUG.test(f.ep) ? f.ep : "";
  const record = { email, since: new Date().toISOString(), ep, notified: [] };
  await env.INBOX.put(`subs/${token}.json`, JSON.stringify(record));
  await env.INBOX.put(idx, token);
  // Counts as a conversion in the listening stats; the address is not copied there.
  ctx.waitUntil(recordEvent(request, env, { type: "subscribe", ep, v: typeof f.listenerId === "string" ? f.listenerId : null }).catch(() => {}));
  return json({ ok: true });
}

async function remove(env, token) {
  const rec = await env.INBOX.get(`subs/${token}.json`, { type: "json" });
  if (!rec) return false;
  await env.INBOX.delete(`subs/${token}.json`);
  await env.INBOX.delete(`subidx/${await hash(rec.email)}`);
  return true;
}

// GET /unsubscribe?t=<token> from the link in an email; true when a sign-up was removed.
export async function unsubscribeByToken(env, token) {
  return TOKEN.test(token || "") ? remove(env, token) : false;
}

// POST /api/unsubscribe (email) from the form on /unsubscribe, for someone without their email.
export async function unsubscribeByEmail(request, env) {
  const f = await fields(request);
  if (!f) return json({ error: "Send the email address as a form or JSON." }, 400);
  if (typeof f.website === "string" && f.website.trim()) return json({ ok: true });
  const email = normalizeEmail(f.email);
  if (!email) return json({ error: "That doesn't look like an email address." }, 400);
  const token = await env.INBOX.get(`subidx/${await hash(email)}`);
  if (token) await remove(env, token);
  // The same answer whether or not the address was signed up, so the form can't be used to check addresses.
  return json({ ok: true });
}

async function* records(env) {
  let cursor;
  do {
    const page = await env.INBOX.list({ prefix: "subs/", cursor });
    for (const { name } of page.keys) {
      const rec = await env.INBOX.get(name, { type: "json" });
      if (rec) yield { token: name.slice("subs/".length, -".json".length), ...rec };
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

// Hosts only. POST /api/notified { ep, emails: [...] } after the emails went out.
export async function markNotified(request, env) {
  const f = await fields(request);
  if (!f || !SLUG.test(f.ep || "") || !Array.isArray(f.emails)) return json({ error: "Send { ep, emails: [...] }." }, 400);
  let marked = 0, unknown = 0;
  for (const raw of f.emails.slice(0, 1000)) {
    const email = normalizeEmail(raw);
    const token = email && (await env.INBOX.get(`subidx/${await hash(email)}`));
    const key = token && `subs/${token}.json`;
    const rec = key && (await env.INBOX.get(key, { type: "json" }));
    if (!rec) { unknown++; continue; }
    rec.notified = [...new Set([...(rec.notified || []), f.ep])];
    await env.INBOX.put(key, JSON.stringify(rec));
    marked++;
  }
  return json({ ok: true, ep: f.ep, marked, unknown });
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
