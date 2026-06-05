# OpenPalm Local AI Unified Container Plan (revised)

> **Status:** forward-looking plan, revised 2026-06-05 to align with the current
> (0.11.0-rc.6) implementation and release processes.
>
> The original draft was directionally good but assumed conventions OpenPalm no
> longer uses (GitHub Container Registry, the `OP_CAP_*` env family, an `init`
> container, varlock `.env.schema` files, a `registry/addons/<name>/` layout).
> This revision keeps the strong ideas — a capability gateway, capability-not-
> runtime UX, prebuilt model images, hardware profiles, out-of-band CI — and
> re-expresses every concrete detail in OpenPalm's actual idioms. **Most of the
> "advanced Docker build" recommendations are already proven in production by
> `openpalm/voice` + `openpalm/voice-models:v1` and the `publish-voice*.yml`
> workflows; this plan generalizes that pattern to a unified Local AI image.**

---

## 0. What already exists (don't re-invent it)

OpenPalm already ships a local, OpenAI-compatible **voice** runtime that is, in
effect, Phase 0 of this plan and the template for everything below:

- **`openpalm/voice`** (`core/voice/`) — Kokoro TTS + faster-whisper STT behind a
  FastAPI app, OpenAI-compatible (`/v1/audio/speech`, `/v1/audio/transcriptions`),
  multi-variant (`cpu`, `cu121`, `rocm6`).
- **`openpalm/voice-models:v1`** (`core/voice/Dockerfile.models`) — a prebuilt
  **model bundle** image (Kokoro + Whisper, `scratch` final) the runtime
  `COPY --from`s, so the heavy model download happens **once per model bump**, not
  per hardware build. Pinned in `core/voice/Dockerfile` via
  `FROM --platform=$BUILDPLATFORM openpalm/voice-models:v1 AS modelfetch`.
- **Out-of-band CI** — `publish-voice.yml` (images) and `publish-voice-models.yml`
  (the bundle) publish on their own cadence; they are **removed from the platform
  `release.yml`** so a platform release never blocks on the ~slow GPU build.
- **Decoupled image tags** — `openpalm/voice:${OP_VOICE_IMAGE_TAG:-latest-<variant>}`;
  `voiceImageRef()` in `registry.ts` defaults to the moving `latest-<variant>` tag,
  independent of the platform `OP_IMAGE_TAG`.

Local AI should be built **on this proven foundation**, reusing the model-bundle
image pattern, the out-of-band workflows, the `$BUILDPLATFORM` model stage, the
optional `HF_TOKEN` secret, and the `OP_*_IMAGE_TAG` / `OP_*_PROFILE` conventions.
The unified gateway adds **agent + embeddings + Intel + hardware detection** and a
single capability API on top.

---

## 1. Goals (unchanged in spirit)

- Seamless local AI for non-technical users; capability toggles, not runtimes.
- Local **voice** (STT + TTS), local **embeddings**, optional local **agent** model.
- **Intel** as a first-class hardware target alongside CPU / NVIDIA / AMD.
- One stable gateway API; runtime/model complexity hidden by default, fully
  overridable for advanced users.
- Docker build practices that minimize repeated model downloads and maximize CI
  caching — **already the standard for `openpalm/voice`**.

