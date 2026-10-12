# Hallucinating PMs Studio

The private production desk for *The two Hallucinating PMs*: a claude.ai artifact page plus the instructions the scheduled agents follow.

| File | What it is |
| --- | --- |
| `index.html` | The dashboard page, published as a claude.ai artifact with the `db`, `user` and `mcp` capabilities (`mcp` grants only Claude Code Remote's `fire_trigger`, so the "Write the script" button can start the script routine; that works only from the account that owns the routine). Shows the agent board, research digests, the lead picker and script review, ideas, watched sources, listener asks and the distribution list. |
| `research-run.md` | Instructions for the Monday and Thursday research run (6:52am Pacific). The run fans out five parallel research lanes, reports progress to the dashboard database, writes the digest and emails it to the two hosts. |
| `script-run.md` | Instructions for the on-demand script routine, started from the dashboard. Producer brief, a host-writer subagent, a separate fact-check subagent, then the draft goes up for review and both hosts get an email. Also handles rewrites and revisions. |

## Dashboard database

| Path | Written by | Fields |
| --- | --- | --- |
| `show/current` | Agents, hosts | episode, stage, title, note, waitingOn, leadPick {id, title, by, at}, scriptNotes, scriptRequested {by, at, kind} |
| `agents/<id>` | Agents | order, name, role, state (idle, working, waiting, done, failed), step, sources, found, ideas, log, updatedAt |
| `digests/<YYYY-MM-DD>` | Research run | date, day, markdown, createdAt, leads [{id, title, pitch, recommended}] |
| `episodes/ep<NN>` | Script run, hosts | number, titleOptions, lead, briefMd, scriptMd, factcheckMd, wordCount, status (review, revising, approved), approvedBy, approvedAt, feedback [{by, at, text}], createdAt, updatedAt |
| `ideas/<id>` | Hosts | text, link, by, status (new, promoted, vetoed, used, parked), promotedBy, vetoedBy, note |
| `sources/<id>` | Hosts, Watcher | name, url, kind, by, lastChecked, lastItem |
| `asks/<id>` | Hosts | who, via, nameOk, text, status (new, top3, answered, held) |
| `contacts/<id>` | Hosts | name, channel (email, whatsapp), address, group |

## Updating

Edit `index.html` here, then republish it to the same artifact URL so the link and the stored data stay the same. The working copies Claude sessions read are in the project's shared files under `dashboard/`. Keep them in sync with this folder.
