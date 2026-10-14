# Publishing an episode

The listening page is built from `public/episodes.json`. Publishing an episode is three steps, and any session can do them; nothing about the page's HTML needs touching.

1. **Put the MP3 in `public/audio/`** (96 kbps mono keeps it around 13 MB; the hard cap is 25 MiB per file). Name it `<slug>-<title-words>.mp3`, like `ep02-who-pays-for-agents.mp3`.
2. **Add one entry to `public/episodes.json`** (fields below). Order doesn't matter; the page sorts by `number`, newest first.
3. **Check and deploy**, following `DEPLOY.md`, only after Anant says "deploy". `wrangler deploy` (and `--dry-run`, and `wrangler dev`) first runs `node scripts/check-episodes.mjs`, which refuses to continue if an entry is incomplete or its MP3 is missing and lists what to fix.

Then open https://listen.2hallucinatingpms.workers.dev and confirm the new episode is the "New this week" card and plays. https://listen.2hallucinatingpms.workers.dev/episodes.json shows the deployed data.

## The entry

```json
{
  "slug": "ep02",
  "number": 2,
  "title": "Who Pays for Agents?",
  "date": "2026-10-21",
  "duration": "16:02",
  "audio": "ep02-who-pays-for-agents.mp3",
  "summary": [
    "One sentence per bullet on the card, usually one per story.",
    "Three or four of them."
  ],
  "sources": [
    {
      "story": "The story's name, as a heading",
      "links": [
        { "title": "Publication: headline", "url": "https://example.com/article" }
      ]
    }
  ]
}
```

| Field | What it is |
|---|---|
| `slug` | Short id, lowercase letters, digits and dashes: `ep02`, `ep03`. It names the episode in the stats and in "Ask about this episode" links, so it never changes once published. |
| `number` | Episode number as a whole number. Sets the order and the "Episode 2" badge. Must be unique. |
| `title` | The episode title as it should read on the card. |
| `date` | Publish date, `YYYY-MM-DD`. The card shows the week it falls in ("Week of Oct 19, 2026", the Monday). |
| `duration` | Length as `"m:ss"` or seconds. Shown on the card and the player before the audio loads. |
| `audio` | The MP3's file name inside `public/audio/` (just the name, no path). |
| `summary` | List of sentences for the card's bullets. Plain text; it is escaped, so no HTML. |
| `sources` | The sources listeners can read, grouped by story: a list of `{ "story", "links": [{ "title", "url" }] }`. Every episode lists its sources (Anant's rule); leave out anything the fact-check marked low-confidence. |
| `label` | Optional. Replaces the "Episode N" badge text, for a special or a pilot. |

## What the page does with it

- The newest episode (highest `number`) is the "New this week" card and tries to start on its own when someone opens the page; the rest sit under "Earlier episodes", and when an episode ends the next one down starts.
- The stats page (`/stats`) names episodes from the same file, so nothing there needs editing.
- Nothing is cached beyond a deploy: the worker builds the page from the file when it starts.

## If the check fails

`node scripts/check-episodes.mjs` prints each problem with the episode it belongs to, for example `episode 2 (ep02): public/audio/ep02-who-pays-for-agents.mp3 is not there`. Fix the entry or the file and run it again; it prints `episodes.json: 2 episodes OK, newest ep02 (...)` when the deploy can go ahead.
