# Deploying the show site from the cloud

The site is the Cloudflare Worker `listen` (https://listen.2hallucinatingpms.workers.dev).
Any cloud session in the Podcast App project can deploy it; no Mac needed.

**Only deploy after Anant says "deploy"** (in the thread, or relayed by the coordinator).

## Needs

- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the cloud environment
  (Project settings). Sessions only see variables that existed when they started.
  `CLOUDFLARE_ACCOUNT_ID` is the 32-character account ID, not the email.
- Never print, log or commit either value.

## Steps

```sh
git fetch origin claude/episode-pages-7k5fww
git checkout -B claude/episode-pages-7k5fww origin/claude/episode-pages-7k5fww
cd listener-inbox
npx --yes wrangler@4 whoami                 # token works, right account
npx --yes wrangler@4 deployments list       # can see the "listen" worker
npx --yes wrangler@4 deploy --dry-run       # bundles; lists INBOX, DB, ASSETS
npx --yes wrangler@4 deploy                 # only after "deploy"
```

Then check https://listen.2hallucinatingpms.workers.dev loads and an episode plays.

## Browser notifications: set the push key (once)

The listening page's "Notify me in this browser" button needs a key pair on the worker
(Web Push, VAPID). The private key is the secret `VAPID_PRIVATE_KEY`; the worker derives
the public one and puts it in the page, which shows the button only once the secret
exists. Make the pair once, from `listener-inbox/`, piped straight into wrangler so the
private key is never printed, pasted or saved anywhere:

```sh
node scripts/vapid-keys.mjs | npx --yes wrangler@4 secret put VAPID_PRIVATE_KEY
```

(The script refuses to print to a terminal.) `secret put` goes live on its own; the
button appears with the first deploy that carries the push code, in either order. Check
with `curl -sS https://listen.2hallucinatingpms.workers.dev/api/push/key`: it answers
`{"key":"B..."}` (the public key, fine to show) once both are in place, or 503 before.

Do this once. Running it again makes a new key, and every browser that subscribed with
the old one stops getting notifications until it next opens the page (the page then
re-subscribes it with the new key on its own). The private key never goes in a thread,
a file, the repo, memory or a status line.

## Notes

- `wrangler deploy` keeps existing secrets: `INBOX_TOKEN` and `VAPID_PRIVATE_KEY` stay on
  the worker. Never run `wrangler secret put` or `delete` as part of a deploy; the only
  secret ever set from here is the one-time push key above. `INBOX_TOKEN` is never set
  or rotated from the cloud.
- KV (INBOX) and D1 (hpm-stats) data are untouched by a deploy.
- MP3s in `public/audio` ship with each deploy (25 MiB per file cap).
- Always deploy the branch head fresh from GitHub, never a local edit.
- If a call fails on permissions, the token needs Workers Scripts: Edit
  (Cloudflare, My Profile, API Tokens, edit the token); don't work around it.
