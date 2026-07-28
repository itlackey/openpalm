# OpenPalm Voice Container

Self-contained FastAPI service providing OpenAI-compatible text-to-speech and
speech-to-text:

- `POST /v1/audio/speech` using Kokoro-82M
- `POST /v1/audio/transcriptions` using faster-whisper
- `GET /v1/models`
- `GET /health`

## Stack Integration

Voice is defined in
`packages/skeleton/system/stack/services.compose.yml`, not a portal file. It:

- activates through an `addon.voice.*` profile
- joins `addon_net`, not `assistant_net`
- publishes `127.0.0.1:${OP_VOICE_PORT_HOST:-8880}:8880`
- is reached by a host UI through the same-origin `/voice/*` pass-through
- has no authentication of its own and defaults to loopback-only

Hardware variants are selected by managed Compose profiles and host checks. The
control plane may add its managed CDI or rootless fallback file; operators do
not maintain a generic GPU overlay.

## Image Variants

The current Dockerfile builds CPU and NVIDIA CUDA 12.1 variants:

| Variant | Build argument | Published suffix |
|---|---|---|
| CPU | `VARIANT=cpu` | `-cpu` |
| NVIDIA CUDA | `VARIANT=cu121` | `-cu121` |

ROCm is not implemented by this Dockerfile; its guard fails rather than
silently producing a CPU image with a ROCm label.

## Image-Baked Models

The default Kokoro model/voices and faster-whisper `base.en` artifacts are
copied from the `openpalm/voice-models` build image into `/opt/kokoro` and
`/opt/whisper`. Default cold start does not download model files.

Selecting a non-default Whisper model can trigger a download. Point its model
directory at persistent storage if that override must survive image updates.

## Build

From the repository root:

```bash
docker build \
  --build-arg VARIANT=cpu \
  -t openpalm/voice:0.13.0-cpu \
  containers/voice

docker build \
  --build-arg VARIANT=cu121 \
  -t openpalm/voice:0.13.0-cu121 \
  containers/voice
```

The CUDA image requires a compatible NVIDIA driver and container runtime.

## Standalone Test

```bash
docker run --rm \
  -p 127.0.0.1:8880:8880 \
  openpalm/voice:0.13.0-cpu
```

```bash
curl -fsS http://127.0.0.1:8880/health | jq
curl -fsS http://127.0.0.1:8880/v1/models | jq

curl -fsS -X POST http://127.0.0.1:8880/v1/audio/transcriptions \
  -F file=@sample.wav \
  -F model=whisper-1 \
  -F response_format=json | jq

curl -fsS -X POST http://127.0.0.1:8880/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{"model":"kokoro","input":"Hello from OpenPalm.","voice":"bf_isabella","response_format":"wav"}' \
  --output /tmp/openpalm-voice.wav
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OP_VOICE_PORT` | `8880` | Container HTTP port |
| `OP_VOICE_WHISPER_MODEL` | `base.en` | faster-whisper model |
| `OP_VOICE_WHISPER_MODEL_DIR` | `/opt/whisper` | Whisper model directory |
| `OP_VOICE_KOKORO_VOICE` | `bf_isabella` | Default voice |
| `OP_VOICE_KOKORO_DIR` | `/opt/kokoro` | Kokoro model directory |
| `OP_VOICE_LOG_LEVEL` | `info` | Application log level |

Do not publish the service beyond loopback without adding an authenticated
operator-managed gateway.

See
[Voice Container Build](../../docs/technical/voice-container-build.md) for the
build rationale and resource budget.
