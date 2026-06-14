# Voice Container Build — `openpalm/voice`

> Status: **DESIGN** (not yet implemented). Supersedes the "two containers"
> recommendation in [`openpalm-voice-addon.md`](./openpalm-voice-addon.md)
> — this design bundles Kokoro TTS + Whisper STT into one image. The rest of
> that doc (enable flow, probe endpoint, VoiceTab UX, presets) still applies
> with `voice-tts`/`voice-stt` collapsed to a single `voice` service.
>
> One process. OpenAI-compatible HTTP. CPU by default, CUDA on `--gpus all`.
> Target image: <1.5 GB compressed. No auth, internal `assistant_net` only.

---

## 1. Base image

**Recommendation: `python:3.11-slim-bookworm`** (Debian 12, ~45 MB compressed,
~125 MB extracted — per Docker Hub `python` tags).

CUDA support comes from **pip wheels**, not the base image:

- `torch` from `https://download.pytorch.org/whl/cu121` ships a CUDA 12.1
  userspace runtime inside the wheel (`libcudart`, `libcublas`, `libcudnn`).
  The host kernel driver + container runtime (`nvidia-container-toolkit`)
  supplies the rest. No CUDA in the image when the host is CPU-only.
- `onnxruntime-gpu` (1.20.x) ships its own CUDA EP stubs and links against
  whatever the nvidia container runtime injects at start.

Why not `nvidia/cuda:12.x-runtime-ubuntu22.04`? That image is **~2.3 GB
compressed** baseline and pulls CUDA libraries we don't need on CPU hosts.
Why not `pytorch/pytorch:2.x-cuda12.1-cudnn8-runtime`? **~3.9 GB compressed**,
overkill for CPU-only deployments.

The pip-wheel approach means a CPU host pulls torch's CPU wheel
(`torch==2.5.1+cpu`, ~190 MB) and never downloads the CUDA wheel. Selection
happens via the `Dockerfile` `ARG TORCH_VARIANT=cpu|cu121`. We build and
publish **two tags** of the same image (`openpalm/voice:v0.11.0-cpu` and
`openpalm/voice:v0.11.0-cu121`). The compose overlay defaults to `-cpu`;
the GPU overlay variant selects `-cu121`. This is simpler than dynamic
runtime detection and avoids shipping CUDA wheels to CPU-only users.

---

## 2. Whisper backend

**Pick: `faster-whisper==1.1.0`** (CTranslate2 backend).

```
pip install faster-whisper==1.1.0
```

Reasons over alternatives:

- **`openai-whisper`** depends on full `torch` + `tiktoken` and is ~3× slower
  than faster-whisper on the same hardware. Reference impl only.
- **`whisper.cpp` Python bindings** (`pywhispercpp`) are fast on CPU but the
  CUDA build requires a compile step against the host's CUDA headers; not
  portable across the same wheel.
- **`transformers` pipeline** pulls the full HF stack (~600 MB of deps,
  tokenizers, accelerate) for what one model loader does.

faster-whisper uses CTranslate2 which supports `compute_type="int8"` (CPU)
and `compute_type="float16"` (GPU) from the same Python API. Model loading:

```python
from faster_whisper import WhisperModel
model = WhisperModel(
    "base.en",
    device="cuda" if torch.cuda.is_available() else "cpu",
    compute_type="float16" if torch.cuda.is_available() else "int8",
    download_root="/models/whisper",
)
```

Model files: `Systran/faster-whisper-base.en` (~145 MB) downloads from
HuggingFace on first start into `/models/whisper/` (bind-mounted). Pre-warm
with a 1-second silence buffer at startup to avoid first-request latency
spike.

Reference: https://github.com/SYSTRAN/faster-whisper (CT2 perf table shows
4–10× realtime on int8 CPU).

---

## 3. Kokoro backend

**Pick: `kokoro-onnx==0.4.9`** (ONNX Runtime).

```
pip install kokoro-onnx==0.4.9
```

Reasons over alternatives:

- **`kokoro` PyTorch package** requires `torch` *and* `phonemizer` (which
  itself requires `espeak-ng` system binary). ONNX path bundles phonemization
  via `misaki` (pure Python) — no apt dep.
