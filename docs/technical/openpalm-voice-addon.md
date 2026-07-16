# OpenPalm Voice Addon — Design

> **DESIGN PROPOSAL — not the shipped implementation.**
> This document describes a proposed architecture that was not fully implemented
> as written. In particular, `data/registry/`, `enabled-addons.json`, and the
> `setAddonEnabled` flow referencing those paths do not exist in the current
> codebase. The shipped voice addon uses Compose profiles (`--profile addon.voice`)
> and `OP_ENABLED_ADDONS` in `knowledge/env/stack.env` instead of a registry catalog.
> Authoritative rules in [`core-principles.md`](./core-principles.md) take
> precedence over anything here.
>
> **2026-07 update:** the settings/enable flow described below (VoiceTab,
> `PUT /api/host/voice`, `writeVoiceVars`, `TTS_*`/`STT_*` stack.env vars) has
> been retired. See [`voice-settings-architecture.md`](./voice-settings-architecture.md)
> for the current split: the voice CONTAINER is a Capabilities addon
> (`POST /api/host/addons/voice`), and TTS/STT provider choice is a
> client-owned browser setting calling providers directly.

OpenPalm Voice is a bundled local-container addon that gives users one-click
TTS + STT without any external setup. The user clicks **"Enable OpenPalm Voice"**
in the Voice tab; the admin server enables an addon overlay, brings the
container(s) up, probes readiness, writes `TTS_BASE_URL` / `STT_BASE_URL` into
`stack.env`, and the existing voice browser app picks them up on its
next `GET /config/defaults` load. Nothing new is invented — the design composes
on top of the existing registry + addon + `writeVoiceVars` plumbing.

The audience for this doc is the implementer following the phased plan in §9.

---

## 1. Container options

Survey of CPU-friendly, OpenAI-compatible local TTS+STT servers. All sizes and
endpoints reflect upstream documentation at the time of writing
(2026-05-23). Image tags below are tracked through release notes; the
implementer should pin to a specific SHA-256 digest before merging.

### TTS candidates

| Image | Tag | Size | License | Endpoint | CPU? | RAM | Notes |
|---|---|---|---|---|---|---|---|
| `ghcr.io/remsky/kokoro-fastapi-cpu` | `v0.2.4` | ~1.1 GB compressed (~3 GB extracted; PyTorch+ONNX) | Apache-2.0 (server) / Apache-2.0 (Kokoro-82M weights) | `POST /v1/audio/speech` + `GET /health` | Yes (intended for CPU) | ~700 MB resident | Bundles Kokoro-82M weights inside the image. `gpu` variant exists; default is CPU. |
| `ghcr.io/rhasspy/wyoming-piper` | `1.5.0` | ~150 MB | MIT | Wyoming protocol — **not** OpenAI-compatible | Yes | ~80 MB | Smaller and faster than Kokoro but needs an OpenAI shim. Out of scope. |
| `lscr.io/linuxserver/openedai-speech` | `latest` (pinned via SHA) | ~2.4 GB | AGPL-3.0 | `POST /v1/audio/speech` | Yes | ~600 MB | Drop-in OpenAI shim that wraps Piper + Coqui. Larger image, but voice variety. |
| `localai/localai` | `latest-cpu` | ~3.8 GB | MIT | `POST /v1/audio/speech` and `POST /v1/audio/transcriptions` | Yes | ~1.2 GB resident | Single container does both. Bigger but consolidated. |

**Primary recommendation: `ghcr.io/remsky/kokoro-fastapi-cpu:v0.2.4`** — quality
is materially better than Piper, the image bundles weights (no first-run model
download), and the endpoint is already OpenAI-compatible. We accept the ~1 GB
image cost in exchange for "works out of the box with zero post-pull work."

### STT candidates

