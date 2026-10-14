# Publishing an episode

The listening page is built from `episodes.json` (in `listener-inbox/`, next to `wrangler.toml`), and `scripts/add-episode.mjs` writes an entry to it from the Studio's publish payload (the JSON object after `Publish requested from the Studio:`, defined in `/mnt/project-files/dashboard/publish-payload.md`). Publishing is three steps, and any session can do them; nothing in the page's HTML needs touching.

1. **Save the Studio's message to a file**, for example `/tmp/payload.json`. The `Publish requested from the Studio:` line in front can stay.
2. **Run `node scripts/add-episode.mjs /tmp/payload.json`** from `listener-inbox/`. It checks the payload, copies the MP3 named in `mp3` into `public/audio/` (same file name) and appends an entry to `episodes.json` with only the fields the page shows; it prints what to fix if something is missing, and `--replace` overwrites an entry that already has the slug.
3. **Deploy**, following `DEPLOY.md`, only after Anant says "deploy". `wrangler deploy` (and `--dry-run`, and `wrangler dev`) first runs `node scripts/check-episodes.mjs`, which stops with the reasons listed if an entry is incomplete or its MP3 isn't in `public/audio`.

Then open https://listen.2hallucinatingpms.workers.dev and confirm the new episode is the "New this week" card and plays. Each episode has an anchor named after its slug, so the link to one is `https://listen.2hallucinatingpms.workers.dev/#ep02`. https://listen.2hallucinatingpms.workers.dev/episodes.json shows what was deployed.

The repository is public, so `episodes.json` never carries the payload's `mp3` path, `studio` link, `requestedBy` or `requestedAt`: the script drops them, and the check refuses a file that has them. Don't paste the payload into `episodes.json` by hand.

## The payload, and what the page does with it

```json
{
  "episode": 2,
  "slug": "ep02",
  "title": "Who Pays for Agents?",
  "date": "2026-10-20",
  "mp3": "/mnt/project-files/episodes/ep02/ep02-who-pays-for-agents.mp3",
  "durationSec": 962,
  "description": "One line about the episode, written or edited by the host in the Studio.",
  "summary": [
    "One sentence per bullet on the card, usually one per story.",
    "Three or four of them."
  ],
  "sources": [
    {
      "story": "The story's name, as a heading",
      "refs": [
        { "title": "Headline", "outlet": "Publication", "url": "https://example.com/article", "verified": true }
      ]
    }
  ],
  "askPath": "/ask?ep=ep02"
}
```

| Field | What the page does with it |
|---|---|
| `episode` | The episode number, a whole number. Sets the order and the "Episode 2" badge. Must be unique. |
| `slug` | Short id, lowercase letters, digits and dashes: `ep02`. Names the episode in the stats, in "Ask about this episode" links and as the card's anchor (`#ep02`), so it never changes once published. |
| `title` | The title as it should read on the card. |
| `date` | Publish date, `YYYY-MM-DD`. The card shows the week it falls in ("Week of Oct 19, 2026", the Monday). |
| `mp3` | The approved file's path under `/mnt/project-files`. The script copies it to `public/audio/` and stores only its file name as `audio`, which the page plays as `audio/<name>` (so names stay unique: `ep02-<title-words>.mp3`). 96 kbps mono keeps a file around 13 MB; the cap is 25 MiB. |
| `durationSec` | Length in seconds. Shown on the card and the player before the audio loads. |
| `description` | One line about the episode. Shown on the card when there is no `summary`. |
| `summary` | Optional but better: a list of one-sentence bullets for the card, usually one per story (Episode 1 has four). Plain text; it is escaped, so no HTML. |
| `sources` | What listeners can read, grouped by story: `{ "story", "refs": [{ "title", "outlet", "url" }] }`. Shown as "Outlet: Headline" under the story's name. Every episode lists its sources (Anant's rule), and only ones the fact-check stands behind: leave low-confidence ones out of the payload, since the page shows every ref it is given. `verified` is dropped: `false` there means the fact-check confirmed the page through search instead of opening it, not that it is doubtful. |
| `askPath`, `studio`, `requestedBy`, `requestedAt` | Not stored; the Ask link is built from `slug`. |
| `label` | Optional. Replaces the "Episode N" badge text, for a special or a pilot. |

## What the page does with it

- The newest episode (highest `episode`) is the "New this week" card and tries to start on its own when someone opens the page; the rest sit under "Earlier episodes", and when an episode ends the next one down starts.
- The stats page (`/stats`) names episodes from the same file, so nothing there needs editing.
- Nothing is cached beyond a deploy: the worker builds the page from the file when it starts.

## If a check fails

Both scripts print each problem with the episode it belongs to, for example `episode 2 (ep02): public/audio/ep02-who-pays-for-agents.mp3 is not there`. Fix the payload or the file and run again; `node scripts/check-episodes.mjs` prints `episodes.json: 2 episodes OK, newest ep02 (...)` when the deploy can go ahead.
