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

## Notes

- `wrangler deploy` keeps existing secrets: `INBOX_TOKEN` stays on the worker.
  Never run `wrangler secret put` or `delete` as part of a deploy.
- KV (INBOX) and D1 (hpm-stats) data are untouched by a deploy.
- MP3s in `public/audio` ship with each deploy (25 MiB per file cap).
- Always deploy the branch head fresh from GitHub, never a local edit.
- If a call fails on permissions, the token needs Workers Scripts: Edit
  (Cloudflare, My Profile, API Tokens, edit the token); don't work around it.