| Image | Tag | Size | License | Endpoint | CPU? | RAM | Notes |
|---|---|---|---|---|---|---|---|
| `fedirz/faster-whisper-server` | `latest-cpu` | ~750 MB | MIT | `POST /v1/audio/transcriptions` + `GET /health` | Yes (int8 quant) | ~400 MB resident for `Systran/faster-whisper-base.en` | Downloads model on first request to a HuggingFace cache volume. |
| `onerahmet/openai-whisper-asr-webservice` | `v1.7.1` | ~2.4 GB | MIT | `POST /asr` (NOT `/v1/audio/transcriptions`) | Yes | ~600 MB | Not OpenAI-compatible. Skip. |
| `ghcr.io/speaches-ai/speaches` | `latest-cpu` | ~900 MB | MIT | `POST /v1/audio/transcriptions` | Yes | ~500 MB | Rebrand/successor of faster-whisper-server. Same model loading semantics. |
| `localai/localai` | `latest-cpu` | (see above) | MIT | both endpoints | Yes | ~1.2 GB | Single-container choice if we prefer one service to two. |

**Primary recommendation: `fedirz/faster-whisper-server:latest-cpu`**, pinned
to its current digest. faster-whisper (int8 CTranslate2) is meaningfully
faster than whisper.cpp at comparable accuracy on CPU, and the server already
serves `/v1/audio/transcriptions`.

### Why not LocalAI as one box?

LocalAI is attractive (one container, one health check). Costs:
- 3.8 GB image — slow first pull on a typical home connection.
- ~1.2 GB resident even when idle.
- Config is YAML + per-model model-config files; less inspectable than the
  dedicated wrappers; adds a YAML to seed in `data/voice/`.
- We lose the ability to upgrade TTS independently of STT.

**Decision: two containers.** `voice-tts` (Kokoro-FastAPI) and `voice-stt`
(faster-whisper-server). Operational overhead is small (two healthchecks vs.
one), and each piece is replaceable.

---

## 2. Existing voice addon state

`/home/founder3/code/github/itlackey/openpalm/.openpalm/config/stack/portals.compose.yml`
already exists and is functional, but for a **different purpose** than this
proposal:

- `compose.yml` — Defines the `voice` service using the `openpalm/voice`
  image. It runs the built-in voice runtime/static interface stack,
  file host that serves the browser voice UI on `:3810` (`8186` inside the
  container). It does NOT do TTS or STT itself; it serves the HTML/JS that
  calls TTS/STT URLs from the browser.
- `.env.schema` — declares `STT_*` / `TTS_*` vars. These are written by
  `writeVoiceVars` and consumed by the voice runtime via
  `GET /config/defaults`.

**Conclusion: keep `voice/` exactly as-is.** It is the browser UI shell. The
new addon ships *alongside* it as `openpalm-voice/` and provides the local
TTS/STT containers that the browser UI ends up calling.

This separation matches the existing pattern: a user could enable `voice/`
(the UI) and point it at a *remote* OpenAI TTS endpoint without enabling
`openpalm-voice/`. Or enable both for fully-local voice. The two are
orthogonal addons.

---

## 3. Addon manifest design

### Directory layout

```
.openpalm/config/stack/portals.compose.yml
├── compose.yml
├── .env.schema
└── README.md
```

### `compose.yml`

Two services, both on `assistant_net` for guardian-side reachability AND
bound to a host loopback port so the **browser** (which is the actual
caller for TTS/STT) can reach them. The browser is on the host, not in
docker; using only `assistant_net` would make the URLs unreachable from
the browser. See §4 for the URL story.

