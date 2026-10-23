# Publishing an episode

The listening page is built from `episodes.json` (in `listener-inbox/`, next to `wrangler.toml`), and `scripts/add-episode.mjs` writes an entry to it from the Studio's publish payload (the JSON object after `Publish requested from the Studio:`, defined in `/mnt/project-files/dashboard/publish-payload.md`). Publishing is four steps, and any session can do them; nothing in the page's HTML needs touching.

1. **Save the Studio's message to a file**, for example `/tmp/payload.json`. The `Publish requested from the Studio:` line in front can stay.
2. **Run `node scripts/add-episode.mjs /tmp/payload.json`** from `listener-inbox/`. It checks the payload, copies the MP3 named in `mp3` into `public/audio/` (same file name) and appends an entry to `episodes.json` with only the fields the page shows; it prints what to fix if something is missing, and `--replace` overwrites an entry that already has the slug (keeping the date it first aired, since the page orders by date).
3. **Deploy**, following `DEPLOY.md`, only after Anant says "deploy". `wrangler deploy` (and `--dry-run`, and `wrangler dev`) first runs `node scripts/check-episodes.mjs`, which stops with the reasons listed if an entry is incomplete or its MP3 isn't in `public/audio`.
4. **Tell subscribers** (the section below): one email per sign-up from Anant's Gmail, then one call that pushes a notification to every browser that asked for one. The publish isn't done until both have run.

Then open https://listen.2hallucinatingpms.workers.dev and confirm the new episode is the "New this week" card and plays. The link to one episode is `https://listen.2hallucinatingpms.workers.dev/ep02` (its slug after the slash): it opens the page on that episode and carries that episode's preview card for Substack, WhatsApp and the rest; the older `/#ep02` anchor still works. Add `?from=<word>` to a link you share and the hosts' page counts the visitors it brought (see README, "Sharing and embedding"). https://listen.2hallucinatingpms.workers.dev/episodes.json shows what was deployed (its `label` is the badge text as shown on the card).

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
| `episode` | The weekly episode number, a whole number, unique. Sets the "Episode 2" badge. A special (below) has none. |
| `slug` | Short id, lowercase letters, digits and dashes: `ep02`. Names the episode in the stats, in "Ask about this episode" links and as the card's anchor (`#ep02`), so it never changes once published. |
| `title` | The title as it should read on the card. |
| `date` | Publish date, `YYYY-MM-DD`. The card shows the week it falls in ("Week of Oct 19, 2026", the Monday). |
| `mp3` | The approved file's path under `/mnt/project-files`. The script copies it to `public/audio/` and stores only its file name as `audio`, which the page plays as `audio/<name>` (so names stay unique: `ep02-<title-words>.mp3`). 96 kbps mono keeps a file around 13 MB; the cap is 25 MiB. |
| `durationSec` | Length in seconds. Shown on the card and the player before the audio loads. |
| `description` | One line about the episode. Shown on the card when there is no `summary`. |
| `summary` | Optional but better: a list of one-sentence bullets for the card, usually one per story (Episode 1 has four). Plain text; it is escaped, so no HTML. |
| `sources` | What listeners can read, grouped by story: `{ "story", "refs": [{ "title", "outlet", "url" }] }`. Shown as "Outlet: Headline" under the story's name. Every episode lists its sources (Anant's rule), and only ones the fact-check stands behind: leave low-confidence ones out of the payload, since the page shows every ref it is given. `verified` is dropped: `false` there means the fact-check confirmed the page through search instead of opening it, not that it is doubtful. |
| `askPath`, `studio`, `requestedBy`, `requestedAt` | Not stored; the Ask link is built from `slug`. |
| `bytes` | Written by the script: the MP3's size in bytes, for the podcast feed. Not in the payload. |
| `publishedAt` | Written by the script: the UTC instant the episode was added (`2026-10-19T08:05:24Z`), the feed's `pubDate`; kept on `--replace`, like `date`. Not in the payload. Episode 1 predates the field and is listed at noon UTC of its date. |
| `label`, `badge` | Optional. Either replaces the badge text ("Episode N" or "Special episode N") for a special or a pilot; a bare "Episode" or "Special episode" is treated as not given, so the number shows. |
| `kind`, `specialNo` | For an out-of-cycle special: `"kind": "special"` and its own number `specialNo` (1, 2, 3...), with no `episode`. See below. |

