# Hallucinating PMs Studio

The private production desk for *The two Hallucinating PMs*: a claude.ai artifact page plus the instructions the scheduled agents follow.

| File | What it is |
| --- | --- |
| `index.html` | The dashboard page, published as a claude.ai artifact with the `db` and `user` capabilities. Shows the agent board, research digests, ideas, watched sources, listener asks and the distribution list. |
| `research-run.md` | Instructions for the Monday and Thursday research run (6:52am Pacific). The run fans out five parallel research lanes, reports progress to the dashboard database, writes the digest and emails it to the two hosts. |

## Dashboard database

| Path | Written by | Fields |
| --- | --- | --- |
| `show/current` | Agents | episode, stage, title, note, waitingOn |
| `agents/<id>` | Agents | order, name, role, state (idle, working, waiting, done, failed), step, sources, found, ideas, log, updatedAt |
| `digests/<YYYY-MM-DD>` | Research run | date, day, markdown, createdAt |
| `ideas/<id>` | Hosts | text, link, by, status (new, promoted, vetoed, used, parked), promotedBy, vetoedBy, note |
| `sources/<id>` | Hosts, Watcher | name, url, kind, by, lastChecked, lastItem |
| `asks/<id>` | Hosts | who, via, nameOk, text, status (new, top3, answered, held) |
| `contacts/<id>` | Hosts | name, channel (email, whatsapp), address, group |

## Updating

Edit `index.html` here, then republish it to the same artifact URL so the link and the stored data stay the same. The working copies Claude sessions read are in the project's shared files under `dashboard/`. Keep them in sync with this folder.
