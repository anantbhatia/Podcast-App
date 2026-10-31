// Browser push for new episodes (Web Push: RFC 8291 encryption, RFC 8292 VAPID), in
// Workers KV next to the inbox:
//   push/<sha256(endpoint)>.json  value { endpoint, keys: { p256dh, auth }, since, ep, notified, fail }
//                                 metadata { since, ep, notified: [slugs], fail }
// The status fields are also the key's metadata, so one list() call shows who is still
// to be told; the endpoint and keys are read only for the browsers being pushed to.
// The VAPID private key is the secret VAPID_PRIVATE_KEY, a P-256 private JWK made by
// scripts/vapid-keys.mjs (DEPLOY.md); the public key the page needs is derived from it.
// At each publish the publishing session calls /api/push/send with INBOX_TOKEN; the
// worker encrypts the message for each browser and posts it to that browser's push
// service, a batch per call, and marks each one notified (ADD-EPISODE.md).
import { recordEvent, countToday } from "./stats.js";

const SLUG = /^[a-z0-9-]{1,60}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const BATCH = 10;              // pushes per /api/push/send call: each is 3 KV/fetch calls, and a request gets 50 on the free plan
const TRIES = 3;               // attempts per browser per episode before it is given up on
const KEEP = 30;               // slugs remembered per browser (metadata is capped at 1 KB)
const TTL = 86400;             // a day: a phone that is off longer misses this one, not the next
const MAX_NEW_PER_DAY = 100;   // new browsers a day: bounds what a script can add (each is a KV write)
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const enc = new TextEncoder();

export const b64url = {
  encode: (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  decode: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0)),
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// The private JWK from the secret, or null when it is missing or malformed.
export function privateJwk(env) {
  try {
    const k = JSON.parse(env.VAPID_PRIVATE_KEY || "");
    return k && k.kty === "EC" && k.crv === "P-256" && [k.x, k.y, k.d].every((v) => typeof v === "string" && B64URL.test(v)) ? { kty: "EC", crv: "P-256", x: k.x, y: k.y, d: k.d } : null;
  } catch {
    return null;
  }
}

// The uncompressed public point (65 bytes, base64url), which the page passes as applicationServerKey.
export function publicKey(env) {
  const k = privateJwk(env);
  if (!k) return null;
  return b64url.encode(concat(new Uint8Array([4]), b64url.decode(k.x), b64url.decode(k.y)));
}

async function hash(s) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function okEndpoint(url, env) {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    return Boolean(env.DEV) && u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch {
    return false;
  }
}

async function body(request) {
  try {
    const raw = await request.text();
    if (raw.length > 4000) return null;
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

function store(env, name, rec) {
  const status = { since: rec.since, ep: rec.ep || "", notified: (rec.notified || []).slice(-KEEP) };
  if (rec.fail) status.fail = rec.fail;
  return env.INBOX.put(name, JSON.stringify({ endpoint: rec.endpoint, keys: rec.keys, ...status }), { metadata: status });
}

// POST /api/push/subscribe  { endpoint, keys: { p256dh, auth }, ep, listenerId }  (the PushSubscription JSON plus ep)
export async function pushSubscribe(request, env, ctx) {
  const b = await body(request);
  const keys = b && b.keys;
  if (!b || typeof b.endpoint !== "string" || b.endpoint.length > 2000 || !okEndpoint(b.endpoint, env) || !keys
    || typeof keys.p256dh !== "string" || !B64URL.test(keys.p256dh) || b64url.decode(keys.p256dh).length !== 65
    || typeof keys.auth !== "string" || !B64URL.test(keys.auth) || b64url.decode(keys.auth).length !== 16) {
    return json({ error: "That isn't a push subscription." }, 400);
  }
  const name = `push/${await hash(b.endpoint)}.json`;
  const old = await env.INBOX.get(name, { type: "json" });
  const ep = typeof b.ep === "string" && SLUG.test(b.ep) ? b.ep : "";
  if (!old && (await countToday(env, "push")) >= MAX_NEW_PER_DAY) return json({ error: "Sign-ups are paused for today. Try again tomorrow." }, 429);
  await store(env, name, { endpoint: b.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, since: old ? old.since : new Date().toISOString(), ep: old ? old.ep : ep, notified: old ? old.notified : [] });
  if (!old) ctx.waitUntil(recordEvent(request, env, { type: "push", ep, v: typeof b.listenerId === "string" ? b.listenerId : null }).catch(() => {}));
  return json({ ok: true, already: Boolean(old) });
}

// POST /api/push/unsubscribe { endpoint }
export async function pushUnsubscribe(request, env) {
  const b = await body(request);
  if (!b || typeof b.endpoint !== "string" || b.endpoint.length > 2000) return json({ error: "Send { endpoint }." }, 400);
  await env.INBOX.delete(`push/${await hash(b.endpoint)}.json`);
  return json({ ok: true });
}

export async function pushCount(env) {
  let n = 0, cursor;
  do {
    const page = await env.INBOX.list({ prefix: "push/", cursor });
    n += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return n;
}

// --- Web Push crypto ---------------------------------------------------------------

const P256 = { name: "ECDH", namedCurve: "P-256" };
async function hkdf(ikm, salt, info, bits) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits));
}