```yaml
# Addon: voice — local CPU-friendly TTS + STT
# Serves OpenAI-compatible /v1/audio/speech (TTS) and
# /v1/audio/transcriptions (STT) on host loopback ports.
# The voice browser UI reads these URLs from /config/defaults.
services:
  voice-tts:
    image: ghcr.io/remsky/kokoro-fastapi-cpu:v0.2.4
    restart: unless-stopped
    user: "${OP_UID:-1000}:${OP_GID:-1000}"
    ports:
      - "${OP_VOICE_TTS_BIND_ADDRESS:-127.0.0.1}:${OP_VOICE_TTS_PORT:-8880}:8880"
    environment:
      # Kokoro-FastAPI honours these:
      KOKORO_DEFAULT_VOICE: "${OP_VOICE_TTS_DEFAULT_VOICE:-af_bella}"
    volumes:
      # Optional model cache for non-bundled voice packs (Kokoro core
      # voices are baked into the image; this is for user-added voices).
      - ${OP_HOME}/data/voice/tts-cache:/app/cache
    networks: [assistant_net]
    deploy:
      resources:
        limits:
          memory: 1500M
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:8880/health || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 60s
    labels:
      openpalm.name: OpenPalm Voice — TTS
      openpalm.description: Local Kokoro text-to-speech
      openpalm.icon: speaker
      openpalm.category: voice
      openpalm.healthcheck: http://voice-tts:8880/health

  voice-stt:
    image: fedirz/faster-whisper-server:latest-cpu
    restart: unless-stopped
    user: "${OP_UID:-1000}:${OP_GID:-1000}"
    ports:
      - "${OP_VOICE_STT_BIND_ADDRESS:-127.0.0.1}:${OP_VOICE_STT_PORT:-8881}:8000"
    environment:
      WHISPER__MODEL: "${OP_VOICE_STT_MODEL:-Systran/faster-whisper-base.en}"
      WHISPER__INFERENCE_DEVICE: cpu
      WHISPER__COMPUTE_TYPE: int8
      ENABLE_UI: "false"
    volumes:
      - ${OP_HOME}/data/voice/stt-cache:/root/.cache/huggingface
    networks: [assistant_net]
    deploy:
      resources:
        limits:
          memory: 1500M
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:8000/health || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 90s
    labels:
      openpalm.name: OpenPalm Voice — STT
      openpalm.description: Local faster-whisper speech-to-text
      openpalm.icon: mic
      openpalm.category: voice
      openpalm.healthcheck: http://voice-stt:8000/health
```

Notes:
- `start_period` is generous on STT because first-run model download (base.en
  ~145 MB) happens lazily on the first transcription request, but the server
  itself responds to `/health` immediately. We err on the side of slow.
- No `depends_on: guardian` because these aren't portals — they don't talk
  to the guardian, they're called by the browser.
- `data/voice/` host directory must be pre-created on enable (see §4) so
  Docker doesn't auto-create it as root.

### `.env.schema`

```
# Bind address for the local TTS server (default: 127.0.0.1, loopback-only).
OP_VOICE_TTS_BIND_ADDRESS=127.0.0.1

# Host port for TTS (default: 8880).
OP_VOICE_TTS_PORT=8880

# Default voice ID for Kokoro (one of af_bella, am_michael, etc.).
OP_VOICE_TTS_DEFAULT_VOICE=af_bella

# Bind address for the local STT server (default: 127.0.0.1, loopback-only).
OP_VOICE_STT_BIND_ADDRESS=127.0.0.1

# Host port for STT (default: 8881).
OP_VOICE_STT_PORT=8881

# faster-whisper model identifier (e.g. Systran/faster-whisper-base.en,
# Systran/faster-whisper-small).
OP_VOICE_STT_MODEL=Systran/faster-whisper-base.en
```

No `@sensitive` fields. No HMAC secret — this is not a portal.

---

## 4. Enable/disable flow

End-to-end on click of **"Enable OpenPalm Voice"** in the Voice tab:

