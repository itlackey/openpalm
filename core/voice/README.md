# `openpalm/voice`

Self-contained TTS + STT container. One FastAPI process exposes an
OpenAI-compatible HTTP surface:

- `POST /v1/audio/speech` — Kokoro-82M TTS (`kokoro-onnx`)
- `POST /v1/audio/transcriptions` — faster-whisper STT
- `GET  /v1/models`
- `GET  /health`

Two image tags are published from this single `Dockerfile` via a build-arg:

| Tag | Build arg | Wheels installed |
|---|---|---|
| `openpalm/voice:vX.Y.Z-cpu`   | `VARIANT=cpu` (default) | `torch==2.5.1+cpu`,  `onnxruntime==1.20.1` |
| `openpalm/voice:vX.Y.Z-cu121` | `VARIANT=cu121`         | `torch==2.5.1+cu121`, `onnxruntime-gpu==1.20.1` |

The runtime is `python:3.11-slim-bookworm`. Multi-stage build keeps the
final image lean by copying only the venv across.

See [`docs/technical/voice-container-build.md`](../../docs/technical/voice-container-build.md)
for the full design (base-image rationale, RAM budget, model loading
strategy).

## Build

```bash
# From the repo root.

# CPU variant (default — pulls torch+cpu, ~420 MB compressed)
docker build -t openpalm/voice:v0.11.0-cpu core/voice

# CUDA 12.1 variant (~1.4 GB compressed)
docker build --build-arg VARIANT=cu121 -t openpalm/voice:v0.11.0-cu121 core/voice
```

## Run (standalone, for testing)

```bash
mkdir -p /tmp/voice-models
docker run --rm -p 8880:8880 -v /tmp/voice-models:/models openpalm/voice:v0.11.0-cpu

# First request triggers Kokoro model + voices download (~340 MB total).
# Watch /health flip from {"status":"loading"} to {"status":"ok"}.
```

The addon overlay (under `.openpalm/state/registry/addons/openpalm-voice/`)
handles the compose wiring — bind-mounts `${OP_HOME}/state/voice/models`
into `/models`, joins `assistant_net`, no host port binding.

## Smoke tests

```bash
# Health
curl -s http://localhost:8880/health | jq

# Models
curl -s http://localhost:8880/v1/models | jq

# Transcription (any wav your distro ships; this is a tiny 1.6 s sample)
curl -s -X POST http://localhost:8880/v1/audio/transcriptions \
  -F file=@/usr/share/sounds/alsa/Front_Center.wav \
  -F model=whisper-1 \
  -F response_format=json | jq

# Speech
curl -s -X POST http://localhost:8880/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{"model":"kokoro","input":"Hello from OpenPalm.","voice":"bf_isabella","response_format":"wav"}' \
  --output /tmp/out.wav
file /tmp/out.wav   # RIFF (little-endian) WAVE
```

## Configuration

Environment variables (all optional, defaults in parens):

| Var | Default | Purpose |
|---|---|---|
| `OP_VOICE_PORT` | `8880` | HTTP listen port |
| `OP_VOICE_WHISPER_MODEL` | `base.en` | faster-whisper model name |
| `OP_VOICE_WHISPER_MODEL_DIR` | `/opt/whisper` | model cache dir (pre-baked in the image) |
| `OP_VOICE_KOKORO_VOICE` | `bf_isabella` | default voice ID |
| `OP_VOICE_KOKORO_DIR` | `/opt/kokoro` | model cache dir (pre-baked in the image) |
| `OP_VOICE_LOG_LEVEL` | `INFO` | python logging level |

## Notes

- **LAN-only.** No auth, no API key. The addon overlay binds the service
  to `assistant_net` with no host port, so only other containers on that
  network can reach it. If you need to publish it publicly, route it
  through a channel adapter / reverse proxy.
- **All default models are pre-baked.** Kokoro lives at `/opt/kokoro/`
  (~340 MB — model + all 54 voices). The default faster-whisper model
  (`Systran/faster-whisper-base.en`, ~145 MB) lives at `/opt/whisper/`
  in the HF cache layout that `WhisperModel(download_root=...)` expects.
  Cold-start makes zero network requests for the defaults; the
  `start_period=180s` healthcheck only matters if an operator overrides
  `OP_VOICE_WHISPER_MODEL` to a non-bundled size.
- **Picking a different Whisper model** (e.g. `small.en`, `medium`,
  multilingual `base`) re-introduces a first-run download into
  `OP_VOICE_WHISPER_MODEL_DIR`. Point it at a bind-mounted host path if
  you want the cache to survive image upgrades.
- **GPU images.** The `cu121` variant expects `nvidia-container-toolkit`
  on the host plus driver ≥530.30.02. See the addon `gpu.compose.yml`.