- **Raw `onnxruntime` + manual wiring** would replicate what `kokoro-onnx`
  already does. No win.

GPU: install `onnxruntime-gpu==1.20.1` for the CUDA variant; `onnxruntime==1.20.1`
for CPU. `kokoro-onnx` picks up whichever is installed.

Model files (downloaded once on first start into `/models/kokoro/`):

- `kokoro-v1.0.onnx` (~310 MB) — main model.
- `voices-v1.0.bin` (~27 MB) — bundled voice embeddings for all 54 voices
  including `af_bella`.

Both fetched from `https://github.com/thewh1teagle/kokoro-onnx/releases`.
Pin the version in code so the URL is stable. Initialization:

```python
from kokoro_onnx import Kokoro
providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if cuda else ["CPUExecutionProvider"]
tts = Kokoro("/models/kokoro/kokoro-v1.0.onnx", "/models/kokoro/voices-v1.0.bin", providers=providers)
audio, sr = tts.create("Hello world", voice="af_bella", speed=1.0, lang="en-us")
```

---

## 4. HTTP framework

**Pick: FastAPI 0.115 + Uvicorn 0.32** (single worker — see §6).

```
pip install "fastapi==0.115.6" "uvicorn[standard]==0.32.1" "python-multipart==0.0.20"
```

Litestar is comparable in size but the OpenAI client examples and community
recipes are all FastAPI-shaped; the wins don't justify diverging. Starlette
directly saves ~5 MB but loses validation; not worth it for an MVP.

Single Uvicorn worker (no `--workers N`). Both Whisper and Kokoro models are
loaded once at startup into process memory; multiple workers would each load
their own copy and double RAM. Concurrency comes from async route handlers
with the heavy inference offloaded via `asyncio.to_thread`.

---

## 5. API skeleton

Endpoints + exact OpenAI-shape contracts. Cites: OpenAI audio API docs at
`https://platform.openai.com/docs/api-reference/audio`.

### `POST /v1/audio/transcriptions`
Ref: https://platform.openai.com/docs/api-reference/audio/createTranscription

Multipart form-data:
- `file` (required) — binary audio (any ffmpeg-decodable format).
- `model` (optional, default `whisper-1`) — accepted but **ignored**;
  internally always maps to the loaded faster-whisper model.
- `language` (optional, e.g. `"en"`) — forwarded to faster-whisper.
- `prompt` (optional) — initial prompt biasing.
- `response_format` (optional, default `"json"`) — `json`, `text`,
  `srt`, `verbose_json`, `vtt`. MVP: implement `json` + `text` only,
  return 400 for the others.
- `temperature` (optional, default `0`).

Response (`response_format=json`): `{"text": "..."}`. Status 200.

### `POST /v1/audio/speech`
Ref: https://platform.openai.com/docs/api-reference/audio/createSpeech

JSON body: `{"model": "kokoro", "input": "...", "voice": "af_bella",
"response_format": "mp3", "speed": 1.0}`.
- `model` accepted but ignored (always Kokoro).
- `voice` — Kokoro voice ID (`af_bella`, `am_michael`, `bf_emma`, ...).
- `response_format` — `mp3`, `wav`, `opus`, `flac`, `pcm`. MVP: `mp3` and
  `wav` only; others return 400. mp3 via `pydub` + `lameenc` wheel (no
  apt dep) OR pipe through `ffmpeg` (already installed for STT).
- `speed` — passed to `kokoro.create`.

Response: raw audio bytes. `Content-Type: audio/mpeg` for mp3,
`audio/wav` for wav. Status 200.

### `GET /v1/models`
Ref: https://platform.openai.com/docs/api-reference/models/list

```json
{"object": "list", "data": [
  {"id": "whisper-1", "object": "model", "created": 1700000000, "owned_by": "openpalm"},
  {"id": "kokoro",    "object": "model", "created": 1700000000, "owned_by": "openpalm"}
]}
```

### `GET /health`

```json
{"status": "ok", "tts": "ready", "stt": "ready", "device": "cuda"|"cpu"}
```

While models are still downloading: `{"status": "loading", "tts": "loading",
"stt": "ready", ...}` and HTTP 503 (so Docker healthcheck stays red until
both halves are ready).

---

## 6. GPU detection

At process startup, in this order:

