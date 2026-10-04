# podcast-app

Personalized two-host AI show ("Terms & Conditions"). Scripts and the Show Bible live in the project files; this repo holds the pipeline.

## Render an episode to audio

Uses [Kokoro](https://github.com/thewh1teagle/kokoro-onnx), a free local TTS model (CPU is fine; a 13-minute episode takes about 5 minutes on 4 cores).

```sh
pip install -r requirements.txt
mkdir -p models && cd models
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
cd ..
python render/render_episode.py path/to/ep01-script.md out/ep01.wav
```

Voices: Mara is `af_heart`, Theo is `am_michael` at 1.08x. A line ending in `—` is an interruption, so the next speaker comes in 0.35 s before it ends. `[DEEPER: …]` and bracketed stage directions like `[laughs]` are skipped.

## Render with ElevenLabs (expressive)

`render/render_elevenlabs.py` sends the script to ElevenLabs v3 text-to-dialogue, which performs each section as one conversation, so `[laughs]` and em-dash interruptions come through. It needs `ELEVENLABS_API_KEY` and ffmpeg, and no extra Python packages.

```sh
python render/render_elevenlabs.py path/to/ep01-script.md out/ep01.mp3 --stop-at "Amazon blocks" --dry-run   # character count = credits
python render/render_elevenlabs.py path/to/ep01-script.md out/ep01.mp3 --stop-at "Amazon blocks"
```

Voices: Mara is Sarah (`EXAVITQu4vr4xnSDxMaL`), Theo is Chris (`iP95p4xoKVk53GoZ742B`), both ElevenLabs default voices because the free tier can't use library voices over the API. Credits are about one per character: the full Ep 1 is about 13,000, the cold open plus "What Muse is" about 4,000. Use `--start-at`/`--stop-at` with any `##` or `###` heading, and `--seed` for a repeatable take.
