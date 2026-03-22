# System Requirements

Hardware, software, and network requirements for the current compose-first
OpenPalm stack.

---

## Software prerequisites

| Requirement | Minimum | Notes |
|---|---|---|
| Docker Engine or Docker Desktop | 24.0+ | Must include Compose V2 |
| Docker Compose | 2.20+ | Usually bundled with Docker |
| `git` | any | Needed if you clone the repo to copy `.openpalm/` |
| `curl` | any | Only needed for optional installer scripts |

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
| CPU | 2 cores |
| RAM | 4 GB |
| Disk | 10 GB free |

The core compose file includes these always-on services:

- `assistant`
- `memory`
- `guardian`
- `scheduler`

If you add the `admin` addon, you also run `admin` and `docker-socket-proxy`.

### Recommended

For the core stack plus admin, one or two addons, and local model usage:

| Resource | Recommended |
|---|---|
| CPU | 4+ cores |
| RAM | 16 GB |
| Disk | 25 GB+ free |
| GPU | Optional but helpful for local models |

If you run Ollama or another local model server, model weights usually dominate
RAM and disk requirements.

---

## Typical resource profile

These are rough expectations, not hard limits:

| Service | Typical idle RAM | Notes |
|---|---|---|
| `memory` | ~60 MB | Bun + sqlite-backed memory service |
| `assistant` | ~200 MB | OpenCode runtime |
| `guardian` | ~30 MB | Request verification and routing |
| `scheduler` | ~40 MB | Automation runner |
| `admin` addon | ~80 MB | SvelteKit admin UI/API |
| `docker-socket-proxy` addon | ~10 MB | Docker API filter |
| each channel addon | ~30-60 MB | Chat/API/voice/Discord/Slack edge |

---

## Disk layout

OpenPalm uses one host home directory: `~/.openpalm/`.

| Path | Purpose |
|---|---|
| `~/.openpalm/stack/` | Live compose files and helper scripts |
| `~/.openpalm/vault/` | Env files and schemas |
| `~/.openpalm/config/` | User-editable config |
| `~/.openpalm/data/` | Durable service data |
| `~/.openpalm/logs/` | Logs and audit files |

Approximate storage use:

| Category | Approximate size | Notes |
|---|---|---|
| Docker images (core) | ~2-3 GB | Depends on pulled tags |
| Docker images (per addon) | ~100-200 MB | Many share layers |
| `~/.openpalm/config/` + `vault/` | small | Usually measured in MB |
| `~/.openpalm/data/` | variable | Memory store and workspace can grow |
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
unless you intentionally change bind addresses in `vault/stack/stack.env`.

| Host port | Service | Variable |
|---|---|---|
| `3800` | Assistant | `OP_ASSISTANT_PORT` |
| `3810` | Voice addon | `OP_VOICE_PORT` |
| `3820` | Chat addon | `OP_CHAT_PORT` |
| `3821` | API addon | `OP_API_PORT` |
| `3880` | Admin UI/API addon | `OP_ADMIN_PORT` |
| `3881` | Admin-side OpenCode addon | `OP_ADMIN_OPENCODE_PORT` |
| `3897` | Scheduler API (optional host bind in current compose) | `OP_SCHEDULER_PORT` |
| `3898` | Memory API | `OP_MEMORY_PORT` |
| `2222` | Assistant SSH (optional) | `OP_ASSISTANT_SSH_PORT` |

`guardian` stays internal to Docker networks by default.

---

## Operational note

The compose file set under `~/.openpalm/stack/` is the live deployment truth.
`~/.openpalm/config/stack.yaml` is optional metadata for tooling and does not
change Docker's requirements on its own.
