# Listener site

The show's public site on Cloudflare's free tier: the listening page (built by the worker from `src/index.html` and `public/episodes.json`), the recorder at `/ask`, listening stats for the hosts at `/stats`, and the listener inbox.

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

## Listening stats
The listening page sends anonymous events to `/api/event`: page view, play, pause, 25/50/75% and finished (95% actually listened, not skipped), and Ask clicks; the recorder logs each sent question. Each event keeps a random per-browser id (for repeat visitors), a salted SHA-256 of the IP address (never the address), the episode, device type and country. Stored in D1 (`events` table, created on first use). Hosts open `/stats` and enter the INBOX_TOKEN; `/api/stats` returns the same numbers as JSON.

## Adding an episode
See `ADD-EPISODE.md`: put the MP3 in `public/audio/`, add one entry to `public/episodes.json`, deploy (`DEPLOY.md`). The worker builds the listening page from `src/index.html` and that file, and the stats page takes its episode names from it; `scripts/check-episodes.mjs` runs before every deploy and refuses an incomplete entry or a missing MP3.

The page tries to start the newest episode on arrival; browsers that refuse sound before a tap show a pulsing Play button instead, and the first tap on open space starts it. When an episode ends, the next one down the page starts.
