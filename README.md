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