### Non-goals
- Don't replace the existing **Ollama** addon (advanced local LLM provider).
- Don't expose runtime/quantization/engine choices in the default wizard.
- **One image per hardware class, and that single image provides *every*
  capability** (voice + embeddings + agent baked in). The capability toggles
  (`OP_LOCAL_AI_ENABLE_*`) control only which runtimes *start* — never what the
  image contains — so a user installs exactly one image for their hardware and
  flips capabilities on/off. (The only thing we don't build is one *universal*
  image spanning all hardware classes — CPU/Intel/CUDA/ROCm stay separate, like
  voice's `cpu`/`cu121`/`rocm6`.)
- Don't require runtime model downloads on the default path.

---

## 2. Product model (capabilities, not runtimes)

Wizard exposes capabilities; the runtime is hidden:

```
Local AI
  [ ] Enable local voice        — STT + TTS on this device
  [ ] Enable local embeddings   — memory / search / retrieval on this device
  [ ] Enable local agent model  — small private/offline model (prompted by hardware)

Hardware acceleration: Auto (recommended) · CPU only · Intel GPU · NVIDIA GPU · AMD GPU
```

Default: voice + embeddings local, agent optional, hardware auto, models =
"OpenPalm recommended", runtime hidden. Advanced details reveal runtime, model
IDs, custom OpenAI-compatible endpoints, manual profile, slim images, and runtime
downloads.

---

## 3. Addon structure — **Compose profiles, not a `registry/addons/` dir**

OpenPalm no longer uses `.openpalm/registry/addons/<name>/compose.*.yml` +
`.env.schema`. First-party optional services live in
**`.openpalm/config/stack/services.compose.yml`**, gated by **Compose profiles**
(this is exactly how `voice` and `ollama` are defined today, e.g.
`addon.voice.cpu` / `addon.ollama.cuda`). varlock and `.env.schema` are gone (#391).

Add Local AI as profiled services in `services.compose.yml`:

```
addon.local-ai.cpu
addon.local-ai.intel
addon.local-ai.cuda     # NVIDIA (matches the existing cuda profile naming)
addon.local-ai.rocm     # AMD
```

The active profile is selected by an **`OP_LOCAL_AI_PROFILE`** env var
(e.g. `OP_LOCAL_AI_PROFILE=addon.local-ai.intel`), mirroring the existing
`OP_VOICE_PROFILE` / `OP_OLLAMA_PROFILE` resolution in
`packages/lib/src/control-plane/registry.ts`. The **Ollama** profiles
(`addon.ollama.*`) stay untouched as the advanced LLM provider.

> Positioning: `local-ai` = recommended default for voice/embeddings/agent;
> `ollama` = advanced LLM provider. Both surface as OpenAI-compatible providers.

---

## 4. Runtime architecture — gateway

One stable internal API (unchanged from the original, good):

```
GET  /health · GET /capabilities · GET /models
POST /v1/chat/completions · /v1/embeddings · /v1/audio/transcriptions · /v1/audio/speech
```

```
local-ai-gateway
  ├─ agent runtime · embedding runtime · STT runtime · TTS runtime
```

OpenPalm talks **only** to the gateway (`http://local-ai:4114/v1`), never to
internal runtimes. The gateway owns routing, model aliasing, health aggregation,
embedding-dimension reporting, hardware/fallback reporting, OpenAI-compatible
normalization, and friendly errors.

> Single-image design: STT + TTS + embeddings (+ optional agent) are **all baked
> into the one `openpalm/local-ai:<hardware>` image** and run inside it — there is
> no separate voice/embedding/agent container. The existing `openpalm/voice`
> work is reused as **source** (its Kokoro/Whisper Dockerfile stages and the
> `voice-models` bundle pattern fold into this image's build), not run as a
> separate service. The standalone `openpalm/voice` addon can remain as a lighter
> voice-only option, but Local AI supersedes it for the recommended all-in-one
> path.

---

## 5–6. Capability endpoints & runtime matrix

Unchanged from the original (they were sound): `agent.default`, `embedding.default`,
`stt.default`, `tts.default` aliases; CPU baseline → Intel (OpenVINO/SYCL) → NVIDIA
(CUDA) → AMD (ROCm), each with CPU fallback. The stable contract is the gateway API
+ aliases; concrete runtimes can evolve.

---

## 7. Image naming — **Docker Hub `openpalm/*`, not ghcr.io**

OpenPalm publishes to **Docker Hub** under the `openpalm` namespace (overridable
via `OP_IMAGE_NAMESPACE`), using the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`
secrets. There is no `ghcr.io/itlackey/...`.

Mirror the **voice tag scheme** exactly:

```
# moving (the stack default)
openpalm/local-ai:latest-cpu      openpalm/local-ai:latest-intel
openpalm/local-ai:latest-cuda     openpalm/local-ai:latest-rocm

# immutable pin (published when a version is supplied)
openpalm/local-ai:v0.11.0-cpu     openpalm/local-ai:v0.11.0-intel   ...
```

(Profile names `addon.local-ai.<variant>` map to image suffix `<variant>`, same as
voice maps `addon.voice.cuda` → image suffix `cu121`. Pick clean suffixes
`cpu/intel/cuda/rocm`.) **No `slim` / `with-models` split** — the model bundle is a
separate image (§8), so every runtime image already carries baked defaults via
`COPY --from`, exactly like voice. (`OP_LOCAL_AI_ALLOW_MODEL_DOWNLOADS` covers the
rare runtime-download case.)

### Image-ref resolution (mirror `voiceImageRef`)

Add `localAiImageRef(variant)` in `registry.ts`, identical in shape to
`voiceImageRef`:

```
${OP_IMAGE_NAMESPACE:-openpalm}/local-ai:${OP_LOCAL_AI_IMAGE_TAG:-latest-<variant>}
```

i.e. an explicit `OP_LOCAL_AI_IMAGE_TAG` override, otherwise the **moving
`latest-<variant>`** tag — **decoupled from the platform `OP_IMAGE_TAG`**, because
Local AI publishes out-of-band (§10).

---

## 8. Model image strategy — **already proven by `openpalm/voice-models:v1`**

Generalize the voice bundle to a Local AI bundle:

```
openpalm/local-ai-models:<tag>     # e.g. v1, all-defaults
```

Build it exactly like `core/voice/Dockerfile.models`:

- `FROM python:3.11-slim … AS fetch` → download Kokoro/Whisper/agent/embedding
  defaults, then **`FROM scratch`** with just the data → tiny, pull-only image.
- **`$BUILDPLATFORM`-pinned** so the platform-agnostic data isn't re-fetched under
  QEMU for arm64 (the lesson from voice's Level-1 fix).
- **Optional `hf_token` BuildKit secret** + retry/backoff on HuggingFace 429s (the
  lesson from voice-models: anonymous HF rate-limits by IP).
- A `manifest.json` (model, path, sha256, dims, runtime hints) for the gateway.

Runtime Dockerfile consumes it like voice does:

```dockerfile
ARG VOICE_MODELS_IMAGE  # for parity; here: LOCAL_AI_MODELS_IMAGE
ARG LOCAL_AI_MODELS_IMAGE=openpalm/local-ai-models:v1
FROM --platform=$BUILDPLATFORM ${LOCAL_AI_MODELS_IMAGE} AS modelfetch
...
COPY --from=modelfetch /models /opt/openpalm/models
```

**Bumping models** (same runbook as voice): edit `Dockerfile.models` → publish a
new `local-ai-models` tag via `publish-local-ai-models.yml` → bump the
`LOCAL_AI_MODELS_IMAGE` default in the runtime Dockerfile → publish images.

---

## 9. Dockerfile organization

Single multi-target Dockerfile with BuildKit cache mounts (the original §9 skeleton
is fine after two corrections): use **`COPY --from=modelfetch`** off the pinned
models image (not a hard-coded `ghcr.io` ref), and there is **no `init`
dependency** — first-boot dir creation + ownership happens in the entrypoint.

```dockerfile
# syntax=docker/dockerfile:1.7
ARG LOCAL_AI_MODELS_IMAGE=openpalm/local-ai-models:v1
FROM --platform=$BUILDPLATFORM ${LOCAL_AI_MODELS_IMAGE} AS modelfetch
# os-base / python-base / gateway-builder with apt+pip cache mounts (as drafted)
FROM python-base AS runtime-common
COPY --from=modelfetch /models /opt/openpalm/models
# entrypoint mkdir -p + chown of CONTAINER-PRIVATE paths only (see §17)
FROM runtime-common AS runtime-cpu    # ENV OP_LOCAL_AI_PROFILE handled at compose level
FROM runtime-common AS runtime-intel
FROM runtime-common AS runtime-cuda
FROM runtime-common AS runtime-rocm
```

Build-practice requirements (strict `.dockerignore`, slow-deps-before-source, apt/pip
cache mounts, named targets, registry/gha cache, models in a dedicated image,
one-image-per-hardware) are all retained — they already describe how voice builds.

---

## 10. CI/CD — **out-of-band workflows mirroring `publish-voice*.yml`**

**Do not add Local AI to the platform `release.yml`.** Heavy GPU/model builds must
stay off the critical release path (the explicit reason voice was moved out, and
why platform releases now take minutes). Add two **standalone, dispatchable**
workflows, registered on `main`:

- **`publish-local-ai-models.yml`** — builds `openpalm/local-ai-models:<tag>`
  (single-arch amd64, `scratch`), `secrets: hf_token=${{ secrets.HF_TOKEN }}`,
  `cache-{from,to} type=gha,scope=openpalm/local-ai-models`. Run on model bumps.
- **`publish-local-ai.yml`** — per-variant matrix (`cpu` amd64+arm64; `cuda`/`rocm`
  amd64-only like voice's cu121; `intel` per device support), `docker/build-push-action@v6`,
  `cache-{from,to} type=gha,scope=openpalm/local-ai-<variant>`, builds
  `FROM …/local-ai-models:<pin>`, pushes moving `latest-<variant>` always + a pinned
  `v<version>-<variant>` when a `version` input is supplied, `fail-fast: false`.

Concrete deltas from the original §10:
- `docker/build-push-action@v6` (the repo's version), **not** `@v7`.
- **gha cache** (`type=gha,scope=…`), the repo's standard — **not** `type=registry`
  cache refs. (`mode=max` is fine.)
- **Docker Hub** login (`docker/login-action@v3` + `DOCKERHUB_*`), **not** ghcr.
- `docker-bake.hcl` is optional/nice — the established pattern is a
  `build-push-action` matrix, so lead with that.
- Add a **CI version-sync check** for `OPENCODE_VERSION`/`BUN_VERSION`/`CUDA`
  toolkit args across the local-ai Dockerfiles, mirroring the existing
  `AKM_CLI_VERSION` lockstep check.

Both workflows must exist on the **default branch (`main`)** to be
`workflow_dispatch`-able (a hard GitHub requirement we hit repeatedly).

---

## 11. Compose service (aligned to `services.compose.yml` idioms)

```yaml
# in .openpalm/config/stack/services.compose.yml
services:
  local-ai:
    profiles: ["addon.local-ai.cpu"]            # + intel/cuda/rocm variants
    image: ${OP_IMAGE_NAMESPACE:-openpalm}/local-ai:${OP_LOCAL_AI_IMAGE_TAG:-latest-cpu}
    restart: unless-stopped
    user: "${OP_UID:-1000}:${OP_GID:-1000}"
    environment:
      OP_LOCAL_AI_PORT: "4114"
      OP_LOCAL_AI_ENABLE_VOICE: "${OP_LOCAL_AI_ENABLE_VOICE:-true}"
      OP_LOCAL_AI_ENABLE_AGENT: "${OP_LOCAL_AI_ENABLE_AGENT:-false}"
      OP_LOCAL_AI_ENABLE_EMBEDDINGS: "${OP_LOCAL_AI_ENABLE_EMBEDDINGS:-true}"
      OP_LOCAL_AI_HARDWARE: "${OP_LOCAL_AI_HARDWARE:-auto}"
      OP_STT_MODEL: "${OP_STT_MODEL:-stt.default}"
      OP_TTS_MODEL: "${OP_TTS_MODEL:-tts.default}"
      OP_AGENT_MODEL: "${OP_AGENT_MODEL:-agent.default}"
      OP_EMBEDDING_MODEL: "${OP_EMBEDDING_MODEL:-embedding.default}"
    ports:
      # loopback default; one host port for the host UI server's /api/speak +
      # /api/transcribe proxy, same as voice's OP_VOICE_BIND_ADDRESS/PORT_HOST.
      - "${OP_LOCAL_AI_BIND_ADDRESS:-127.0.0.1}:${OP_LOCAL_AI_PORT_HOST:-4114}:4114"
    volumes:
      - ${OP_HOME}/data/local-ai:/data        # data/<service>/ pattern (cf. data/voice/models)
    networks: [assistant_net]                  # in-network for the assistant; voice uses the same
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:4114/health || exit 1"]
      interval: 15s
      timeout: 10s
      retries: 5
      start_period: 45s
    labels:
      openpalm.name: Local AI
      openpalm.description: Local voice, embeddings, and agent model runtime (OpenAI-compatible)
      openpalm.icon: cpu
      openpalm.category: ai
      openpalm.healthcheck: http://local-ai:4114/health
```

Per-variant overlays add only the hardware bits (Intel `/dev/dri`; NVIDIA
`deploy.resources…devices:[gpu]` + `runtime: nvidia` CDI fallback as voice's CUDA
profile does; AMD `/dev/kfd`+`/dev/dri`+`group_add`). Corrections vs the original:
- **No `depends_on: init`** — the `init` container was removed (#396); first-boot
  dirs/ownership are handled in the entrypoint.
- **`OP_LOCAL_AI_BIND_ADDRESS` / `OP_LOCAL_AI_PORT_HOST`** (loopback default) match
  the voice naming. When the global **`OP_BIND_ADDRESS`** (#395) lands, Local AI
  consumes it like every other service.

---

## 12. Hardware detection & profile selection

Keep the original detection logic (Intel `/dev/dri`+lspci, NVIDIA `nvidia-smi`+`--gpus`
smoke, AMD `/dev/kfd`, CPU fallback; Intel-priority). Wire it into the existing
**setup wizard hardware/profile step** (the same place that already picks
`OP_VOICE_PROFILE` and `OP_OLLAMA_PROFILE`). Persist:

```env
# knowledge/env/stack.env (non-secret stack config)
OP_LOCAL_AI_ENABLED=true
OP_LOCAL_AI_ENABLE_VOICE=true
OP_LOCAL_AI_ENABLE_AGENT=false
OP_LOCAL_AI_ENABLE_EMBEDDINGS=true
OP_LOCAL_AI_HARDWARE=intel
OP_LOCAL_AI_PROFILE=addon.local-ai.intel
OP_LOCAL_AI_IMAGE_TAG=latest-intel
```

(`OP_LOCAL_AI_PROFILE` is the compose-profile selector — the actual mechanism — and
replaces the original's bare `OP_LOCAL_AI_HARDWARE` driving overlays.)

---

## 13. Capability wiring — **no `OP_CAP_*`** (that family was deleted, #393)

This is the biggest correction. The original `OP_CAP_*_PROVIDER/_BASE_URL/_MODEL`
env block does not exist in OpenPalm anymore. Each consumer is wired through its
**real** mechanism:

- **Voice (STT/TTS) → the UI voice routes.** `/api/speak` + `/api/transcribe` read
  `OP_TTS_BASE_URL` / `OP_STT_BASE_URL` (+ `OP_TTS_MODEL` / `OP_TTS_VOICE` /
  `OP_STT_MODEL`, `OP_TTS_ENGINE` / `OP_STT_ENGINE`) from `stack.env`. Point them at
  the gateway:
  ```env
  OP_TTS_BASE_URL=http://127.0.0.1:${OP_LOCAL_AI_PORT_HOST:-4114}/v1   # host UI proxy
  OP_STT_BASE_URL=http://127.0.0.1:${OP_LOCAL_AI_PORT_HOST:-4114}/v1
  OP_TTS_MODEL=tts.default   # OP_STT_MODEL=stt.default ; OP_TTS_VOICE=…
  ```
  (Exactly how the existing `openpalm/voice` addon is wired — Local AI just becomes
  the target.)
- **Embeddings (akm memory/retrieval) → `config/akm/config.json`.** Write the akm
  0.8.0 canonical shape (`profiles.embedding.default` + `defaults.embedding`) with
  the gateway's OpenAI-compatible base URL + **dims**, the same way `setup.ts`
  already writes `profiles.llm.default` + `defaults.llm`. Dimensions are
  load-bearing for the vector index (§16).
- **Agent LLM (the assistant's OpenCode) → an OpenPalm Connection / OpenCode
  provider**, not an env var. Register an `openai-compatible` connection whose base
  URL is the gateway (`http://local-ai:4114/v1`), via the existing connections +
  `auth.json` flow. If akm itself should use the local agent (for `akm improve`),
  also set `profiles.llm.default` in `config/akm/config.json`.

> Still expose **only** the gateway URL to the rest of the stack — never internal
> runtime URLs (`kokoro:8880`, `whisper:8080`, …). That principle is unchanged.

---

## 14–18. Gateway startup, model defaults, embeddings metadata, supervision, file layout

Keep the original sections; two alignment notes:

- **§17 supervision / first-boot (corrects the `init` removal):** `tini` as PID 1 +
  an entrypoint that, before starting runtimes, `mkdir -p`s and `chown`s **only
  container-private paths** (`/data/cache`, `/data/logs`, …) — **never** a
  bind-mounted host stash/model dir (the `akm-chown-clobbers-host-stash-on-boot`
  lesson). Resolution order stays `/data override → /opt baked default → download
  only if explicitly allowed`.
- **§16 embeddings:** the dimension-mismatch guardrail is critical and aligns with
  OpenPalm's existing constraint that `embedding_model_dims` must match the model
  (nomic-embed-text = 768). The gateway reports dims in `/health` + `/models`, and
  refuses silent dimension changes against an existing index.

---

## 19. Image size policy — **drop the `slim`/`with-models` matrix**

The model bundle is a separate image (§8) that every runtime `COPY --from`s, so the
voice precedent is: **one `latest-<variant>` (+ pinned `v<version>-<variant>`) per
hardware class, models baked in.** No `-slim` / `-with-models` variants to maintain
(that doubles the matrix for little value). The rare slim/runtime-download case is
covered by `OP_LOCAL_AI_ALLOW_MODEL_DOWNLOADS=true` + a mounted `/data/models`.

---

## 20. CI smoke tests

Keep the original test list (start, `/health` 200, `/capabilities`, `/models`
aliases, embeddings dims, STT/TTS round-trip, agent if enabled, manifest hashes,
non-root `/data` write, stdout logs). Run them in `publish-local-ai.yml` **before
push** (a gate), mirroring the structure of the existing channel/UI publish gates.
Embedding-dimension tests are required on every variant.

---

## 21–23. Wizard flow, advanced overrides, migration

Mostly unchanged. Corrections:
- Advanced override env names stay `OP_LOCAL_AI_RUNTIME_*`, `OP_*_MODEL_PATH`,
  `OP_LOCAL_AI_ALLOW_MODEL_DOWNLOADS` (already `OP_`-prefixed — good; OpenPalm
  mandates the `OP_` prefix so stray shell vars can't leak in).
- The "use Ollama for LLM, Local AI for voice/embeddings" advanced combo is
  expressed via **a Connection (LLM) + `OP_TTS/STT_BASE_URL` (voice) +
  `config/akm/config.json` (embeddings)** — not `OP_CAP_*`.
- Admin UI provider list (Recommended: Local AI · Advanced: Ollama / LM Studio /
  Docker Model Runner / custom OpenAI-compatible) is correct and matches the
  current provider model.

---

## 24. Implementation phases (re-sequenced to leverage what's built)

- **Phase 0 — DONE:** `openpalm/voice` + `openpalm/voice-models:v1` + out-of-band
  `publish-voice*.yml`. This is the proven model-image + decoupled-build pattern.
- **Phase 1 — Local AI single image (CPU): voice + embeddings baked in.** Build the
  one `local-ai:latest-cpu` image with the gateway **plus** the Kokoro/Whisper
  runtimes (folded in from `core/voice`) **and** an embedding runtime, all in the
  one container; `local-ai-models:v1` carries every default model. Wire embeddings
  to `config/akm/config.json` and voice to `OP_TTS/STT_BASE_URL` (pointing at the
  gateway). Ship `publish-local-ai.yml` + `publish-local-ai-models.yml`. No
  separate voice/embedding container.
- **Phase 2 — Intel first-class.** `local-ai:intel`, `/dev/dri` overlay, OpenVINO/
  SYCL paths with CPU fallback, wizard detection + fallback display.
- **Phase 3 — Local agent model.** `/v1/chat/completions`, `agent.default`,
  register the gateway as an OpenCode connection.
- **Phase 4 — NVIDIA + AMD profiles** (mirror voice's cuda/rocm build + device
  overlays).
- **Phase 5 — Advanced customization** (custom model paths, dimension guardrails,
  runtime selection, runtime downloader, admin diagnostics, index migration).

---

## 25. The one design decision that matters (unchanged)

> **Local AI is a capability gateway, not a model-runtime brand.**

This revision keeps that abstraction and re-grounds every concrete detail —
**Docker Hub `openpalm/*` images, a prebuilt `local-ai-models` bundle, out-of-band
`publish-local-ai*.yml` workflows, `OP_LOCAL_AI_*`/profile/image-tag conventions,
akm-config + `OP_TTS/STT_BASE_URL` + Connections wiring (no `OP_CAP_*`), and
entrypoint-based first-boot (no `init` container)** — so it drops cleanly into the
0.11.x architecture and reuses the build/release machinery already shipped for
voice.