```python
import torch
import onnxruntime as ort

cuda_available = torch.cuda.is_available()
ort_providers  = ort.get_available_providers()
device = "cuda" if cuda_available and "CUDAExecutionProvider" in ort_providers else "cpu"
print(f"[voice] device={device} torch.cuda={cuda_available} ort_providers={ort_providers}", flush=True)
```

Operator-visible log line on startup:

```
[voice] device=cuda torch.cuda=True ort_providers=['CUDAExecutionProvider', 'CPUExecutionProvider']
[voice] loading whisper model base.en (compute_type=float16)
[voice] loading kokoro v1.0 (providers=['CUDAExecutionProvider'])
[voice] ready — listening on :8880
```

If `torch.cuda` is True but ORT lacks the CUDA provider (mismatched wheel),
log a `WARN` and run STT on GPU but TTS on CPU rather than failing. The
`-cu121` image variant guarantees both wheels match; the `-cpu` variant
will always print `device=cpu`.

---

## 7. Model loading + persistence

- **Whisper cache**: `/models/whisper/` inside container. Bind-mounted from
  `${OP_HOME}/data/voice/models/whisper/` on the host. faster-whisper's
  `download_root` parameter points here directly — no `HF_HOME` indirection.
- **Kokoro cache**: `/models/kokoro/` inside container ←
  `${OP_HOME}/data/voice/models/kokoro/` on host. Container code checks
  for the two files at startup, downloads via `urllib` if missing
  (idempotent — `mtime` not checked, presence only).
- **`/models` parent** is `${OP_HOME}/data/voice/models/`. The enable
  endpoint pre-creates this as `OP_UID:OP_GID` so the container (running
  unprivileged) can write into it.

Models download **on first start, not at build time**, to keep the image
small and let users pre-seed the bind mount if they want to ship models out
of band.

Healthcheck behavior:
- During download: `/health` returns 503 + `{"status": "loading"}`.
- Once both models loaded: 200 + `{"status": "ok"}`.
- Docker healthcheck uses `start_period: 180s` to absorb the first-pull
  ~250 MB download on a typical home connection.

---

## 8. Image size budget

For the **`-cpu` variant**:

| Layer | Size (compressed) |
|---|---|
| `python:3.11-slim-bookworm` base | ~45 MB |
| apt: `ffmpeg`, `libsndfile1`, `curl`, `ca-certificates` | ~75 MB |
| pip: `torch==2.5.1+cpu` | ~190 MB |
| pip: `onnxruntime==1.20.1` | ~12 MB |
| pip: `faster-whisper==1.1.0` (incl. `ctranslate2` wheel ~35 MB) | ~50 MB |
| pip: `kokoro-onnx==0.4.9` (incl. `misaki` phonemizer) | ~15 MB |
| pip: `fastapi`, `uvicorn[standard]`, `python-multipart`, `pydub`, `lameenc` | ~30 MB |
| App source (`/app/server.py`, entrypoint) | <1 MB |
| **Total `-cpu`** | **~420 MB compressed** |

For the **`-cu121` variant**:

| Delta from `-cpu` | Size |
|---|---|
| Replace `torch+cpu` with `torch==2.5.1+cu121` | +900 MB |
| Replace `onnxruntime` with `onnxruntime-gpu==1.20.1` | +180 MB |
| **Total `-cu121`** | **~1.4 GB compressed** |

Within the <1.5 GB budget. If `-cu121` ends up over budget (PyTorch CUDA
wheel size drifts), slim with: `pip install --no-deps torch && pip install
<minimal-deps>`, and strip `torch.testing`/`torch.utils.tensorboard` via
post-install `rm -rf`. Multi-stage build is **not** worth it here — pip
already does the right thing; cleanup must happen in the same RUN as
install to keep the layer small.

---

## 9. Compose addon overlay

`.openpalm/config/stack/portals.compose.yml`:

