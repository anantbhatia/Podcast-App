# Listener site

The show's public site on Cloudflare's free tier: the listening page (built by the worker from `src/index.html` and `episodes.json`), the recorder at `/ask`, listening stats for the hosts at `/stats`, and the listener inbox.

Where listeners of The Two Hallucinating PMs send questions, follow-ups and feedback, by voice or text, with or without their name.

- `src/recorder.html` is the page listeners open from the "Ask us" link on the listening page. It records in the browser (up to 3 minutes) or takes typed text. If the browser can't record, it falls back to picking a voice memo.
- `src/worker.js` is a Cloudflare Worker (free tier) that serves the page and stores each note in Workers KV (free tier, no card; recordings expire after 90 days). Reading the inbox needs `INBOX_TOKEN`.
- `ingest/ingest.py` pulls new notes, transcribes voice notes locally with faster-whisper (no per-note cost), and saves them as JSON.
- `distill-routine.md` is the scheduled Claude routine that distills, categorizes and ranks the notes into the Studio and recommends the mention and the follow-up for the next episode.

## Deploy (once)
```
cd listener-inbox
npx wrangler login
npx wrangler kv namespace create INBOX   # paste the id into wrangler.toml
npx wrangler d1 create hpm-stats         # paste the database_id into wrangler.toml
npx wrangler secret put INBOX_TOKEN     # any long random string
npx wrangler deploy                     # prints https://listen.<account>.workers.dev
```
Then put `INBOX_URL` (the printed URL) and `INBOX_TOKEN` in the Claude cloud environment for the routine.

## Local test
```
printf 'INBOX_TOKEN=testtoken\n' > .dev.vars
npx wrangler dev
curl -F kind=question -F text="hello" http://127.0.0.1:8787/api/submit
INBOX_URL=http://127.0.0.1:8787 INBOX_TOKEN=testtoken python3 ingest/ingest.py --out /tmp/notes
```

## Subscribers: email and browser notifications
The listening page has an email sign-up and a "Notify me in this browser" button. `POST /api/subscribe` stores the address in the inbox KV namespace (`subs/<token>`, with an index by hashed address so each address signs up once); `/unsubscribe?t=<token>` is the link in every email (it asks for a click, then removes the sign-up over POST), and `/unsubscribe` without a token takes a typed address. Hosts list sign-ups with `GET /api/subscribers?ep=<slug>` (those not yet emailed about that episode, each with its unsubscribe link) and mark them with `POST /api/notified {ep, emails}`; both need `INBOX_TOKEN`. The worker never sends email: the publishing session does, from Anant's Gmail, as the last step in `ADD-EPISODE.md`.

Browser notifications are Web Push (`src/push.mjs`, service worker `public/sw.js`): the page subscribes the browser with the site's public key and `POST /api/push/subscribe` stores the subscription (`push/<hash of endpoint>`); `POST /api/push/unsubscribe` removes it. At a publish the hosts call `POST /api/push/send {ep, title, body, url}` (with `INBOX_TOKEN`), and the worker encrypts and sends the notification to up to 10 browsers per call, marking each one so no browser gets an episode twice. The private key is the worker secret `VAPID_PRIVATE_KEY`, made once with `scripts/vapid-keys.mjs` as `DEPLOY.md` describes; without it the page hides the button and `/api/push/key` answers 503. Sign-ups of both kinds are capped per day (50 addresses, 100 browsers), and every hosts' call stays within the free plan's 50 KV calls per request.

## Listening stats
The listening page sends anonymous events to `/api/event`: page view, play, pause, 25/50/75% and finished (95% actually listened, not skipped), 15-second skips back and ahead, Ask clicks and email sign-ups (no address is stored there); the recorder logs each sent question. Each event keeps a random per-browser id (for repeat visitors), a salted SHA-256 of the IP address (never the address), the episode, device type and country. Stored in D1 (`events` table, created on first use). Hosts open `/stats` and enter the INBOX_TOKEN; `/api/stats` returns the same numbers as JSON.

## Sharing and embedding
- **Share links.** `/` is the newest episode, `/<slug>` (for example `/ep02`) opens the page on that episode. Both carry Open Graph tags (title, description with the length, the show art at `public/img/og.jpg`), so Substack, WhatsApp, LinkedIn, Slack and email clients show a card that opens the page here, with the stats intact. Add `?from=<word>` to a link you share (`/?from=substack`) and the hosts' page counts visitors and plays under that word ("Came from"); an untagged visit records the referring site's host name when the browser sends one.
- **Substack** posts cannot hold a custom iframe or HTML (its editor only embeds its own list of services), so a Substack post gets the card: paste `https://listen.2hallucinatingpms.workers.dev/?from=substack` on its own line.
- **Embed** on a site that allows an iframe (a blog, Notion, Ghost, WordPress and others): `/embed` is a compact player for the newest episode and `/embed/<slug>` for one episode, with the same look and the same listening stats (events tagged `embed:<host of the page around it>`). The iframe: `<iframe src="https://listen.2hallucinatingpms.workers.dev/embed" width="100%" height="210" style="max-width:720px;border:0" loading="lazy" title="Two Hallucinating PMs"></iframe>`. Sites that discover oEmbed get the same player from `/oembed?url=<page link>`.

## Adding an episode
See `ADD-EPISODE.md`: save the Studio's publish payload to a file, run `node scripts/add-episode.mjs <file>` (copies the MP3 into `public/audio/` and adds the entry to `episodes.json` with only the public fields), deploy (`DEPLOY.md`), then tell the subscribers (emails from Anant's Gmail, one call for the browser notifications). The worker builds the listening page from `src/index.html` and `episodes.json`, and the stats page takes its episode names from it; `scripts/check-episodes.mjs` runs before every deploy and refuses an incomplete entry, a missing MP3 or private payload fields. The page orders episodes by date; an out-of-cycle special is published with `kind: "special"` and its own `specialNo` (slug `special-NN`, badge "Special episode N") and leaves the weekly numbering alone. `/feed.xml` is the podcast feed (RSS with itunes and podcast tags, cover at `/img/cover.jpg`) that Spotify for Creators and YouTube Studio read, so every publish reaches them; its owner email is the `PODCAST_OWNER_EMAIL` secret (DEPLOY.md), and the feed's descriptions say the voices are AI clones.

The page tries to start the newest episode on arrival; browsers that refuse sound before a tap show a pulsing Play button instead, and the first tap on open space starts it. When an episode ends, the next one down the page starts.
