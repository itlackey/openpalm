<img src="assets/banner.png" alt="OpenPalm"  width="800" />  

<p>
  <strong>A safety-first AI assistant platform you own and control.</strong><br/>
  Multi-channel. Extensible. Defense in depth. One compose command away.
</p>

<p >
  <a href="docs/architecture.md">Architecture</a> &middot;
  <a href="docs/API.md">API Reference</a> &middot;
  <a href="docs/admin-guide.md">Admin Guide</a> &middot;
  <a href="docs/extensions-guide.md">Extensions</a>
</p>

---

## What is OpenPalm?

OpenPalm is a self-hosted AI assistant platform built on Bun/TypeScript that runs entirely in Docker. Connect it to Discord, Telegram, a web chat, or voice — every message flows through layered security controls before reaching the agent runtime. Long-term memory, an admin dashboard, and an extension gallery are built in.

## Get started

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/install.sh | bash
```

The installer auto-detects `docker`, `podman`, or `orbstack`, pulls images, prepares local assets, shows a startup wait indicator, and opens the admin setup wizard as soon as it is online.

## Key features

**Multi-channel ingress** — Chat, Discord, Voice, and Telegram adapters plug in as lightweight containers. Each one signs payloads with HMAC and forwards through a single gateway. Add channels without touching core logic.

**Dual-runtime isolation** — Untrusted channel input is validated by a locked-down OpenCode runtime (all tools denied). Only validated summaries reach the full agent runtime with approval gates.

**Long-term memory** — OpenMemory provides vector-backed recall via MCP. The agent remembers context across sessions while policy skills prevent secret storage.

**Admin dashboard & gallery** — A built-in web UI for managing services, browsing curated extensions, installing plugins from npm, toggling channel access, editing agent config, and scheduling cron jobs — all behind admin password authentication set during install.

**Cron scheduler** — Schedule recurring tasks that run on the core agent. Create jobs with standard 5-field cron expressions, toggle them on/off, trigger them manually, and monitor results — all from the admin UI or API. Jobs execute directly against the OpenCode core runtime.

**Extension system** — Install OpenCode plugins, skills, and container services through the admin UI, API, or CLI.

**Defense in depth** — Eight security layers from network edge to agent behavior:

| Layer | What it does |
|---|---|
| Caddy reverse proxy | LAN-only restriction for admin; TLS termination |
| Gateway | HMAC verification, rate limiting (120 req/min), audit logging |
| Runtime isolation | Channel runtime: all tools denied; Core runtime: approval gates |
| Policy plugin | Blocks tool calls containing secrets |
| Agent rules | Behavioral constraints in AGENTS.md |
| Skills | SOPs: ChannelIntake, RecallFirst, MemoryPolicy, ActionGating |
| Admin auth | Password-protected admin API (LAN only) |
| Controller isolation | Only one container touches the container engine socket |

## OpenPalm vs OpenClaw

OpenPalm was inspired by [OpenClaw](https://github.com/openclaw/openclaw) but takes a fundamentally different approach to security and deployment. Where OpenClaw runs as a local daemon with broad system access, OpenPalm isolates every component in its own container with explicit, layered controls.

| | OpenPalm | OpenClaw |
|---|---|---|
| **Architecture** | Containerized microservices — each service is an isolated Docker container on a private network | Local daemon with WebSocket control plane — agent runs directly on the host |
| **Channel security** | HMAC-signed payloads, gateway signature verification, and isolated intake validation | DM pairing codes, opt-in open DM policy |
| **Runtime isolation** | Two separate runtimes: locked-down channel intake (all tools denied) + gated core agent | Single runtime with elevated bash toggled per session |
| **Extension safety** | Admin-authenticated install via curated gallery or npm, atomic config updates with backup | Auto-discovery from ClawHub registry, skills pulled dynamically |
| **Admin controls** | Dedicated admin API + web dashboard behind password auth on LAN-only network | Chat commands (`/status`, `/reset`, `/mesh`) sent in messaging channels |
| **Memory policy** | Explicit-save-only with secret detection, policy skills, and redaction | Session-based context with `/compact` compression |
| **Container management** | Controller service (only container with engine socket), admin API for lifecycle ops | Direct host access — agent can run shell commands natively |
| **Deployment** | Single compose up command (`docker/podman/orbstack`) — services, networking, and secrets generated automatically | Daemon install via `onboard --install-daemon`, multiple hosting modes (local, VPS, Tailscale) |
| **Channels** | Chat, Discord, Voice, Telegram (containerized adapters) | WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Teams, Google Chat, WebChat, and more |
| **Proactive features** | Cron scheduler with admin UI — create, edit, toggle, and manually trigger scheduled agent tasks | Heartbeat system and cron jobs for autonomous actions |

**In short:** OpenPalm provides depth-first security — every layer is designed to prevent the kind of [data exfiltration and prompt injection vulnerabilities](https://news.northeastern.edu/2026/02/10/open-claw-ai-assistant/) that have been found in OpenClaw's skill ecosystem.

## Architecture at a glance

```
Channels (chat, discord, voice, telegram)
    │  HMAC-signed payloads
    ▼