```yaml
# Addon: voice — bundled Kokoro TTS + Whisper STT in one container.
# OpenAI-compatible /v1/audio/speech and /v1/audio/transcriptions.
# CPU by default; the openpalm-voice-gpu addon variant flips to the cu121 image.
services:
  voice:
    image: ${OP_IMAGE_NAMESPACE:-openpalm}/voice:${OP_VOICE_IMAGE_TAG:-v0.11.0-cpu}
    restart: unless-stopped
    user: "${OP_UID:-1000}:${OP_GID:-1000}"
    # NO ports: — internal-only. Other services reach it via http://voice:8880
    # on assistant_net. The browser UI uses the voice channel's proxy.
    environment:
      VOICE_PORT: "8880"
      VOICE_LOG_LEVEL: "${OP_VOICE_LOG_LEVEL:-info}"
      VOICE_WHISPER_MODEL: "${OP_VOICE_WHISPER_MODEL:-base.en}"
      VOICE_DEFAULT_VOICE: "${OP_VOICE_DEFAULT_VOICE:-af_bella}"
    volumes:
      - ${OP_HOME}/data/voice/models:/models
    networks: [assistant_net]
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:8880/health || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 180s
    labels:
      openpalm.name: OpenPalm Voice
      openpalm.description: Local Kokoro TTS + Whisper STT (OpenAI-compatible)
      openpalm.icon: mic
      openpalm.category: voice
      openpalm.healthcheck: http://voice:8880/health
```

Existing assistant uses `assistant_net` the same way (see `core.compose.yml`
networks block at line 155). No host port binding mirrors how guardian and
assistant talk on the internal net.

### GPU passthrough (optional second overlay file)

`.openpalm/config/stack/portals.compose.yml referenced inline; not a separate addoncompose.yml`:

```yaml
# Addon overlay: voice-gpu (file in addons/voice/) — layered on top of voice.
# Requires nvidia-container-toolkit on the host. Otherwise this overlay
# does nothing harmful — Docker will refuse to start the service with a
# clear error, leaving the CPU variant available.
services:
  voice:
    image: ${OP_IMAGE_NAMESPACE:-openpalm}/voice:${OP_VOICE_IMAGE_TAG:-v0.11.0-cu121}
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

This is a strict **overlay**: enabling `openpalm-voice-gpu` only works when
`openpalm-voice` is also enabled (the base service definition lives there).
A future detection step in the install/enable flow can auto-enable the GPU
overlay when `nvidia-smi` is present (per the §7 stretch goal in
`openpalm-voice-addon.md`).

The bare addon stays GPU-free so the same compose file works on hosts
without `nvidia-docker`. Two separate overlays is cleaner than conditional
YAML — Docker Compose has no `if` operator and `core-principles.md`
forbids string-interpolation template rendering.

---

## 10. Open questions

1. **Voice file management — who owns voice updates?** Kokoro voice
   embeddings live in `voices-v1.0.bin` (bundled, 54 voices). Future voice
   packs may ship separately. Recommend: keep MVP to the bundled set; defer
   a "voice picker" UI to a later phase. The `voice` field in `/v1/audio/speech`
   accepts any ID in the loaded bin; unknown voices return 400.
2. **MP3 encoding dep.** `lameenc` is a manylinux wheel (~3 MB, no apt dep),
   works on glibc 2.28+. If we end up on Alpine for a smaller base, lameenc
   won't install — would need to fall back to piping through the already-
   installed `ffmpeg` binary. Stick with Debian-slim to avoid the
   complication.
3. **First-request warmup.** Both models benefit from a warm-up inference at
   startup (~2 s additional cold start, but spares the first real request
   from a latency spike). Recommend doing it; the operator-visible startup
   log already covers ~3 s of model loading, another 2 s is acceptable.
4. **CUDA version pinning.** `torch+cu121` wheels work against host drivers
   ≥ 530.30.02. Older host drivers will fail at first CUDA call with a
   non-obvious error. Document the minimum driver version in the addon
   README; consider runtime detection that downgrades to CPU rather than
   crashing.
5. **Pinning `kokoro-onnx`.** Upstream is a single-maintainer repo. Pin
   exactly `==0.4.9` (no `~=`). If the package is abandoned, the fallback is
   to inline the ~200 LOC inference code directly against `onnxruntime`,
   since the model file format is stable.
6. **AMD/ROCm.** Out of scope for v1. The `-cu121` variant is NVIDIA-only.
   ROCm would need a third image variant (`-rocm`) with `torch+rocm` and
   `onnxruntime-rocm`. Defer until requested.
