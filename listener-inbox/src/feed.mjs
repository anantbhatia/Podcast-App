// The podcast feed at /feed.xml: RSS 2.0 with the itunes and podcast namespaces, one item per
// published episode, built from episodes.json. Spotify for Creators and YouTube Studio both read
// it, so a publish reaches them with no upload and no credentials. Plain JavaScript (no Workers
// or Node APIs beyond WebCrypto), shared with scripts/check-episodes.mjs.
import { sorted, label, isSpecial, audioFile, seconds, esc } from "./episodes.mjs";

export const SHOW = {
  title: "The two Hallucinating PMs",
  description: "A weekly AI news show with Anant and Aman. AI trends that get outdated by Monday and obsolete by launch.",
  author: "Anant and Aman",
  language: "en",
  category: "Technology",
  cover: "/img/cover.jpg", // square, 3000x3000, under 512 KB (Apple, Spotify and YouTube's spec)
  // Anant's call (2026-10-23): the platforms' listings say the voices are AI. Nothing changes on air.
  voiceNote: "The hosts' voices are AI clones of Anant and Aman, made with ElevenLabs from scripts they approve.",
};

// When the episode went live: the instant the add-episode script recorded (publishedAt), so a
// morning publish is never listed as a future release; an entry from before the script recorded
// it has none and is listed at noon UTC of its date (noon, so it is that day everywhere).
export const instant = (e) => new Date(typeof e.publishedAt === "string" ? e.publishedAt : `${e.date}T12:00:00Z`);
// "Mon, 19 Oct 2026 08:05:24 GMT", the RFC 1123 form the feed uses.
export const pubDate = (e) => instant(e).toUTCString();

// A bullet or line closed as a sentence: the Studio's one-line description is a headline and may
// have no end punctuation, and the voice note follows it.
const sentence = (s) => { const t = String(s ?? "").trim(); return !t || /[.!?\u2026]['")\]]?$/.test(t) ? t : `${t}.`; };

// The episode's text for the feed: the card's bullets (one per line) or its line, a blank line,
// then the voice note. Plain text; the directories keep the line breaks.
export function itemDescription(e) {
  const about = Array.isArray(e.summary) && e.summary.length ? e.summary.map(sentence).filter(Boolean).join("\n") : sentence(e.description);
  return [about, SHOW.voiceNote].filter(Boolean).join("\n\n");
}

// The podcast namespace's stable show id: UUID v5 of the feed's address without the scheme
// (https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/tags/guid.md).
const NAMESPACE = "ead4c236-bf58-58c6-a2c6-a6b28d128cb6";
export async function podcastGuid(feedUrl) {
  const name = feedUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const ns = Uint8Array.from(NAMESPACE.replace(/-/g, "").match(/../g), (h) => parseInt(h, 16));
  const bytes = new Uint8Array([...ns, ...new TextEncoder().encode(name)]);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The whole feed. `ownerEmail` is the address Spotify and YouTube send their ownership codes to;
// it is a worker secret (DEPLOY.md), never in the repo, and the owner tag is left out until it is set.
export async function podcastFeed(list, origin, { ownerEmail = "" } = {}) {
  const eps = sorted(list);
  const feedUrl = `${origin}/feed.xml`, cover = `${origin}${SHOW.cover}`;
  const email = typeof ownerEmail === "string" ? ownerEmail.trim() : "";
  const guid = await podcastGuid(feedUrl);
  const items = eps.map((e) => {
    const dur = seconds(e.durationSec) || 0, file = audioFile(e), url = `${origin}/${e.slug}`;
    return `    <item>
      <title>${esc(e.title)}</title>
      <itunes:title>${esc(e.title)}</itunes:title>
      <link>${esc(url)}</link>
      <guid isPermaLink="false">${esc(url)}</guid>
      <pubDate>${pubDate(e)}</pubDate>
      <description>${esc(itemDescription(e))}</description>
      <enclosure url="${esc(`${origin}/audio/${file}`)}" length="${Number(e.bytes) || 0}" type="audio/mpeg"/>
      <itunes:duration>${dur}</itunes:duration>
${isSpecial(e) ? `      <itunes:episodeType>bonus</itunes:episodeType>` : `      <itunes:episode>${e.episode}</itunes:episode>
      <itunes:episodeType>full</itunes:episodeType>`}
      <itunes:explicit>false</itunes:explicit>
      <itunes:image href="${esc(cover)}"/>
    </item>`;
  });
  // The newest instant any item carries (the top item by date may not be the latest recorded one).
  const latest = eps.length ? new Date(Math.max(...eps.map((e) => instant(e).getTime()))) : null;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(SHOW.title)}</title>
    <link>${esc(origin)}/</link>
    <atom:link href="${esc(feedUrl)}" rel="self" type="application/rss+xml"/>
    <description>${esc(`${SHOW.description}\n\n${SHOW.voiceNote}`)}</description>
    <language>${SHOW.language}</language>
    <generator>${esc(SHOW.title)} listening site</generator>
${latest ? `    <lastBuildDate>${latest.toUTCString()}</lastBuildDate>\n` : ""}    <image>
      <url>${esc(cover)}</url>
      <title>${esc(SHOW.title)}</title>
      <link>${esc(origin)}/</link>
    </image>
    <itunes:author>${esc(SHOW.author)}</itunes:author>
${email ? `    <itunes:owner>
      <itunes:name>${esc(SHOW.author)}</itunes:name>
      <itunes:email>${esc(email)}</itunes:email>
    </itunes:owner>
` : ""}    <itunes:image href="${esc(cover)}"/>
    <itunes:category text="${esc(SHOW.category)}"/>
    <itunes:explicit>false</itunes:explicit>
    <itunes:type>episodic</itunes:type>
    <podcast:guid>${guid}</podcast:guid>
    <podcast:locked${email ? ` owner="${esc(email)}"` : ""}>no</podcast:locked>
${items.join("\n")}
  </channel>
</rss>
`;
}
