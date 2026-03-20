# System Requirements

Hardware, software, and network requirements for running OpenPalm.

---

## Software Prerequisites

| Requirement | Minimum Version | Notes |
|---|---|---|
| Docker Engine or Docker Desktop | 24.0+ | Must include Compose V2 (`docker compose`) |
| Docker Compose | V2 (2.20+) | Bundled with Docker Desktop and modern Docker Engine |
| curl | any | Used by the installer script |
| openssl | any | Used by the installer to generate admin tokens |

### Supported Operating Systems

| OS | Runtime | Notes |
|---|---|---|
| **Linux** (x86_64, arm64) | Docker Engine | Recommended. Native performance, no VM overhead |
| **macOS** (Apple Silicon or Intel) | Docker Desktop or OrbStack | OrbStack offers lower resource overhead |
| **Windows** (x86_64) | Docker Desktop with WSL2 | WSL2 backend required; Hyper-V backend is not supported |

---

## Hardware Requirements

### Minimum (core stack only, no channels)

The core stack runs 6 containers: caddy, memory, assistant, guardian, docker-socket-proxy, and admin.

| Resource | Minimum |
|---|---|
| CPU | 2 cores |
| RAM | 4 GB |
| Disk | 10 GB free (Docker images + runtime data) |

This assumes you are using a **remote LLM provider** (OpenAI, Anthropic, etc.) and not running local models.

### Recommended (core + 1-2 channels + Ollama)

Running local models via Ollama significantly increases resource needs because models must be loaded into RAM (or VRAM).

| Resource | Recommended |
|---|---|
| CPU | 4+ cores |
| RAM | 16 GB (8 GB for stack + 8 GB for Ollama models) |
| Disk | 25 GB+ free (images + model weights) |
| GPU | Optional but beneficial — any CUDA-capable NVIDIA GPU or Apple Silicon with Metal |

For larger models (13B+ parameters), 32 GB RAM or a GPU with 8+ GB VRAM is recommended.

---

## Per-Service Resource Profile

The core compose file (`assets/docker-compose.yml`) does not currently define `deploy.resources.limits`, so containers are unconstrained by default. The table below shows typical observed usage under light workloads.

| Service | Base Image | Runtime | Typical Idle RAM | Typical Active RAM | Purpose |
|---|---|---|---|---|---|
| **caddy** | `caddy:2-alpine` | Go binary | ~15 MB | ~30 MB | Reverse proxy, TLS termination |
| **memory** | `oven/bun:1-debian` | Bun + sqlite-vec | ~60 MB | ~150 MB | Vector memory store (embeddings + search) |
| **assistant** | `node:lts-trixie` | Node.js + OpenCode + Bun | ~200 MB | ~500 MB | AI runtime, tool execution, SSH server |
| **guardian** | `oven/bun:1.3-slim` | Bun | ~30 MB | ~60 MB | HMAC verification, rate limiting |
| **docker-socket-proxy** | `tecnativa/docker-socket-proxy` | HAProxy | ~10 MB | ~15 MB | Filtered Docker API proxy |
| **admin** | `node:lts-trixie-slim` | Node.js (SvelteKit) + Bun | ~80 MB | ~150 MB | Control plane, operator UI |
| **channel** (each) | `oven/bun:1.3-slim` | Bun | ~30 MB | ~60 MB | Protocol adapter (chat, API, Discord, etc.) |

**Total core stack (idle):** ~400 MB RAM
**Total core stack (active):** ~900 MB RAM
**Each added channel:** ~30-60 MB RAM

---

## Disk Space Breakdown

| Category | Approximate Size | Notes |
|---|---|---|
| Docker images (core stack) | ~2-3 GB | 6 images; `node:lts-trixie` (assistant) is the largest at ~1 GB |
| Docker images (per channel) | ~100-200 MB | Shares the `oven/bun:1.3-slim` base layer with guardian |
| Config directory (`CONFIG_HOME`) | < 10 MB | User-editable YAML, secrets, channel configs |
| State directory (`STATE_HOME`) | < 50 MB | Generated compose files, Caddyfile, audit logs |
| Data directory (`DATA_HOME`) | Varies | Memory database grows with usage; starts < 1 MB |
| Ollama models (if local) | 2-8 GB per model | `qwen2.5-coder:3b` ~ 2 GB, `nomic-embed-text` ~ 270 MB |

### XDG Directory Locations

| Tier | Default Path | Purpose |
|---|---|---|
| `CONFIG_HOME` | `~/.config/openpalm` | User-owned config (channels, secrets, assistant config) |
| `DATA_HOME` | `~/.local/share/openpalm` | Service data (memory DB, Caddy certs, assistant state) |
| `STATE_HOME` | `~/.local/state/openpalm` | Generated runtime artifacts (compose files, audit logs) |

---

## Network Requirements

### Outbound Access

| Destination | When Needed |
|---|---|
| LLM provider APIs (api.openai.com, api.anthropic.com, etc.) | When using remote models |
| Docker Hub / GitHub Container Registry | Image pulls during install and updates |
| Ollama on host (`host.docker.internal:11434`) | When using local models via Ollama on the host |

### Inbound Ports

OpenPalm is **LAN-first by default**. No inbound ports need to be opened on your firewall unless you explicitly expose services.

| Port | Binding | Service | Notes |
|---|---|---|---|
| 8080 | `127.0.0.1` (default) | Caddy ingress | Configurable via `OP_INGRESS_BIND_ADDRESS` and `OP_INGRESS_PORT` |
| 8100 | `127.0.0.1` | Admin API (direct) | Always localhost-only |
| 4096 | `127.0.0.1` | Assistant (OpenCode) | Host-only access; no auth required (bind address is the security boundary) |
| 8765 | `127.0.0.1` | Memory API | Direct access; normally accessed by assistant internally |
| 2222 | `127.0.0.1` | Assistant SSH | Optional SSH access to OpenCode; disabled by default |

To expose the Caddy ingress on all interfaces (e.g., for LAN access), set `OP_INGRESS_BIND_ADDRESS=0.0.0.0` in your stack configuration. Public exposure requires additional Caddy TLS configuration.

### Internal Networks

Docker Compose creates four isolated networks. No host configuration is needed:

| Network | Purpose |
|---|---|
| `assistant_net` | Core services (admin, assistant, memory, guardian) |
| `admin_docker_net` | Admin to docker-socket-proxy only |
| `channel_lan` | LAN-restricted channel containers |
| `channel_public` | Publicly accessible channel containers |
