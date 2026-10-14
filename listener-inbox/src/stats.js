// Listening stats in D1 (free tier). Events are anonymous: a random id the
// listener's browser keeps, a salted hash of the IP address (never the address
// itself), the episode, and how far they got.

const TYPES = new Set(["view", "play", "pause", "q25", "q50", "q75", "complete", "ask_click", "ask_submit", "subscribe", "push"]);
// Recorded by the worker itself (a note saved, a sign-up stored), never taken from a page's POST:
// the daily sign-up caps count them, so anyone could otherwise block sign-ups with a few requests.
const INTERNAL = new Set(["ask_submit", "subscribe", "push"]);
const EP = /^[a-z0-9-]{0,60}$/;
const ID = /^[a-zA-Z0-9-]{8,64}$/;

let ready = null;
function ensureSchema(env) {
  ready ??= env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (
      ts INTEGER NOT NULL, day TEXT NOT NULL, type TEXT NOT NULL, ep TEXT NOT NULL DEFAULT '',
      v TEXT, ip TEXT, s TEXT, t INTEGER, d INTEGER, l INTEGER,
      mobile INTEGER, country TEXT, voice INTEGER)`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS events_type_ep ON events (type, ep)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS events_v ON events (v)"),
  ]).catch((e) => { ready = null; throw e; });
  return ready;
}

async function ipHash(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "";
  if (!ip) return null;
  const data = new TextEncoder().encode(`${env.INBOX_TOKEN || "hpm"}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const int = (x) => (Number.isFinite(+x) ? Math.max(0, Math.min(1e6, Math.round(+x))) : null);

// Called by the page (body = JSON event) or internally with `override`.
export async function recordEvent(request, env, override) {
  let e = override;
  if (!e) {
    try {
      const raw = await request.text();
      if (raw.length > 1000) return new Response(null, { status: 413 });
      e = JSON.parse(raw);
    } catch {
      return new Response(null, { status: 400 });
    }
  }
  if (!TYPES.has(e.type) || (!override && INTERNAL.has(e.type)) || !EP.test(e.ep || "")) return new Response(null, { status: 400 });
  if (!env.DB) return new Response(null, { status: 204 });
  await ensureSchema(env);
  const now = new Date();
  const ua = request.headers.get("user-agent") || "";
  await env.DB.prepare(
    "INSERT INTO events (ts, day, type, ep, v, ip, s, t, d, l, mobile, country, voice) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).bind(
    now.getTime(), now.toISOString().slice(0, 10), e.type, e.ep || "",
    ID.test(e.v || "") ? e.v : null, await ipHash(request, env),
    ID.test(e.s || "") ? e.s : null, int(e.t), int(e.d), int(e.l),
    /Mobi|Android|iPhone/i.test(ua) ? 1 : 0, request.cf?.country || null, e.voice ? 1 : 0,
  ).run();
  return new Response(null, { status: 204 });
}

// How many events of one type were recorded today (UTC); 0 without a database or table.
// Sign-ups are capped per day with this, so a script can't fill the list or burn the KV write quota.
export async function countToday(env, type) {
  if (!env.DB) return 0;
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = ? AND day = ?").bind(type, new Date().toISOString().slice(0, 10)).first();
    return row ? Number(row.n) || 0 : 0;
  } catch {
    return 0;
  }
}

const one = async (stmt) => (await stmt.first()) || {};
const all = async (stmt) => (await stmt.all()).results || [];

export async function getStats(env) {
  if (!env.DB) return { error: "no database" };
  await ensureSchema(env);
  const db = env.DB;

  // A listener is the browser id when we have one, else the hashed IP.
  const who = "COALESCE(v, ip)";

  const totals = await one(db.prepare(`SELECT
      SUM(type='view') AS views,
      COUNT(DISTINCT CASE WHEN type='view' THEN ${who} END) AS visitors,
      COUNT(DISTINCT CASE WHEN type='view' THEN ip END) AS uniqueIps,
      SUM(type='play') AS plays,
      SUM(type='pause') AS pauses,
      COUNT(DISTINCT CASE WHEN type='play' THEN ${who} END) AS listeners,
      SUM(type='ask_click') AS askClicks,
      SUM(type='ask_submit') AS askSubmits,
      SUM(type='ask_submit' AND voice=1) AS voiceNotes,
      MIN(ts) AS since
    FROM events`));

  // Came back on another day, and came back for another episode.
  const repeat = await one(db.prepare(`SELECT
      (SELECT COUNT(*) FROM (SELECT ${who} AS w FROM events WHERE type='view' AND ${who} IS NOT NULL GROUP BY w HAVING COUNT(DISTINCT day) > 1)) AS returningVisitors,
      (SELECT COUNT(*) FROM (SELECT ${who} AS w FROM events WHERE type='play' AND ep<>'' AND ${who} IS NOT NULL GROUP BY w HAVING COUNT(DISTINCT ep) > 1)) AS multiEpisodeListeners`));

  const episodes = await all(db.prepare(`SELECT ep,
      SUM(type='play') AS plays,
      SUM(type='pause') AS pauses,
      COUNT(DISTINCT CASE WHEN type='play' THEN ${who} END) AS listeners,
      COUNT(DISTINCT CASE WHEN type='q25' THEN ${who} END) AS q25,
      COUNT(DISTINCT CASE WHEN type='q50' THEN ${who} END) AS q50,
      COUNT(DISTINCT CASE WHEN type='q75' THEN ${who} END) AS q75,
      COUNT(DISTINCT CASE WHEN type='complete' THEN ${who} END) AS completed,
      SUM(type='ask_click') AS askClicks,
      SUM(type='ask_submit') AS askSubmits,
      MAX(d) AS duration
    FROM events WHERE ep <> '' GROUP BY ep ORDER BY ep DESC`));

  // Average listening time per listener: the furthest real-listening mark each one reached.
  const listen = await all(db.prepare(`SELECT ep, AVG(m) AS avgSeconds FROM (
      SELECT ep, ${who} AS w, MAX(l) AS m FROM events WHERE ep<>'' AND l IS NOT NULL GROUP BY ep, w
    ) GROUP BY ep`));
  const avgBy = Object.fromEntries(listen.map((r) => [r.ep, Math.round(r.avgSeconds || 0)]));
  for (const e of episodes) e.avgListenSeconds = avgBy[e.ep] || 0;

  const daily = await all(db.prepare(`SELECT day,
      COUNT(DISTINCT CASE WHEN type='view' THEN ${who} END) AS visitors,
      SUM(type='play') AS plays
    FROM events WHERE ts > ? GROUP BY day ORDER BY day`).bind(Date.now() - 14 * 864e5));

  const devices = await one(db.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN mobile=1 THEN ${who} END) AS mobile,
      COUNT(DISTINCT CASE WHEN mobile=0 THEN ${who} END) AS desktop
    FROM events WHERE type='view'`));
  const countries = await all(db.prepare(`SELECT country, COUNT(DISTINCT ${who}) AS visitors
    FROM events WHERE type='view' AND country IS NOT NULL GROUP BY country ORDER BY visitors DESC LIMIT 6`));

  return { generatedAt: new Date().toISOString(), totals: { ...totals, ...repeat }, episodes, daily, devices, countries };
}
