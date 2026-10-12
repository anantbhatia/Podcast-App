# Listener inbox

Where listeners of The Two Hallucinating PMs send questions, follow-ups and feedback, by voice or text, with or without their name.

- `src/recorder.html` is the page listeners open from the "Ask us" link on the listening page. It records in the browser (up to 3 minutes) or takes typed text. If the browser can't record, it falls back to picking a voice memo.
- `src/worker.js` is a Cloudflare Worker (free tier) that serves the page and stores each note in an R2 bucket. Reading the inbox needs `INBOX_TOKEN`.
- `ingest/ingest.py` pulls new notes, transcribes voice notes locally with faster-whisper (no per-note cost), and saves them as JSON.
- `distill-routine.md` is the scheduled Claude routine that distills, categorizes and ranks the notes into the Studio and recommends the mention and the follow-up for the next episode.

## Deploy (once)
```
cd listener-inbox
npx wrangler login
npx wrangler r2 bucket create hpm-listener-inbox
npx wrangler secret put INBOX_TOKEN     # any long random string
npx wrangler deploy                     # prints https://hpm-listener-inbox.<account>.workers.dev
```
Then put `INBOX_URL` (the printed URL) and `INBOX_TOKEN` in the Claude cloud environment for the routine.

## Local test
```
printf 'INBOX_TOKEN=testtoken\n' > .dev.vars
npx wrangler dev
curl -F kind=question -F text="hello" http://127.0.0.1:8787/api/submit
INBOX_URL=http://127.0.0.1:8787 INBOX_TOKEN=testtoken python3 ingest/ingest.py --out /tmp/notes
```