```
[User clicks "Enable OpenPalm Voice"]
  → POST /admin/voice/openpalm-voice/enable (this proposal's endpoint shape;
    the shipped implementation uses a single PUT /api/host/voice instead — see
    the disclaimer at the top of this doc)
[Server runs in order]
  1. setAddonEnabled(homeDir, stackDir, "openpalm-voice", true)
     — records voice in config/stack/enabled-addons.json
     — mkdirs data/voice/{tts-cache,stt-cache} as OP_UID:OP_GID
  2. writeVoiceVars({
       tts: { enabled: true, engine: "openpalm-voice", provider: "kokoro",
              baseURL: "http://localhost:8880/v1", model: "kokoro",
              voice: "af_bella" },
       stt: { enabled: true, engine: "openpalm-voice",
              provider: "faster-whisper",
              baseURL: "http://localhost:8881/v1",
              model: "Systran/faster-whisper-base.en" },
     }, state.stackDir)
     — stack.env now has TTS_BASE_URL / STT_BASE_URL / TTS_ENGINE=openpalm-voice
  3. composeUp({ files, services: ["voice-tts", "voice-stt"], envFiles })
     — pulls images on first enable (logs streamed via existing endpoint)
  4. Return 202 Accepted with { ok: true, polling: "/admin/voice/probe" }
     (this proposal's polling path; shipped: GET /api/host/voice)
[UI starts polling]
  → GET /api/host/voice (every 2 s, max 90 s; shipped path — this proposal's
    doc originally named /admin/voice/probe)
[Containers go healthy]
  → probe returns { tts: 'ok', stt: 'ok' }
[VoiceTab UI flips to "Active"]
```

### Where does the URL come from?

`TTS_BASE_URL=http://localhost:8880/v1` (and `STT_BASE_URL=http://localhost:8881/v1`).

The browser calls these. The voice UI is served by the voice addon runtime,
which proxies the URLs into the browser through
`/config/defaults`. Inside the docker network the addresses would be
`http://voice-tts:8880` / `http://voice-stt:8000`, but those names are
opaque to the user's browser. Loopback works because both ports are
bound to `127.0.0.1` on the host and the browser is on the same host.

For the cross-machine case (user opens the admin UI from a *different*
device on the LAN) the addresses must point at the OpenPalm host's
LAN address, not `localhost`. This is the SAME problem the existing
remote-URL voice config already has; the server should resolve the URL
relative to the request `Host` header at write time, e.g.
`http://<host-as-seen-by-the-browser>:8880/v1`. Implementer note: read
`event.request.headers.get('host')` in the enable handler and substitute
the hostname portion.

### Mapping table vs. manifest fields

The mapping (`engine === "openpalm-voice"` →
`baseURL = http://<host>:8880/v1`, etc.) lives in `packages/lib/src/
control-plane/voice-presets.ts` (a small new file, ~30 LOC). The addon
manifest is generic infrastructure; the engine ↔ URL mapping is
voice-specific business logic and belongs in lib (single source of
truth — both wizard and admin reference it). This is the same pattern
used by the existing `TTS_ENGINES` / `STT_ENGINES` tables in
`packages/ui/src/lib/wizard/constants.ts` — keep that table but move
the OpenPalm Voice preset into lib so the wizard, the admin UI, and
the enable endpoint all use one constant.

### Disable

`POST /admin/voice/openpalm-voice/disable` (this proposal's endpoint shape;
shipped: `PUT /api/host/voice`):
1. `composeStop(["voice-tts", "voice-stt"], options)` — `performAddonToggle`
   already does this for us, so we reuse `POST /api/host/addons/voice`
   with `{ enabled: false }`.
2. **Do NOT clear `TTS_BASE_URL` / `STT_BASE_URL` from `stack.env`.** Leaving
   them lets re-enable be instant. If the user explicitly switches to a
   different engine in the Voice tab, `writeVoiceVars` overwrites them.

### Failure paths

| Failure | UI behavior |
|---|---|
| Image pull fails | enable endpoint returns 500 with stderr tail; UI shows "Could not pull image: <reason>" + Retry button |
| Port 8880/8881 in use | preflight detects via `lsof`/`ss` (extend existing port-collision helper); UI shows "Port 8880 in use; change in advanced settings" |
| Healthcheck never green within 90 s | UI shows "Container started but isn't responding" + a "Show logs" button hitting an existing logs endpoint |
| `data/voice/` not writable | enable endpoint returns 500 before compose up; UI shows fs error |

---

## 5. Verification + status

New endpoint:

```
GET /api/host/voice
→ 200 OK
  {
    "tts": "ok" | "starting" | "unreachable" | "misconfigured" | "disabled",
    "stt": "ok" | "starting" | "unreachable" | "misconfigured" | "disabled",
    "tts_url": "http://localhost:8880/v1",
    "stt_url": "http://localhost:8881/v1",
    "tts_model": "kokoro",
    "stt_model": "Systran/faster-whisper-base.en"
  }
```