// RFC 8291 + RFC 8188 (aes128gcm): one record, the message padded with the 0x02 delimiter.
// `fixed` (an ephemeral key pair as JWK plus the salt) exists for the RFC's test vector.
export async function encrypt(plaintext, p256dh, auth, fixed) {
  const uaPublic = b64url.decode(p256dh), authSecret = b64url.decode(auth);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, P256, false, []);
  let asPrivate, asPublic;
  if (fixed) {
    asPrivate = await crypto.subtle.importKey("jwk", fixed.jwk, P256, false, ["deriveBits"]);
    asPublic = concat(new Uint8Array([4]), b64url.decode(fixed.jwk.x), b64url.decode(fixed.jwk.y));
  } else {
    const pair = await crypto.subtle.generateKey(P256, true, ["deriveBits"]);
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  }
  const salt = fixed ? b64url.decode(fixed.salt) : crypto.getRandomValues(new Uint8Array(16));
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivate, 256));
  const ikm = await hkdf(ecdh, authSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 256);
  const cek = await hkdf(ikm, salt, enc.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(ikm, salt, enc.encode("Content-Encoding: nonce\0"), 96);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = concat(enc.encode(plaintext), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, record));
  const header = concat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([asPublic.length]), asPublic); // rs = 4096
  return concat(header, ciphertext);
}

// RFC 8292: a signed token for one push service origin, good for 12 hours.
export async function vapidToken(env, audience, subject) {
  const jwk = privateJwk(env);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (o) => b64url.encode(enc.encode(JSON.stringify(o)));
  const signing = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signing)));
  return `${signing}.${b64url.encode(sig)}`;
}

// Which browsers are still to be told about ep, from the list's metadata.
const told = (m, ep) => (m.notified || []).includes(ep) || (m.fail && m.fail.ep === ep && m.fail.n >= TRIES);

// Hosts only. POST /api/push/send { ep, title, body, url }: pushes to every browser not yet
// told about ep, up to BATCH per call; call again until `pending` is 0. A push service
// answering 404 or 410 means the browser dropped the subscription, so it is removed; other
// failures count as pending and are retried on later calls, up to TRIES times for the episode.
export async function pushSend(request, env) {
  const b = await body(request);
  if (!b || !SLUG.test(b.ep || "") || typeof b.title !== "string" || !b.title.trim()) return json({ error: "Send { ep, title, body, url }." }, 400);
  if (!privateJwk(env)) return json({ error: "VAPID_PRIVATE_KEY is not set on the worker (see DEPLOY.md)." }, 503);
  const origin = new URL(request.url).origin;
  const subject = origin.startsWith("https://") ? origin : "https://listen.2hallucinatingpms.workers.dev";
  const payload = JSON.stringify({ title: b.title.slice(0, 120), body: typeof b.body === "string" ? b.body.slice(0, 300) : "", url: typeof b.url === "string" && b.url.startsWith("/") ? b.url.slice(0, 200) : `/#${b.ep}`, tag: `ep-${b.ep}` });

  // One list pass picks the batch; nothing else is read for the browsers already told.
  const batch = [];
  const result = { ok: true, ep: b.ep, sent: 0, gone: 0, failed: 0, pending: 0, total: 0 };
  let cursor;
  do {
    const page = await env.INBOX.list({ prefix: "push/", cursor });
    for (const { name, metadata } of page.keys) {
      result.total++;
      if (metadata && told(metadata, b.ep)) continue;
      if (batch.length < BATCH) batch.push(name); else result.pending++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const tokens = new Map();
  for (const name of batch) {
    const rec = await env.INBOX.get(name, { type: "json" });
    if (!rec || !rec.endpoint) continue;
    if (told(rec, b.ep)) { await store(env, name, rec); continue; } // a record without metadata: repaired, nothing to send
    const aud = new URL(rec.endpoint).origin;
    if (!tokens.has(aud)) tokens.set(aud, await vapidToken(env, aud, subject));
    let status = 0;
    try {
      const res = await fetch(rec.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream", "content-encoding": "aes128gcm", ttl: String(TTL), urgency: "normal",
          authorization: `vapid t=${tokens.get(aud)}, k=${publicKey(env)}`,
        },
        body: await encrypt(payload, rec.keys.p256dh, rec.keys.auth),
      });
      status = res.status;
    } catch {
      status = 0;
    }
    if (status === 404 || status === 410) {
      await env.INBOX.delete(name);
      result.gone++;
    } else if (status >= 200 && status < 300) {
      delete rec.fail;
      await store(env, name, { ...rec, notified: [...(rec.notified || []), b.ep] });
      result.sent++;
    } else {
      // 4xx other than 429 won't change on a retry (a key the service doesn't know, a bad subscription).
      const n = (rec.fail && rec.fail.ep === b.ep ? rec.fail.n : 0) + 1;
      const fail = { ep: b.ep, n: status >= 400 && status < 500 && status !== 429 ? TRIES : n, status };
      await store(env, name, { ...rec, fail });
      result.failed++;
      if (fail.n < TRIES) result.pending++; // still owed the message: the next call tries again
    }
  }
  return json(result);
}
