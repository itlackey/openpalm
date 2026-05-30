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

- `assistant` (also runs the automation scheduler as a co-process)
- `guardian`

Run `openpalm` to start the admin UI as a host process (no container required).

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
| `assistant` | ~240 MB | OpenCode runtime + scheduler co-process |
| `guardian` | ~30 MB | Request verification and routing |
| Admin (host process) | minimal | SvelteKit UI/API served by `openpalm` |
| each channel addon | ~30-60 MB | Chat/API/voice/Discord/Slack edge |

---

## Disk layout

OpenPalm uses one host home directory: `~/.openpalm/`.

| Path | Purpose |
|---|---|
| `~/.openpalm/config/stack/` | Live compose files and enabled addon overlays |
| `~/.openpalm/stash/vaults/` | User-managed secret env files |
| `~/.openpalm/config/` | User-editable config |
| `~/.openpalm/state/` | Durable service data |
| `~/.openpalm/cache/logs/` | Logs and audit files |

Approximate storage use:

| Category | Approximate size | Notes |
|---|---|---|
| Docker images (core) | ~2-3 GB | Depends on pulled tags |
| Docker images (per addon) | ~100-200 MB | Many share layers |
| `~/.openpalm/config/` + `~/.openpalm/stash/` | small | Usually measured in MB |
| `~/.openpalm/state/` | variable | Stash, workspace, and assistant data can grow |
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
unless you intentionally change bind addresses in `config/stack/stack.env`.

| Host port | Service | Variable |
|---|---|---|
| `3800` | Assistant | `OP_ASSISTANT_PORT` |
| `3810` | Voice addon | `OP_VOICE_PORT` |
| `3820` | Chat addon | `OP_CHAT_PORT` |
| `3821` | API addon | `OP_API_PORT` |
| `3880` | Admin UI/API addon | `OP_ADMIN_PORT` |
| `2222` | Assistant SSH (optional) | `OP_ASSISTANT_SSH_PORT` |

`guardian` stays internal to Docker networks by default.

---

## Operational note

The compose file set under `~/.openpalm/config/stack/` is the live deployment truth.
`~/.openpalm/config/stack.yml` is optional metadata for tooling and does not
change Docker's requirements on its own.