**Logic per side:**
1. If addon `openpalm-voice` is not enabled → `"disabled"`.
2. Else read `TTS_BASE_URL` (resp. `STT_BASE_URL`) from `stack.env`.
   - If empty → `"misconfigured"`.
3. Else docker-compose-ps the service — if not running → `"starting"` for
   the first 90 s after enable, otherwise `"unreachable"`.
4. Else `fetch(url + '/health')` with a 1500 ms timeout.
   - 200 → `"ok"`.
   - Anything else → `"starting"` for the first 90 s, else `"unreachable"`.

Server-side caches the result for 1 s to avoid hammering the local
container when the UI polls.

**Polling cadence on the UI:**
- After enable click: every 2 s for the first 30 s, then every 5 s up to
  90 s, then stop polling and surface the last known state. The UI
  switches to single-shot probes on tab focus thereafter.

---

## 6. Defaults that work for most systems

### TTS — Kokoro-82M (bundled in image)

- **Model**: Kokoro-82M, voice `af_bella` (a popular female English voice).
  82M parameters; runs comfortably on CPU.
- **Weights live**: baked into `ghcr.io/remsky/kokoro-fastapi-cpu:v0.2.4`.
  No download. ~400 MB of model data inside the image.
- **Cold start**: ~5–10 s on a 2023 mid-range laptop (M2 Air, Intel i5
  12th gen). First synthesis adds another ~2 s of model warm-up.
- **Per-utterance latency**: ~200–500 ms for a sentence on M2 Air; ~600
  ms–1.2 s on i5 with no AVX-512.
- **Memory**: 500–800 MB resident when active, ~300 MB idle.

### STT — `Systran/faster-whisper-base.en` (downloaded on first use)

- **Model**: faster-whisper base.en (CTranslate2 int8). 74M parameters,
  English-only. ~145 MB on disk.
- **Weights live**: downloaded to `data/voice/stt-cache/` on first
  request. Persists across container recreates because of the bind
  mount.
- **First-run cost**: ~5–10 s download on a typical home connection.
- **Per-clip latency**: faster-whisper int8 base.en transcribes ~10×
  realtime on modern CPU — a 10 s clip in ~1 s. Older laptops: ~3×
  realtime.
- **Memory**: ~400 MB resident when loaded.

### Aggregate host requirements (defaults)

- Disk: ~4.5 GB (image + STT model cache).
- RAM peak both active: ~1.5 GB.
- RAM idle both running: ~700 MB.
- Cold-start to "ready for first request" on mid-range laptop: ~30–60 s
  (image pull dominates on first enable; ~10 s on subsequent enables).

Sources: Kokoro-FastAPI README perf table (commit `5f8c3a`); faster-whisper
benchmarks at `github.com/SYSTRAN/faster-whisper#benchmark`; Kokoro
HuggingFace card.

---

## 7. Stretch goals (deferred — spec the shape, do not implement)

### Model picker UI

Today the model identifier is set by `OP_VOICE_STT_MODEL` /
`OP_VOICE_TTS_DEFAULT_VOICE` in `stack.env`. A future UI would render
a dropdown of `tiny.en | base.en | small.en | medium.en | large-v3`
(for STT) and a Kokoro voice picker (for TTS), write to those env vars,
and force a `composeUp --force-recreate voice-tts voice-stt`. Each Whisper
size has its own RAM/quality tradeoff (`tiny.en` ~75 MB, `large-v3` ~3 GB);
the picker should display the cost.

### GPU detection + automatic config

The base addon is CPU-only. A future enhancement would:
1. Detect `nvidia-smi` (or `rocminfo`) at install time.
2. Choose between `ghcr.io/remsky/kokoro-fastapi-cpu` vs
   `ghcr.io/remsky/kokoro-fastapi-gpu` and the matching faster-whisper
   tag.
3. Add a compose `deploy.resources.reservations.devices: [...]` block
   conditionally.