## Special episodes

An out-of-cycle episode (the emergency one on the PHP bug is the first) is published the same way, with `"kind": "special"` and its own number in `specialNo` instead of a weekly `episode` number, so the weekly count carries on unchanged (the weekly after Episode 3 is still Episode 4). Its slug is `special-NN` (`special-01`), so its link is `https://listen.2hallucinatingpms.workers.dev/special-01`, its anchor `#special-01`, its embed `/embed/special-01`, and the stats name it `Special episode 1 · <title>`. The card's badge reads "Special episode 1" (pink). A `badge` or `label` of just "Special episode" (what the Studio sends) means the kind, so the page still shows the number; any other text replaces the badge as written. The number comes from `specialNo`, or from the slug (`special-01`) when the payload has none.

```json
{
  "kind": "special",
  "specialNo": 1,
  "slug": "special-01",
  "title": "Patch in Hours",
  "date": "2026-10-24",
  "mp3": "/mnt/project-files/episodes/special-01/special-01-patch-in-hours.mp3",
  "durationSec": 840,
  "description": "...",
  "sources": [ { "story": "...", "refs": [ { "title": "...", "outlet": "...", "url": "https://..." } ] } ]
}
```

The script drops an `episode` number sent on a special (and says so), and the pre-deploy check refuses a special that has one, a weekly that has `specialNo`, a `kind` other than `special`, or an episode dated before a lower-numbered one of its kind. In the subscriber email, write "Special episode 1 of Two Hallucinating PMs is up: <title>" in place of "Episode <N>".

## What the page does with it

- The newest episode by `date` is the "New this week" card and tries to start on its own when someone opens the page; the rest sit under "Earlier episodes", and when an episode ends the next one down starts. On the same date the weekly episode goes first, then the higher number. The check refuses a weekly episode dated before a lower-numbered one, since that would put them out of order.
- The stats page (`/stats`) names episodes from the same file, so nothing there needs editing, and the podcast feed (`/feed.xml`, below) lists the new episode on its own.
- Nothing is cached beyond a deploy: the worker builds the page from the file when it starts.

## The podcast feed (Spotify and YouTube)

`https://listen.2hallucinatingpms.workers.dev/feed.xml` is the show's podcast feed (RSS 2.0 with the itunes and podcast tags, built by the worker from `episodes.json`, `src/feed.mjs`). Spotify for Creators and YouTube Studio both read it, so a new episode reaches them on its own after the deploy: nothing to upload, no account details on our side. The platforms re-read the feed on their own schedule (hours, not minutes).

