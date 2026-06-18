# openpalm/services — Unified Local AI Container Plan

> **Status:** revised 2026-06-16. Supersedes the previous "Local AI" draft.
> Renamed: `local-ai` → `services` throughout. Issues #430 and #431 are merged
> into a single `openpalm/services` addon. The `openpalm/voice` addon is
> **removed and replaced** by `openpalm/services` — `containers/voice/` is the
> starting point for `containers/services/`, not a parallel path.

---

## What already exists (don't re-invent it)

`openpalm/voice` (`containers/voice/`) is the template for everything below:

- **FastAPI app** — `containers/voice/app/server.py`, one port, OpenAI-compatible
  `/v1/audio/speech` + `/v1/audio/transcriptions`.
- **Model bundle** — `openpalm/voice-models:v1` (`FROM scratch`, `$BUILDPLATFORM`-
  pinned, optional `HF_TOKEN`). Runtime `COPY --from`s it so model downloads happen
  once per bump, not per build.
- **Out-of-band CI** — `publish-voice.yml` + `publish-voice-models.yml`, never in
  `release.yml`. Platform releases stay fast.
- **Decoupled image tag** — `voiceImageRef()` in `registry.ts`, `OP_VOICE_IMAGE_TAG`
  → moving `latest-<variant>`, independent of `OP_IMAGE_TAG`.

`openpalm/services` clones this pattern and extends it to four capabilities.

---

## Goal

One container per hardware class (`cpu` / `cuda` / `rocm` / `intel`). One FastAPI
app, one port (`4114`), four OpenAI-compatible endpoint groups:

| Endpoint | Capability | Library |
|---|---|---|
| `POST /v1/audio/speech` | TTS | Kokoro (from `containers/voice/`) |
| `POST /v1/audio/transcriptions` | STT | faster-whisper (from `containers/voice/`) |
| `POST /v1/embeddings` | Embeddings | onnxruntime + ONNX model |
| `POST /v1/chat/completions` | Chat LLM | llama-cpp-python (GGUF) |
| `POST /v1/images/generations` | Image gen | diffusers + torch |
| `GET /health` | Readiness | returns per-capability status |

