# System Requirements

Hardware, software, and network requirements for the current compose-first
OpenPalm stack.

---

## Software prerequisites

| Requirement | Minimum | Notes |
|---|---|---|
| Docker Engine or Docker Desktop | 24.0+ | Must include Compose V2 |
| Docker Compose | 2.17+ | Required for `docker compose up --wait-timeout`; usually bundled with Docker |
| `git` | any | Only needed to clone the repo for development; not required to install OpenPalm — a raw copy of `packages/skeleton/` is not a working install (see [Setup Guide](setup-guide.md)) |
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

`guardian` starts alongside it as soon as anything needs it to accept outside
traffic — the API endpoint, Discord, Slack, the gateway, a guardian access
toggle, or a remote tunnel targeting it — since all of that traffic must pass
through it.

Bare `openpalm` ensures the stack is running and serves the normal non-admin host
UI. Use `openpalm admin` (or Electron) for the loopback-only admin-capable host
UI; neither mode requires an admin container.

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
| Host UI process | minimal | Same SvelteKit UI; admin capability only through Electron or `openpalm admin` |
| each portal adapter | ~30-60 MB | Discord or Slack edge |
| voice addon | model-dependent | Local TTS/STT; model and framework memory dominate |

---

## Disk layout

OpenPalm uses one host home directory: `~/.openpalm/`.

| Path | Purpose |
|---|---|
| `~/.openpalm/system/stack/` | Release-managed Compose files |
| `~/.openpalm/config/stack/custom.compose.yml` | User Compose overlay |
| `~/.openpalm/state/stack.env` | Non-secret pins and addon state |
| `~/.openpalm/knowledge/env/` | AKM user env loaded by scoped tools |
| `~/.openpalm/private/secrets/` | Delegated service credentials |
| `~/.openpalm/config/` | Other user-editable config |
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
| Docker Hub / GHCR | **Required** for every install and update |
| `host.docker.internal` targets | When containers need host-run services |

**Installing and updating require reachable container registries.** Both
operations pull images before starting anything, so they cannot complete on a
host with no route to Docker Hub / GHCR — even when the exact images are
already present in the local Docker daemon. A pull failure fails the operation
and rolls the configuration back; it does not silently fall back to cached
images. An already-installed stack keeps running offline (containers restart
under `unless-stopped`); it is only install and update that need the network.

Hosts that pull anonymously share Docker Hub's per-IP rate limit. If you hit
`toomanyrequests`, run `docker login` and retry.

### Default inbound ports

OpenPalm is localhost/LAN-first by default. Most services bind to `127.0.0.1`
unless you intentionally change bind addresses in `state/stack.env`.

| Host port | Service | Variable |
|---|---|---|
| `3800` | Assistant chat UI | `OP_UI_PORT` |
| `3810` | Assistant OpenCode | `OP_ASSISTANT_PORT` |
| `3830` | Guardian direct listener | `OP_GUARDIAN_PORT` |
| `3831` | Guardian principal admin (fixed loopback) | `OP_GUARDIAN_ADMIN_PORT` |
| `8880` | Voice addon | `OP_VOICE_PORT_HOST` |
| `3821` | Guardian compatible API | `OP_API_PORT` |
| `3880` | Host UI process; admin-capable only in Electron or `openpalm admin` | `OP_HOST_UI_PORT` |

`guardian` exposes only localhost-bound direct/admin listeners by default.

---

## Operational note

The managed Compose file set under `~/.openpalm/system/stack/`, plus the user
overlay under `~/.openpalm/config/stack/`, is the live deployment truth.
OpenPalm derives first-party addon profiles from `OP_ENABLED_ADDONS` in
`~/.openpalm/state/stack.env`, but Docker itself still only sees the
compose files and explicit `--profile` arguments.
