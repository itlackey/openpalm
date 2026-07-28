# System Requirements

Hardware, software, and network requirements for the current compose-first
OpenPalm stack.

---

## Software prerequisites

| Requirement | Minimum | Notes |
|---|---|---|
| Docker Engine or Docker Desktop | 24.0+ | Must include Compose V2 |
| Docker Compose | 2.20+ | Usually bundled with Docker |
| `git` | any | Needed if you clone the repo to copy `packages/skeleton/` |
| `curl` | any | Only needed for optional installer scripts |

### CPU architecture (`x86_64` hosts)

The `assistant` and `guardian` images bake only the modern (AVX2-era, roughly
2013+) glibc build of the OpenCode binary — the pre-AVX2 "baseline" and musl
variants are pruned from the image to save space, since this stack's base
images are glibc and target current-generation hardware. This only matters
for `x86_64`; `arm64` hosts (Apple Silicon, Raspberry Pi 4+, AWS Graviton)
are unaffected. If you're deploying to unusually old `x86_64` server
hardware, verify AVX2 support with `grep avx2 /proc/cpuinfo` on the Docker
host before installing.

### Supported operating systems

| OS | Runtime | Notes |
|---|---|---|
| Linux (`x86_64`, `arm64`) | Docker Engine | Best-supported path |
| macOS (Intel, Apple Silicon) | Docker Desktop or OrbStack | Uses a VM under the hood |
| Windows (`x86_64`) | Docker Desktop with WSL2 | WSL2 backend recommended |

---

## Hardware requirements

### Minimum

For the core compose stack using a remote LLM provider:

| Resource | Minimum |
|---|---|
| CPU | 2 cores, AVX2 or newer (any x86-64 CPU from ~2013 on; all arm64) |
| RAM | 4 GB |
| Disk | 4 GB free |

Disk depends on what you enable, so the figures below are per configuration
rather than one number. Image sizes are measured with `docker images` on
amd64; add roughly 1 GB of working room for OpenPalm's own state, logs and a
backup or two.

| Configuration | Images | Suggested free disk |
|---|---|---|
| Assistant only (default install) | 1.45 GB | 4 GB |
| Plus guardian and a portal (LAN, Discord/Slack, API) | 3.26 GB | 6 GB |
| Plus voice or a local model server | + model weights, 2–8 GB per model | 16 GB+ |

An upgrade needs very little extra headroom: releases change only the small
top layers of each image, so a new version shares almost all of its content
with the one it replaces. `openpalm doctor --clean-docker` reclaims superseded
images and any retired volumes.

A default install runs one always-on service:

- `assistant` (also runs the automation scheduler as a co-process)

`guardian` starts alongside it as soon as you enable any addon that accepts
outside traffic — chat, the API endpoint, Discord, Slack or the gateway — since
all of that traffic must pass through it.

Run `openpalm` to start the admin UI as a host process (no container required).

### Recommended

For the core stack plus admin, one or two addons, and local model usage:

| Resource | Recommended |
|---|---|
| CPU | 4+ cores |
| RAM | 16 GB |
| Disk | 16 GB+ free (model weights dominate — budget per model) |
| GPU | Optional but helpful for local models |

If you run Ollama or another local model server, model weights usually dominate
RAM and disk requirements.

---

## Typical resource profile

These are rough expectations, not hard limits:

| Service | Typical idle RAM | Notes |
|---|---|---|
| `assistant` | ~240 MB | OpenCode runtime + scheduler co-process |
| `guardian` | ~30 MB | Request verification and routing |
| Admin (host process) | minimal | SvelteKit UI/API served by `openpalm` |
| each portal addon | ~30-60 MB | Chat/API/voice/Discord/Slack edge |

---

## Disk layout

OpenPalm uses one host home directory: `~/.openpalm/`.

| Path | Purpose |
|---|---|
| `~/.openpalm/config/stack/` | Live compose files and enabled addon overlays |
| `~/.openpalm/knowledge/env/` | User-managed secret env files |
| `~/.openpalm/config/` | User-editable config |
| `~/.openpalm/data/` | Durable service data |
| `~/.openpalm/data/logs/` | Logs and audit files |

Approximate storage use:

| Category | Approximate size | Notes |
|---|---|---|
| Docker image: assistant | 1.45 GB | The only always-on image |
| Docker image: guardian | 1.42 GB | Only when a portal/LAN addon is enabled |
| Docker image: portal | 393 MB | Shared by the Discord and Slack adapters |
| `~/.openpalm/config/` + `~/.openpalm/knowledge/` | small | Usually measured in MB |
| `~/.openpalm/data/` | variable | Assistant homes, service data, logs, backups, and models can grow |
| local model weights | 2-8+ GB per model | If using Ollama or similar |

---

## Network requirements

### Outbound access

| Destination | When needed |
|---|---|
| LLM provider APIs | When using remote models |
| Docker Hub / GHCR | Pulling or updating images |
| `host.docker.internal` targets | When containers need host-run services |

### Default inbound ports

OpenPalm is localhost/LAN-first by default. Most services bind to `127.0.0.1`
unless you intentionally change bind addresses in `state/stack.env`.

| Host port | Service | Variable |
|---|---|---|
| `3800` | Assistant chat UI | `OP_UI_PORT` |
| `3810` | Assistant OpenCode | `OP_ASSISTANT_PORT` |
| `8880` | Voice addon | `OP_VOICE_PORT_HOST` |
| `3820` | Chat addon | `OP_CHAT_PORT` |
| `3821` | Guardian OpenAI API addon | `OP_API_PORT` |
| `3880` | Admin UI (host process) | `OP_HOST_UI_PORT` |

`guardian` exposes only localhost-bound direct/admin listeners by default.

---

## Operational note

The compose file set under `~/.openpalm/config/stack/` is the live deployment truth.
OpenPalm derives first-party addon profiles from `OP_ENABLED_ADDONS` in
`~/.openpalm/state/stack.env`, but Docker itself still only sees the
compose files and explicit `--profile` arguments.