### Variants mechanism

The cleanest shape is a per-addon `variants.yml`:

```yaml
# .openpalm/config/stack/portals.compose.yml
default: cpu
variants:
  cpu:
    description: CPU-only (works everywhere)
    overrides:
      voice-tts.image: ghcr.io/remsky/kokoro-fastapi-cpu:v0.2.4
      voice-stt.image: fedirz/faster-whisper-server:latest-cpu
  nvidia:
    description: NVIDIA GPU acceleration
    overrides: { ... }
```

The variant selector lives in the addon UI; switching variants regenerates
the compose overlay. Out of scope for v1; mentioned here so the v1 manifest
doesn't accidentally preclude it. The implementer should keep image refs
in the compose file (not behind extra env-var indirection) so that a future
`variants.yml` consumer can substitute them simply.

---

## 8. UX in the admin panel (VoiceTab)

The TTS and STT halves of the existing `VoiceTab.svelte` each render
`VoiceEngineSelector` over a fixed list of options. Add `openpalm-voice`
as a new option in both `TTS_OPTIONS` and `STT_OPTIONS`, marked
`recommended: true` and outranking `kokoro` (remote) at position 0.

### States to render under the selected `openpalm-voice` card

- **Not yet enabled**: a single inline panel:
  > **One-click local voice.** Click "Enable" to download Kokoro (TTS, ~1 GB)
  > and faster-whisper-base.en (STT, ~750 MB) and run them locally. ~1.5 GB
  > RAM, ~30 s first-time setup. No external API key required.
  >
  > `[ Enable OpenPalm Voice ]`
- **Pulling / starting** (after click, before probe returns `ok`):
  > `[spinner]` Setting up... downloading TTS image (1.1 GB)... starting
  > voice-tts... starting voice-stt... waiting for health checks (12 s
  > elapsed)
  >
  > `[ Cancel ]` (calls disable)
- **Active**:
  > **Active.** TTS: Kokoro (`af_bella`). STT: faster-whisper-base.en.
  >
  > `[ Restart ]` `[ Disable ]`
- **Reachable but unhealthy** (probe returns `unreachable` for >30 s on
  a previously-`ok` container):
  > **Container running but not responding.** This can happen if the model
  > failed to load. Check logs.
  >
  > `[ Restart ]` `[ View logs ]`

### Switching engines

When the user picks any other engine in either selector and saves, the
existing `writeVoiceVars` overwrites `TTS_*` / `STT_*` env vars.
**The local containers stay running.** Rationale: re-selecting
"OpenPalm Voice" is instant — no re-pull, no re-warm. The user can
explicitly stop the containers via the Disable button on the
OpenPalm Voice card (which calls the addon-disable endpoint).

### When OpenPalm Voice is selected for only one side (e.g., TTS only)

This is legitimate (use local TTS with browser STT, say). The enable
endpoint must support a `{ tts: true, stt: false }` flag to start
only one of the two services. Compose handles this naturally by
naming services explicitly in `composeUp({ services: [...] })`.

---

## 9. Implementation effort estimate

Phases are sequential. Sizes: S = ≤50 LOC, M = 50–150 LOC, L = 150–400 LOC.

| Phase | Size | LOC | Description | Depends on |
|---|---|---|---|---|
| A. Addon manifest | S | ~120 | New `data/registry/addons/voice/{compose.yml,.env.schema,README.md}`. Pin image digests. Add to registry tests. | — |
| B. Lib: voice presets | S | ~50 | New `packages/lib/src/control-plane/voice-presets.ts` with `OPENPALM_VOICE_PRESET` constant (engine name, default URLs, default models, default voice). Export from lib barrel. Used by the enable endpoint AND the wizard. | — |
| C. Server endpoints | M | ~250 | New `routes/admin/voice/openpalm-voice/+server.ts` (POST enable/disable wraps addon toggle + writeVoiceVars + composeUp). New `routes/admin/voice/probe/+server.ts`. Host-aware URL resolution. **As shipped:** both collapsed into the single `routes/api/host/voice/+server.ts`. | A, B |
| D. UI: VoiceTab integration | M | ~200 | Add `openpalm-voice` to `TTS_OPTIONS` / `STT_OPTIONS`. New `OpenPalmVoiceCard.svelte` rendering the 4 states from §8. Polling hook. | C |
| E. Tests | M | ~300 | Compose-overlay structural test (services, networks, healthchecks). probe endpoint unit tests with mock fetch. Playwright happy-path (enable → mocked probe `ok` → "Active" badge) under mocked Playwright. | A, C, D |
| F. Docs + wizard | S | ~80 | Mention OpenPalm Voice as recommended in the wizard Voice step. Update `registry.md` addon list. | A |

