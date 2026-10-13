# Audio render run (Hallucinating PMs Studio)

How the production thread renders an approved script to audio. It starts when a host presses **Approve script** on the Studio (routine "Hallucinating PMs audio render (on demand)") or **Render audio** on an approved episode. Studio: https://claude.ai/artifact/UcZgdyKCCwcPMRYi41yb6g (db via the ArtifactData tool).

Only render an episode whose doc in `episodes` has status "approved". Spend is approved for ElevenLabs only: one full take of a ~13k-character episode is about $1 on Eleven v4. Don't do more than two full takes without asking a host.

## 0. Report live
Update `agents/audio` as you go (state "working", one `log` line per step with `t` = now in ms, `step` = what's happening, `updatedAt`), and `show/current`: stage "Audio", waitingOn null, note "Rendering the audio".

## 1. Get the renderer
The renderer is draft PR #5's code, branch `claude/project-thread-nfin7n` (based on `claude/tts-renderer`) in anantbhatia/Podcast-App. Don't write a new renderer. Check it out into a scratch worktree:
`git fetch origin claude/project-thread-nfin7n && git worktree add <scratch>/renderer origin/claude/project-thread-nfin7n`
It defaults to `eleven_v4`, maps ANANT and AMAN to the hosts' clone voices, fixes how "Anant" and "Anthropic" are said, and reads `ELEVENLABS_API_KEY` from the environment. It needs ffmpeg (and numpy and soundfile for scoring).

## 2. Render the speech
Write the episode doc's `scriptMd` to `episodes/epNN/script.md` if they differ (the Studio copy wins; hand edits are fact-checked per script-run.md first). Then:
1. `python render/render_elevenlabs.py episodes/epNN/script.md <scratch>/epNN-voice.mp3 --dry-run` and log the character count.
2. If the count is over 20,000, stop and tell the hosts in the thread before spending.
3. Run it again without `--dry-run`.

## 3. Score it with the theme
Use `render/score_episode.py` with the current theme `/mnt/project-files/pilot/theme-electronic.mp3`. Run the voice samples thread's latest choice instead if a newer theme sits next to it. Find `--title-end`, the second where "Two Hallucinating PMs" ends, by transcribing the first 90 seconds with word timestamps (faster-whisper, as the listener pipeline does). Fall back to `ffmpeg silencedetect` on the opening. Then listen-check it by transcribing about 30 seconds around the title call and confirm the theme lands right after it.

## 4. Save and check
- Save to `/mnt/project-files/episodes/epNN/audio/epNN.mp3` as 96 kbps mp3, under 15 MB.
- Transcribe the full file and compare it with the script. Flag any read-aloud tags (words like "laughs" or "jumping in" spoken as words), skipped lines, or mispronounced names. Re-render only the affected section with `--start-at`/`--stop-at` and splice it in.
- Update `episodes/epNN` with `audio: {path, durationSec, chars, model, renderedAt}`, `status: "audio_review"`, `updatedAt`.
- Update `agents/audio` with state "done", `found` = duration, and `step` = "Episode N rendered: mm:ss on Eleven v4".
- Update `show/current` with stage "Final review", note "Audio ready for review", waitingOn "Either host to listen and approve the audio".

## 5. Tell the hosts
Email anantbhatia@gmail.com and agoyal@shashi.ai: "Episode N audio is ready". Include the length, attach the mp3 if it's under 20 MB, and say anything the transcript check flagged. Post one short thread reply with the file attached. Publishing to the listening page belongs to the "Episode listening pages" thread: say in the reply that the audio is ready for it, and the coordinator hands it over. Nothing goes to the distribution list.

## If something fails
Set `agents/audio` state "error" with the reason in `step`, and set `show/current` waitingOn to the blocker. Say what failed in one thread reply. For an out-of-credits error, the fix is the ElevenLabs plan (Anant's call).
