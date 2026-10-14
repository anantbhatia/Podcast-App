// Site for The Two Hallucinating PMs, on Cloudflare's free tier.
// - "/" is the listening page, built from src/index.html and the episodes in
//   episodes.json (see ADD-EPISODE.md); /audio/* are the MP3s in public/audio, and
//   /episodes.json is the public view of that file.
// - "/ask" is the recorder. Notes go to Workers KV; recordings expire after 90 days.
//   The ingest script (ingest/ingest.py) reads the inbox with INBOX_TOKEN,
//   transcribes voice notes, and marks each item done.
// - "/api/event" takes anonymous listening events into D1; "/stats" shows them
//   to the hosts (same INBOX_TOKEN as the password).
import pageTemplate from "./index.html";
import recorderPage from "./recorder.html";
import statsTemplate from "./stats.html";
import episodes from "../episodes.json";
import { listeningPage, statsPage, feed } from "./episodes.mjs";
import { recordEvent, getStats } from "./stats.js";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // about 10 minutes of phone audio
const MAX_TEXT = 2000;
const AUDIO_TTL = 90 * 24 * 60 * 60;
const MAX_NAME = 80;
const KINDS = new Set(["question", "followup", "feedback"]);

function html(body, extra = {}, request) {
  return new Response(request && request.method === "HEAD" ? null : body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...extra },
  });
}

// The episodes don't change between deploys, so both pages are built once per worker instance.
let pages = null;
function built() {
  return pages || (pages = { listening: listeningPage(pageTemplate, episodes), stats: statsPage(statsTemplate, episodes), feed: JSON.stringify(feed(episodes)) });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    const read = request.method === "GET" || request.method === "HEAD";
    if (read && (pathname === "/" || pathname === "/index.html")) {
      return html(built().listening, {}, request);
    }
    if (request.method === "GET" && pathname === "/episodes.json") {
      return new Response(built().feed, { headers: { "content-type": "application/json", "cache-control": "no-cache" } });
    }
    // Audio comes through here so seeking works on every phone.
    if (read && pathname.startsWith("/audio/")) {
      return serveAudio(request, env);
    }
    if (request.method === "GET" && (pathname === "/ask" || pathname === "/ask/")) {
      // The page records from the microphone, so it must be allowed here.
      return html(recorderPage, { "permissions-policy": "microphone=(self)" });
    }
    if (request.method === "GET" && (pathname === "/stats" || pathname === "/stats/")) {
      return html(built().stats, { "x-robots-tag": "noindex" });
    }

    if (request.method === "POST" && pathname === "/api/submit") {
      return submit(request, env, ctx);
    }
    if (request.method === "POST" && pathname === "/api/event") {
      return recordEvent(request, env);
    }
    if (request.method === "GET" && pathname === "/api/stats") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
      return json(await getStats(env));
    }

    if (pathname.startsWith("/api/inbox") || pathname.startsWith("/api/audio/") || pathname.startsWith("/api/done/")) {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
      if (request.method === "GET" && pathname === "/api/inbox") return listInbox(env);
      if (request.method === "GET" && pathname.startsWith("/api/audio/")) return getAudio(env, pathname.slice("/api/audio/".length));
      if (request.method === "POST" && pathname.startsWith("/api/done/")) return markDone(env, pathname.slice("/api/done/".length));
    }

    return json({ error: "not found" }, 404);
  },
};

async function serveAudio(request, env) {
  const res = await env.ASSETS.fetch(new Request(request.url, { method: "GET" }));
  if (!res.ok) return res;
  const headers = new Headers(res.headers);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=86400");
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
  if (!range) {
    return new Response(request.method === "HEAD" ? null : res.body, { status: 200, headers });
  }
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  const start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
  const end = range[1] !== "" && range[2] !== "" ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  }
  headers.set("content-range", `bytes ${start}-${end}/${size}`);
  headers.set("content-length", String(end - start + 1));
  return new Response(request.method === "HEAD" ? null : buf.slice(start, end + 1), { status: 206, headers });
}