**Total: ~1000 LOC.** No new dependencies. No new container image builds —
both images are pulled from public registries.

Notes for the implementer:
- Pin digests, not tags. Image-pull determinism matters for "one-click".
- The probe endpoint must NOT block on `fetch` longer than ~1.5 s. Set
  `AbortSignal.timeout(1500)` explicitly.
- Reuse `performAddonToggle` and `setAddonEnabled` — don't create a parallel
  enable flow for this one addon. The only "extra" the new enable endpoint
  does is (a) write voice vars, (b) call `composeUp` (the generic toggle
  doesn't, by design), and (c) pre-create `data/voice/` directories.

---

## 10. Open questions

These need maintainer decisions before phase A starts.

1. **Image trust & supply chain.** `ghcr.io/remsky/kokoro-fastapi-cpu` is a
   third-party image, not first-party from OpenPalm. We could (a) pin a
   SHA-256 digest and accept upstream provenance, (b) mirror to
   `ghcr.io/itlackey/openpalm-voice-tts` with a periodic re-tag CI job, or
   (c) build our own minimal Kokoro server in `containers/voice-tts/` so the
   image is first-party. (a) is fastest; (c) costs an extra service to
   maintain. **Recommend (a) for v1**, revisit if the upstream is
   unmaintained.

2. **Default STT language.** `Systran/faster-whisper-base.en` is
   English-only. Multilingual users would need `Systran/faster-whisper-base`
   (~145 MB, slightly worse English accuracy). Do we ship English-only as
   the default and surface a "multilingual" toggle in the model picker,
   or default to multilingual at the cost of small English-accuracy
   regression? **Recommend English-only as the default**, multilingual via
   §7's stretch model picker. Most users are English-first; the size delta
   is the same so it's purely an accuracy/model-choice question.

3. **Cross-host browser case.** When the admin UI is opened from a different
   machine on the LAN, `TTS_BASE_URL=http://localhost:8880/v1` is wrong —
   "localhost" refers to the *browser's* machine. The enable endpoint needs
   to substitute the OpenPalm host's reachable hostname. Open question: is
   it acceptable to resolve this from the `Host` header at enable time
   (which then "freezes" the URL), or does the voice channel need to do
   host-aware substitution at `/config/defaults` time? **Recommend the
   latter** — the voice channel already serves `/config/defaults` per
   request, so it can substitute the inbound `Host` header into the URL
   on the fly. That keeps `stack.env` machine-independent. This requires a
    small change in the voice addon runtime.

---

## Compliance checklist (per `core-principles.md`)

- [x] **File-drop modularity.** Pure addon under `data/registry/addons/`. No code changes to `containers/`.
- [x] **No template rendering.** Compose substitution only; whole-file copy of overlay; no string interpolation of YAML.
- [x] **Guardian-only ingress.** N/A — this addon does not enter through the portal/guardian path. TTS/STT are tools called by the browser, not portals.
- [x] **Assistant isolation.** Assistant has no special access to these containers. They live on `assistant_net` so the assistant CAN call them too (future "speak this back" tool), but ingress is unchanged.
- [x] **LAN-first.** Both services bind to `127.0.0.1` by default.
- [x] **No new dependencies.** No new packages added to `package.json`. No new lock-file churn.
- [x] **Shared control-plane in `@openpalm/lib`.** The presets table and the URL-resolution logic live in lib; CLI and UI both import from there.