- Every entry needs `bytes`, the MP3's size: the script records it, and the pre-deploy check refuses an entry whose `bytes` doesn't match the file (the feed's enclosure sends it, and the directories check it).
- The script also records `publishedAt`, the instant the episode went live, as the item's `pubDate`: the Studio stamps only the day, and an item dated noon of a day that has only begun would be held as a future release. The check refuses a `publishedAt` off its `date` by more than two days.
- Each item's description is the card's bullets (one per line, or its line, each closed as a sentence) and then, after a blank line, the AI-voice note the feed carries by Anant's call: "The hosts' voices are AI clones of Anant and Aman, made with ElevenLabs from scripts they approve." It is also in the channel description. Nothing changes on air.
- A special (`kind: "special"`) is a bonus episode in the feed (`itunes:episodeType` bonus, no episode number); weeklies carry their number.
- The cover is `public/img/cover.jpg` (3000x3000, under 512 KB); replace the file to change it everywhere, same name.
- The owner email (`itunes:owner`) is the worker secret `PODCAST_OWNER_EMAIL`, set once per DEPLOY.md; the feed has no owner tag until it is set. Spotify and YouTube send their ownership codes to that address, so it must be set before Anant submits the feed. The address is public in the feed by design, never in the repo.
- Anant's one-time step after the deploy: in Spotify for Creators and in YouTube Studio, add a podcast by RSS feed, paste the feed URL, and enter the code they email to the owner address.

## Tell subscribers

Listeners can leave their email on the listening page, or turn on a notification in their browser ("Notify me in this browser"). The worker keeps both in the inbox KV namespace. It can't send mail, so the email goes out as part of each publish, after the deploy is checked; the browser notifications it sends itself when asked. `INBOX_URL` and `INBOX_TOKEN` are in the cloud environment; never print the token, and keep the address list in a temporary file, not in the thread.

1. List who is still to be emailed about this episode:
   ```sh
   curl -sS -H "Authorization: Bearer $INBOX_TOKEN" "$INBOX_URL/api/subscribers?ep=ep02" > /tmp/subs.json
   ```
   Each item has `email`, `since`, `notified` (episodes already emailed) and `unsubscribe` (that person's own link). `pending` is how many are left for this episode; `count` is everyone. Anyone can type an address into the page, so look at the list before sending: if `pending` is more than the show would expect (dozens, not hundreds), or many addresses share one domain or look made up, stop and show Anant the count instead of sending; never send more than 50 in one publish without his go-ahead.
2. For each item, send one email from Anant's Gmail through the Gmail connector, to that one address only (never several subscribers in one To or Cc line, since each has a different unsubscribe link), and mark that address right after its email went (step 3), before the next one, so a publish that stops partway can be run again without emailing anyone twice:
   - Subject: `New episode: <title> (Two Hallucinating PMs)`
   - Body, plain text (for a special the first line is `Special episode <N> of Two Hallucinating PMs is up: <title>`, the badge text as /episodes.json's `label` shows it):
     ```
     Episode <N> of Two Hallucinating PMs is up: <title>

     <summary bullets, one per line, or the description>

     Listen: https://listen.2hallucinatingpms.workers.dev/<slug>?from=email
     Got a question for the show? https://listen.2hallucinatingpms.workers.dev/ask?ep=<slug>

     You get this because you signed up on the listening page. To stop: <that item's unsubscribe link>
     ```
3. Mark each address told, right after its email:
   ```sh
   curl -sS -X POST -H "Authorization: Bearer $INBOX_TOKEN" -H "content-type: application/json" \
     --data '{"ep":"ep02","emails":["<the address just emailed>"]}' "$INBOX_URL/api/notified"
   ```
   The answer says how many were `marked` (`already` if it was marked before, `unknown` if the address isn't signed up). It takes up to 40 addresses in one call; more are reported as `skipped`. If anything stopped partway, run step 1 again: it lists only the ones not yet marked.
4. Push the notification to every browser that asked for one. One call sends to up to 10 browsers (the free plan's limit on what a request can do); repeat it until `pending` is 0:
   ```sh
   curl -sS -X POST -H "Authorization: Bearer $INBOX_TOKEN" -H "content-type: application/json" \
     --data '{"ep":"ep02","title":"New episode: <title>","body":"<the description, one line>","url":"/#ep02"}' "$INBOX_URL/api/push/send"
   ```
   The answer counts `sent`, `gone` (browsers that dropped their subscription; removed), `failed` (retried on the next call, up to three times for this episode), `pending` (still to do, the retries included) and `total`. Each browser gets the message once per episode, so re-running is safe. A 503 means the push key isn't set on the worker yet (the one-time step in `DEPLOY.md`); the emails still go out.

The hosts see both counts on `/stats` and the email list under them. `/unsubscribe` is the page behind the link in every email; it asks for one click before removing the sign-up (so mail scanners that open links can't), and takes a typed address for someone who lost the link. Browser notifications are turned off from the page's "Turn off" link.

## If a check fails

Both scripts print each problem with the episode it belongs to, for example `episode 2 (ep02): public/audio/ep02-who-pays-for-agents.mp3 is not there`. Fix the payload or the file and run again; `node scripts/check-episodes.mjs` prints `episodes.json: 2 episodes OK, newest ep02 (...)` when the deploy can go ahead.