No gateway layer. No capability enable/disable toggles (those are the deleted
`OP_CAP_*` resurrected — rejected, same as issue #430 notes). If a model file is
present, that endpoint works. If not, it returns `503`. Hardware determines what
runs well; users don't pick runtimes.

---

## Container structure

```
containers/services/
  Dockerfile             # multi-target: FROM runtime-common AS runtime-cpu/cuda/rocm/intel
  Dockerfile.models      # scratch bundle: Kokoro + Whisper + ONNX embed + GGUF + SD weights
  app/
    server.py            # FastAPI — all endpoints in one process
    tts.py               # Kokoro handler (from containers/voice/app/)
    stt.py               # faster-whisper handler (from containers/voice/app/)
    embeddings.py        # onnxruntime InferenceSession
    chat.py              # llama-cpp-python Llama()
    imagegen.py          # diffusers StableDiffusionPipeline
  requirements-common.txt
  requirements-cuda.txt  # torch+cuda, onnxruntime-gpu, llama-cpp-python[cuda]
  requirements-rocm.txt  # torch+rocm, llama-cpp-python[rocm]
  requirements-intel.txt # torch+xpu (Intel Extension for PyTorch), onnxruntime-openvino
  entrypoint.sh          # mkdir -p container-private paths only, then exec uvicorn
```

Hardware-specific Python packages are installed via build-arg at build time:

```dockerfile
# syntax=docker/dockerfile:1.7
ARG SERVICES_MODELS_IMAGE=openpalm/services-models:v1
FROM --platform=$BUILDPLATFORM ${SERVICES_MODELS_IMAGE} AS modelfetch

FROM python:3.11-slim AS base
# ... apt deps (libsndfile, ffmpeg, etc.) with cache mounts

FROM base AS runtime-common
COPY --from=modelfetch /models /opt/openpalm/models
COPY app/ /app/
COPY requirements-common.txt /app/

FROM runtime-common AS runtime-cpu
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r /app/requirements-common.txt

FROM runtime-common AS runtime-cuda
ARG CUDA_VERSION=12.4
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r /app/requirements-common.txt -r /app/requirements-cuda.txt

FROM runtime-common AS runtime-rocm
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r /app/requirements-common.txt -r /app/requirements-rocm.txt

FROM runtime-common AS runtime-intel
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r /app/requirements-common.txt -r /app/requirements-intel.txt
```

No supervisor (s6, supervisord). One uvicorn process. Each handler loads its model
at startup if the file exists; logs a warning and returns `503` if not.

---

## Model bundle (`openpalm/services-models:v1`)

Clone of `containers/voice/Dockerfile.models` extended to include all default models:

```dockerfile
FROM --platform=$BUILDPLATFORM python:3.11-slim AS fetch
# HF_TOKEN secret for gated models; retry/backoff on 429s (lesson from voice-models)
RUN --mount=type=secret,id=hf_token ...
    # Kokoro weights  → /models/tts/
    # Whisper weights → /models/stt/
    # ONNX embed model (e.g. nomic-embed-text-v1.5 ONNX, 768 dims) → /models/embeddings/
    # GGUF chat model (e.g. Llama-3.2-3B-Instruct.Q4_K_M.gguf, ~2GB) → /models/chat/
    # SD weights      (e.g. SD-Turbo safetensors) → /models/imagegen/

FROM scratch
COPY --from=fetch /models /models
```

**Model choices for defaults** (small, permissively licensed, fast on CPU):
- TTS: Kokoro (already shipped)
- STT: Whisper tiny/base (already shipped)
- Embeddings: `nomic-embed-text-v1.5` ONNX export (768 dims, Apache-2.0)
- Chat: `Llama-3.2-3B-Instruct.Q4_K_M.gguf` (~2 GB, Meta Llama 3.2 Community License)
- Image gen: SD-Turbo (`stabilityai/sd-turbo`, non-commercial for default; document this)

> **Image gen license note:** SD-Turbo has a non-commercial research license. The
> default can swap to a permissively licensed model (e.g. a fine-tune with Apache-2.0
> weights) before shipping. Implementation defers the exact choice; the wiring is
> identical regardless of model.

Bump runbook: edit `Dockerfile.models` → publish `openpalm/services-models:<new-tag>` via
`publish-services-models.yml` → update the `SERVICES_MODELS_IMAGE` ARG default →
publish runtime images.

---

## Image naming and tag resolution

Docker Hub `openpalm/` namespace, same as voice:

```
openpalm/services:latest-cpu
openpalm/services:latest-cuda
openpalm/services:latest-rocm
openpalm/services:latest-intel
openpalm/services:v0.13.0-cpu   # pinned on release
```

`servicesImageRef(variant)` in `packages/lib/src/control-plane/registry.ts` —
5-line clone of `voiceImageRef`:

```ts
export function servicesImageRef(variant: string): string {
  const ns = process.env.OP_IMAGE_NAMESPACE ?? 'openpalm';
  const tag = process.env.OP_SERVICES_IMAGE_TAG ?? `latest-${variant}`;
  return `${ns}/services:${tag}`;
}
```

---

## Compose profiles

Compose service name and network alias are both `services` — consistent with the
image name and the URLs used everywhere. The CPU variant uses the service name as
its implicit alias; GPU variants add an explicit `aliases: [services]` so the
alias is stable regardless of which variant is active (mirrors the `ollama` pattern).

In `.openpalm/config/stack/services.compose.yml` — **replaces** the existing
`voice` / `voice-cuda` / `voice-rocm` service blocks:

```yaml
services:
  services:
    profiles: ["addon.services.cpu"]
    image: ${OP_IMAGE_NAMESPACE:-openpalm}/services:${OP_SERVICES_IMAGE_TAG:-latest-cpu}
    restart: unless-stopped
    user: "${OP_UID:-1000}:${OP_GID:-1000}"
    ports:
      - "${OP_SERVICES_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}:${OP_SERVICES_PORT_HOST:-4114}:4114"
    volumes:
      - ${OP_HOME}/data/services:/data
    networks: [assistant_net]
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:4114/health || exit 1"]
      interval: 15s
      timeout: 10s
      retries: 5
      start_period: 60s
    labels:
      openpalm.name: "Local AI Services"
      openpalm.description: "Local voice, embeddings, chat, and image generation (OpenAI-compatible)"
      openpalm.icon: cpu
      openpalm.category: ai
      openpalm.profile.label: CPU
      openpalm.profile.default: "true"
      openpalm.healthcheck: http://services:4114/health

  services-cuda:
    profiles: ["addon.services.cuda"]
    image: ${OP_IMAGE_NAMESPACE:-openpalm}/services:${OP_SERVICES_IMAGE_TAG:-latest-cuda}
    restart: unless-stopped
    user: "${OP_UID:-1000}:${OP_GID:-1000}"
    runtime: nvidia
    environment:
      NVIDIA_VISIBLE_DEVICES: all
      NVIDIA_DRIVER_CAPABILITIES: compute,utility
    ports:
      - "${OP_SERVICES_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}:${OP_SERVICES_PORT_HOST:-4114}:4114"
    volumes:
      - ${OP_HOME}/data/services:/data
    networks:
      assistant_net:
        aliases: [services]
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:4114/health || exit 1"]
      interval: 15s
      timeout: 10s
      retries: 5
      start_period: 60s
    labels:
      openpalm.profile.label: NVIDIA (CUDA)
      openpalm.profile.requires: nvidia-container-toolkit

  services-rocm:
    profiles: ["addon.services.rocm"]
    image: ${OP_IMAGE_NAMESPACE:-openpalm}/services:${OP_SERVICES_IMAGE_TAG:-latest-rocm}
    restart: unless-stopped
    user: "${OP_UID:-1000}:${OP_GID:-1000}"
    ports:
      - "${OP_SERVICES_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}:${OP_SERVICES_PORT_HOST:-4114}:4114"
    volumes:
      - ${OP_HOME}/data/services:/data
    networks:
      assistant_net:
        aliases: [services]
    devices:
      - /dev/kfd
      - /dev/dri
    group_add: [render, video]
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:4114/health || exit 1"]
      interval: 15s
      timeout: 10s
      retries: 5
      start_period: 60s
    labels:
      openpalm.profile.label: AMD (ROCm)
      openpalm.profile.requires: amdgpu kernel module

  services-intel:
    profiles: ["addon.services.intel"]
    image: ${OP_IMAGE_NAMESPACE:-openpalm}/services:${OP_SERVICES_IMAGE_TAG:-latest-intel}
    restart: unless-stopped
    user: "${OP_UID:-1000}:${OP_GID:-1000}"
    ports:
      - "${OP_SERVICES_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}:${OP_SERVICES_PORT_HOST:-4114}:4114"
    volumes:
      - ${OP_HOME}/data/services:/data
    networks:
      assistant_net:
        aliases: [services]
    devices:
      - /dev/dri/renderD128:/dev/dri/renderD128
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:4114/health || exit 1"]
      interval: 15s
      timeout: 10s
      retries: 5
      start_period: 60s
    labels:
      openpalm.profile.label: Intel GPU
      openpalm.profile.requires: Intel GPU + render group membership
```

`OP_SERVICES_PROFILE` (e.g. `addon.services.cuda`) is set by the setup wizard's
hardware detection step and persisted to `knowledge/env/stack.env`.
`resolveActiveProfiles()` handles it via the `HARDWARE_PROFILED_ADDONS` data-driven
map (the `if/else voice/ollama` chain is replaced as part of this work).

---

## Capability wiring (existing mechanisms, unchanged)

| Capability | Wired via | URL form |
|---|---|---|
| TTS | `OP_TTS_BASE_URL` (host UI proxy) | `http://127.0.0.1:${OP_SERVICES_PORT_HOST}/v1` |
| STT | `OP_STT_BASE_URL` (host UI proxy) | `http://127.0.0.1:${OP_SERVICES_PORT_HOST}/v1` |
| Embeddings | `config/akm/config.json` embedding section | `http://services:4114/v1` (compose network alias) |
| Chat LLM | OpenPalm Connection → `auth.json` | `http://services:4114/v1` (compose network alias) |
| Image gen | `OP_IMAGEGEN_BASE_URL` | `http://127.0.0.1:${OP_SERVICES_PORT_HOST}/v1` |

No `OP_CAP_*`. No new env var surface beyond `OP_SERVICES_PROFILE`,
`OP_SERVICES_IMAGE_TAG`, `OP_SERVICES_BIND_ADDRESS`, `OP_SERVICES_PORT_HOST`.

**Host vs. network alias**: voice/imagegen are consumed by the host UI process →
published loopback port. Embeddings/chat are consumed by the assistant container
(in-network) → compose network alias `http://services:4114`. This distinction is a real
failure mode; get them backwards and one side silently fails.

---

## CI/CD

Two out-of-band, dispatchable workflows on `main` — never in `release.yml`:

- **`publish-services-models.yml`** — builds `openpalm/services-models:<tag>`
  (amd64 only, `scratch` final). `secrets: hf_token=${{ secrets.HF_TOKEN }}`,
  `cache type=gha,scope=openpalm/services-models`. Run on model bumps only.
- **`publish-services.yml`** — per-variant matrix (`cpu` amd64+arm64; `cuda`/`rocm`
  amd64-only; `intel` per device support). `docker/build-push-action@v6`, gha cache
  per variant, `fail-fast: false`. Gates on CI smoke test before push.

---

## Implementation phases (all target 0.13.0)

GPU variants are the goal; the phases are sequential implementation steps within
a single milestone, not separate releases.

**Phase 0 — DONE.** `openpalm/voice` + `voice-models:v1` + out-of-band workflows.
The proven foundation.

**Phase 1 — CPU: voice + embeddings.** Extend `containers/voice/` into
`containers/services/` (add `embeddings.py` + onnxruntime dep + nomic ONNX model in
the bundle). New `addon.services.cpu` compose profile. Wire embeddings to
`config/akm/config.json`. Unblocks all wiring work while GPU builds are still in progress.

**Phase 2 — Chat + image gen (CPU baseline).** Add `chat.py` (llama-cpp-python, GGUF)
and `imagegen.py` (diffusers). Add GGUF + SD weights to the bundle. Wire chat as a
Connection; wire imagegen via `OP_IMAGEGEN_BASE_URL`. CPU performance is slow for
image gen but validates the full endpoint surface before GPU work.

**Phase 3 — GPU variants (all three, same PR/milestone).** Build `runtime-cuda`,
`runtime-rocm`, and `runtime-intel` Dockerfile targets in a single pass:
- **CUDA**: `torch+cuda`, `llama-cpp-python[cuda]`, `onnxruntime-gpu`, `nvidia` deploy
  block in compose overlay.
- **ROCm**: `torch+rocm` (ROCm wheel index), `llama-cpp-python[rocm]` (hipBLAS),
  `onnxruntime` ROCm build, `/dev/kfd` + `/dev/dri` device passthrough.
- **Intel**: Intel Extension for PyTorch (IPEX/XPU), `llama-cpp-python` with SYCL
  backend, `onnxruntime-openvino` EP, `/dev/dri/renderD128` passthrough.

All three GPU variants ship in `publish-services.yml` as a matrix with `fail-fast: false`
so a slow ROCm build doesn't block CUDA publication.

---

## What this replaces / consolidates

- **Issue #430** (Local AI: voice + embeddings) → Phase 1 of `openpalm/services`.
- **Issue #431** (image gen addon, closed) → Phase 2 of `openpalm/services`. A
  separate `openpalm/imagegen` addon is unnecessary once `torch` is already in the
  image for GPU support; the endpoint is just another FastAPI handler.
- **`openpalm/voice` addon** — **removed**. `containers/voice/` is the starting
  point for `containers/services/`; the voice Dockerfile stages, app code, and
  `voice-models:v1` bundle pattern are folded in, then `containers/voice/` is
  deleted. The `voice` addon name, `OP_VOICE_*` env vars, `publish-voice*.yml`
  workflows, and `addon.voice.*` compose profiles are all removed.

---

## Migration (existing installs)

A layout migration must handle the rename before the next `openpalm up`:

- `OP_ENABLED_ADDONS`: rename `voice` → `services`
- `OP_VOICE_PROFILE=addon.voice.<variant>` → `OP_SERVICES_PROFILE=addon.services.<variant>`
  (variant map: `cpu` → `cpu`, `cuda` → `cuda`, `rocm` → `rocm`)
- `OP_VOICE_PORT_HOST` → `OP_SERVICES_PORT_HOST` (default changes 8880 → 4114)
- `OP_TTS_BASE_URL` / `OP_STT_BASE_URL` pointing at `127.0.0.1:8880` → rewrite to `127.0.0.1:4114`
- `OP_VOICE_WHISPER_MODEL` → drop (value becomes the `OP_STT_MODEL` default in the
  services container; if non-default, preserve as `OP_STT_MODEL`)
- `OP_VOICE_KOKORO_VOICE` → drop (value becomes `OP_TTS_VOICE` default; preserve
  if non-default)
- `data/voice/` → `data/services/` (rename the bind-mount dir; migration must mv,
  not copy, to avoid doubling disk usage)

---

## What is NOT in scope

- No capability enable/disable env flags (`OP_SERVICES_ENABLE_*`). That's `OP_CAP_*`
  with different names. A 503 from a missing model file is sufficient signal.
- No in-container supervisor. One uvicorn process; if an engine can't co-host in
  that process without crashing the others, that's a signal to reconsider, not a
  reason to add supervisord.
- No Ollama replacement. Ollama remains the advanced LLM addon. `openpalm/services`
  is the simple default for single-user localhost use.
- No fancy gateway routing layer. One FastAPI app. Routes map directly to model
  handlers. No model aliasing system.
- No advanced override surface in Phase 1–2. Model paths are baked from the bundle.
  Users who want custom models drop them into `data/ai/models/` and set
  `OP_SERVICES_MODEL_PATH_*` (Phase 3+).
