# Addon: `voice`

One container exposing **OpenAI-compatible TTS + STT** on the internal
`assistant_net` Docker network. Anything on that network (assistant,
guardian, other channels) can reach it as `http://voice:8880`.

| Endpoint | Backend |
|---|---|
| `POST /v1/audio/speech` | Kokoro-82M via `kokoro-onnx` |
| `POST /v1/audio/transcriptions` | faster-whisper (`base.en` by default) |
| `GET  /v1/models`, `GET /health` | metadata |

See [`core/voice/README.md`](../../../../core/voice/README.md) for the
container image itself; this README is for the compose overlay only.

## Enable

This addon is registered in the OpenPalm addon catalog. Enable it with the CLI
or admin UI, or manually copy the overlay into the runtime stack:

```bash
# From OP_HOME:
cp -r state/registry/addons/voice config/stack/addons/voice

# Then restart the stack so compose picks up the new overlay.
./run.sh up -d
```

The compose driver materializes the model bind-mount directory the first
time the container starts.

## GPU (optional)

Hardware variants are Compose profiles in `compose.yml`:

| Profile | Image suffix | Hardware |
|---|---|---|
| `addon.voice.cpu` | `-cpu` | CPU |
| `addon.voice.cuda` | `-cu121` | NVIDIA CUDA 12.1 |
| `addon.voice.rocm` | `-rocm6` | AMD ROCm 6.x |

Requirements on the host:

- NVIDIA driver ≥ 530.30.02 (CUDA 12.1 compatible)
- [`nvidia-container-toolkit`](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
  installed and `docker info` lists `nvidia` under "Runtimes"

Select a profile in `config/stack/stack.env`:

```bash
OP_VOICE_PROFILE=addon.voice.cuda
```

Verify GPU passthrough by checking the container logs at boot — the
`[voice] torch.cuda.is_available=True` and
`[voice] onnxruntime providers=[CUDAExecutionProvider, ...]` lines confirm
the engines saw the GPU.

## Disk + RAM

| Resource | CPU variant | CUDA variant |
|---|---|---|
| Image (compressed) | ~750 MB | ~1.5 GB |
| Model artifacts (baked) | ~340 MB Kokoro + ~145 MB Whisper `base.en` | same |
| Resident RAM at idle | ~700 MB | ~1.1 GB (CUDA workspace) |
| Resident RAM under load | ~1.0 GB | ~1.5 GB |

Default models (Kokoro-82M + voices, faster-whisper `base.en`) are
**pre-baked into the image** — cold-start performs no network requests.
The bind-mounted `${OP_HOME}/state/voice/models` volume is only used
when an operator overrides `OP_VOICE_WHISPER_MODEL` to a non-default
size (small/medium/multilingual), which triggers a one-time HF
download into that path.

## Smoke tests (from inside the stack)

```bash
# Hop into the assistant container (it has curl and lives on assistant_net):
docker compose exec assistant bash

# /health
curl -s http://voice:8880/health | jq

# /v1/models
curl -s http://voice:8880/v1/models | jq

# /v1/audio/speech — write 16-bit WAV
curl -s -X POST http://voice:8880/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{"model":"kokoro","input":"OpenPalm voice online.","voice":"bf_isabella","response_format":"wav"}' \
  --output /tmp/voice.wav
ls -lh /tmp/voice.wav   # ~50 KB for a short phrase

# /v1/audio/transcriptions — round-trip the file we just generated
curl -s -X POST http://voice:8880/v1/audio/transcriptions \
  -F file=@/tmp/voice.wav \
  -F model=whisper-1 | jq
# Expected: {"text": " OpenPalm voice online.", "language": "en"}
```

## Notes

- **No auth.** The service is unauthenticated by design — it only listens
  on `assistant_net`, never on a host port. Do not add a `ports:` block
  here. If you need LAN or WAN exposure, route through a channel adapter.
- **No docker socket.** This container has no privileged access.
- **Single worker.** Both engines are loaded once into one Uvicorn worker.
  Concurrent requests are interleaved via `asyncio.to_thread`. Don't
  bump `--workers`; you'll double the model RAM footprint.
- **Voice catalog.** The bundled `voices-v1.0.bin` ships all 54 Kokoro
  voices. Pass any of them via the `voice` field in `/v1/audio/speech`.