function authorized(request, env) {
  const header = request.headers.get("authorization") || "";
  return env.INBOX_TOKEN && header === `Bearer ${env.INBOX_TOKEN}`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clean(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

const SAFE_ID = /^[a-z0-9-]{8,64}$/;

async function submit(request, env, ctx) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Send the form as multipart form data." }, 400);
  }

  // Bots fill every field; people never see this one.
  if (clean(form.get("website"), 200)) return json({ ok: true });

  const text = clean(form.get("text"), MAX_TEXT);
  const audio = form.get("audio");
  const hasAudio = audio && typeof audio === "object" && audio.size > 0;
  if (!text && !hasAudio) return json({ error: "Record a voice note or type a message first." }, 400);
  if (hasAudio && audio.size > MAX_AUDIO_BYTES) return json({ error: "That recording is over 10 MB. Keep it under about 10 minutes." }, 413);
  if (hasAudio && audio.type && !audio.type.startsWith("audio/") && !audio.type.startsWith("video/")) {
    return json({ error: "That file isn't audio." }, 415);
  }

  const kind = KINDS.has(form.get("kind")) ? form.get("kind") : "question";
  const name = clean(form.get("name"), MAX_NAME);
  const listenerId = clean(form.get("listenerId"), 64);
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;

  let audioKey = null;
  if (hasAudio) {
    const ext = extFor(audio.type, audio.name);
    audioKey = `audio/${id}.${ext}`;
    await env.INBOX.put(audioKey, await audio.arrayBuffer(), {
      metadata: { contentType: audio.type || "application/octet-stream" },
      expirationTtl: AUDIO_TTL,
    });
  }

  const record = {
    id,
    receivedAt: new Date().toISOString(),
    kind,
    text,
    name,
    // Name on air only when they gave one and ticked the box.
    nameOk: Boolean(name) && form.get("nameOk") === "yes",
    // Optional way to reach them, kept for a later personal reply.
    contact: clean(form.get("contact"), 120),
    // Random id the listener's browser keeps, so later notes from the same
    // person can be grouped without knowing who they are.
    listenerId: SAFE_ID.test(listenerId) ? listenerId : null,
    episode: clean(form.get("episode"), 60),
    audioKey,
    audioType: hasAudio ? audio.type || null : null,
    audioBytes: hasAudio ? audio.size : 0,
  };
  await env.INBOX.put(`inbox/${id}.json`, JSON.stringify(record));
  // Count it as a conversion in the listening stats (no note content is copied there).
  ctx.waitUntil(recordEvent(request, env, {
    type: "ask_submit", ep: record.episode, v: record.listenerId, voice: hasAudio ? 1 : 0,
  }).catch(() => {}));
  return json({ ok: true, id });
}

function extFor(type = "", name = "") {
  if (type.includes("webm")) return "webm";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return "m4a";
  if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
  if (type.includes("wav")) return "wav";
  const m = /\.([a-z0-9]{2,4})$/i.exec(name);
  return m ? m[1].toLowerCase() : "bin";
}

async function listInbox(env) {
  const items = [];
  let cursor;
  do {
    const page = await env.INBOX.list({ prefix: "inbox/", cursor });
    for (const { name } of page.keys) {
      const rec = await env.INBOX.get(name, { type: "json" });
      if (rec) items.push(rec);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  items.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  return json({ items });
}

async function getAudio(env, id) {
  if (!/^[0-9]{14}-[0-9a-f]{8}$/.test(id)) return json({ error: "bad id" }, 400);
  const rec = await env.INBOX.get(`inbox/${id}.json`, { type: "json" })
    || await env.INBOX.get(`done/${id}.json`, { type: "json" });
  if (!rec) return json({ error: "not found" }, 404);
  const { value, metadata } = rec.audioKey
    ? await env.INBOX.getWithMetadata(rec.audioKey, { type: "stream" })
    : { value: null };
  if (!value) return json({ error: "no audio" }, 404);
  return new Response(value, {
    headers: { "content-type": metadata?.contentType || "application/octet-stream" },
  });
}

async function markDone(env, id) {
  if (!/^[0-9]{14}-[0-9a-f]{8}$/.test(id)) return json({ error: "bad id" }, 400);
  const key = `inbox/${id}.json`;
  const rec = await env.INBOX.get(key);
  if (rec === null) return json({ ok: true, already: true });
  await env.INBOX.put(`done/${id}.json`, rec);
  await env.INBOX.delete(key);
  return json({ ok: true });
}