Gateway (includes isolated OpenCode intake)
    │  validate/summarize with deny-by-default permissions
    ▼
OpenCode Core (full agent) ◀──▶ Open Memory (MCP)
    │
Admin App ──▶ Controller ──▶ Docker Compose
```

The controller uses runtime settings persisted in `.env` (`OPENPALM_CONTAINER_*` and `OPENPALM_COMPOSE_*`) so admin lifecycle actions always use the same platform selected during install.

Every service is a distinct container on a private Docker network. Caddy sits in front, routing `/channels/*` to adapters and `/admin/*` to the dashboard. See the [full architecture](docs/architecture.md) for the container inventory, Mermaid diagram, and routing table.

## Configuration

All persistent data follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/):

| Category | Default path | Purpose |
|---|---|---|
| Data | `~/.local/share/openpalm/` | Databases, vectors, blobs |
| Config | `~/.config/openpalm/` | Agent configs, Caddyfile, channel env |
| State | `~/.local/state/openpalm/` | Runtime state, audit logs, workspace |

Override with `OPENPALM_DATA_HOME`, `OPENPALM_CONFIG_HOME`, or `OPENPALM_STATE_HOME` in `.env`.

Container runtime selection is also persisted in `.env`:
- `OPENPALM_CONTAINER_PLATFORM` (`docker`, `podman`, `orbstack`)
- `OPENPALM_COMPOSE_BIN` / `OPENPALM_COMPOSE_SUBCOMMAND`
- `OPENPALM_CONTAINER_SOCKET_PATH` / `OPENPALM_CONTAINER_SOCKET_URI`

`assets/system.env` is system-managed by the installer and should only be edited manually by experienced users.

Use `assets/user.env` (installed to `$OPENPALM_CONFIG_HOME/CONFIG/user.env`) for user-specific overrides.

### Optional: Enable LAN + SSH access for OpenCode core

To use the OpenCode TUI from another machine on your LAN, set these in your `.env`:

```bash
OPENCODE_CORE_BIND_ADDRESS=0.0.0.0
OPENCODE_ENABLE_SSH=1
OPENCODE_CORE_SSH_BIND_ADDRESS=0.0.0.0
OPENCODE_CORE_SSH_PORT=2222
```

Then add your public key(s) to:

`$OPENPALM_CONFIG_HOME/opencode-core/ssh/authorized_keys`

After restart, remote LAN clients can target `http://<host-lan-ip>:4096` for OpenCode server access, and SSH to `ssh -p 2222 root@<host-lan-ip>` (key auth).

## Documentation

| | |
|---|---|
| [Architecture](docs/architecture.md) | Container inventory, data flow, URL routing, storage layout |
| [API Reference](docs/API.md) | All service endpoints: gateway, admin, controller, channels |
| [Admin Guide](docs/admin-guide.md) | Installer, settings UI, admin authentication |
| [Extensions Guide](docs/extensions-guide.md) | Plugin system, gallery, building channel plugins |
| [Docker Compose Guide](docs/docker-compose-guide.md) | Hosting, observability, extending the stack |
| [Implementation Guide](docs/implementation-guide.md) | Design rationale and build order |
| [Security Guide](docs/security.md) | Security controls by layer and why they exist |

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for local editing, building, and validation workflows.

## License

See [LICENSE](LICENSE).
