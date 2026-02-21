<img src="assets/state/content/banner.png" alt="OpenPalm" width="500" />

<p>
  <strong>Your own AI assistant — private, secure, and ready in minutes.</strong><br/>
  Talk to it from Discord, Telegram, web chat, or voice. It remembers what matters and forgets what it should.
</p>

---

## Why OpenPalm?

Most AI assistants live on someone else's servers. OpenPalm runs on yours. Your conversations, your memory, your rules — nothing leaves your network unless you want it to.

- **One command to install** — works with Docker, Podman, or OrbStack on Linux, macOS, or Windows.
- **Connect your channels** — Discord, Telegram, web chat, and voice are built in. Add more without coding.
- **Long-term memory** — your assistant remembers context across conversations. Secrets are never stored.
- **Admin dashboard** — manage everything from a browser: services, extensions, agent config, and automations.
- **Built for safety** — eight layers of security stand between the internet and your assistant's actions.

## Get started

Pick whichever method suits your system:

**Bash** (Linux / macOS — no dependencies beyond curl):
```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/assets/state/scripts/install.sh | bash
```

**PowerShell** (Windows):
```powershell
pwsh -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/itlackey/openpalm/main/assets/state/scripts/install.ps1 -OutFile $env:TEMP/openpalm-install.ps1; & $env:TEMP/openpalm-install.ps1"
```

**npx** (any OS with Node.js):
```bash
npx openpalm install
```

**bunx** (any OS with Bun):
```bash
bunx openpalm install
```

The installer detects your container runtime, generates secure credentials, starts all services, and opens a setup wizard in your browser. The whole process is guided — no config files to edit. See the [CLI documentation](docs/cli.md) for all available commands.

## What you get

### Talk from anywhere

Connect Discord, Telegram, a web chat widget, or a voice interface. Each channel runs as a lightweight adapter — your assistant's core logic stays the same regardless of where the message comes from.

### It remembers

OpenPalm includes a built-in memory system (powered by OpenMemory). Your assistant recalls past conversations, preferences, and context. A strict policy layer ensures passwords, tokens, and private keys are never saved to memory.

### Admin dashboard

A web-based control panel lets you:
- Start, stop, and restart services
- Browse and install extensions from the curated gallery, community registry, or npm
- Edit agent configuration with validation
- Toggle channel access between private and public
- Create and manage automations
- Monitor system health

Everything is password-protected. The admin panel is only accessible from your local network.

### Extensions

Add capabilities through the admin UI, API, or command line. Extensions add new abilities to your assistant -- behavioral skills, slash commands, specialized agents, custom tools, and lifecycle plugins. Browse and manage them in the Extension Gallery, where each has a risk badge and plain-language description. Install from the curated gallery, community registry, or npm.

### Automations

Automations let your assistant act on a schedule -- daily briefings, weekly reports, periodic checks -- without anyone sending a message. Create them with standard cron expressions, toggle them on and off, or trigger them manually from the admin UI.

OpenPalm also ships with non-configurable system maintenance cron jobs in the admin-managed stack by default. These jobs automatically pull image updates, restart services after updates, rotate maintenance logs, prune old images, run health checks with auto-restart, run best-effort security scans, perform Postgres maintenance, clean stale temporary files, and scrape runtime metrics into `${OPENPALM_STATE_HOME}/observability/maintenance`.

## Security

OpenPalm is designed with defense in depth — multiple independent layers so that no single failure exposes the system.

| Layer | What it does |
|---|---|
| **Network boundary** | Caddy reverse proxy restricts admin access to your local network; TLS encryption |
| **Signed messages** | Every channel message is cryptographically signed and verified before processing |
| **Rate limiting** | Per-user throttling prevents abuse (120 requests/minute) |
| **Input validation** | Incoming messages are validated by a restricted agent that cannot run commands or edit files |
| **Approval gates** | The main agent requires approval before running tools, editing files, or accessing the web |
| **Secret protection** | A policy plugin blocks any tool call that contains passwords or tokens |
| **Behavioral rules** | Hard-coded rules prevent data exfiltration and require confirmation for destructive actions |
| **Isolated control plane** | Only one container can manage the Docker runtime — the rest have no access |

For a detailed breakdown, see the [Security Guide](docs/security.md).

## How it works

```
Channels (Discord, Telegram, Chat, Voice)
    |  signed messages
    v
Gateway (verify, rate-limit, audit)
    |  validate with locked-down agent
    v
OpenCode Core (full assistant) <--> Open Memory
    |
Admin Dashboard --> Admin --> Docker Compose
```

Every component runs in its own container on a private network. The gateway verifies message signatures and validates input before anything reaches your assistant. The admin dashboard manages the system lifecycle.

For the full architecture, container inventory, and routing details, see the [Architecture Guide](docs/development/architecture.md).

## Configuration

All data is organized following standard conventions:

| What | Where | Purpose |
|---|---|---|
| Databases & storage | `~/.local/share/openpalm/` | PostgreSQL, Qdrant, OpenMemory, OpenCode home data |
| Configuration | `~/.config/openpalm/` | `stack-spec.json` and `secrets.env` (source-of-truth inputs) |
| Runtime state | `~/.local/state/openpalm/` | Rendered compose/Caddy/env artifacts, logs, runtime state (`~/openpalm` is workdir) |

The installer sets these up automatically. Override the paths with environment variables if you prefer a different location.

## OpenPalm vs OpenClaw

OpenPalm was inspired by [OpenClaw](https://github.com/openclaw/openclaw) but takes a fundamentally different approach to security. Where OpenClaw runs as a local daemon with broad system access, OpenPalm isolates every component in its own container with explicit, layered controls.

| | OpenPalm | OpenClaw |
|---|---|---|
| **Runs as** | Isolated Docker containers on a private network | Local daemon with direct host access |
| **Message security** | Cryptographically signed and verified | DM pairing codes |
| **Tool access** | Approval gates + locked-down intake validation | Elevated bash toggled per session |
| **Extensions** | Admin-authenticated install with curated gallery | Auto-discovery from registry |
| **Admin** | Web dashboard with password auth (LAN only) | Chat commands in messaging channels |
| **Memory** | Explicit-save-only with secret detection | Session-based with compression |
| **Deployment** | Single compose command (docker/podman/orbstack) | Daemon install with multiple modes |

For more context: [data exfiltration and prompt injection vulnerabilities found in OpenClaw's skill ecosystem](https://news.northeastern.edu/2026/02/10/open-claw-ai-assistant/).

## Documentation

| Guide | What's inside |
|---|---|
| [CLI](docs/cli.md) | Install methods, commands, flags, and building from source |
| [User Concepts](docs/user-concepts.md) | What OpenPalm is and how end users interact with it |
| [Admin Concepts](docs/admin-concepts.md) | Key concepts for administrators |
| [Admin Guide](docs/admin-guide.md) | Installer details, admin console, authentication |
| [Architecture](docs/development/architecture.md) | Container inventory, data flow diagrams, URL routing |
| [API Reference](docs/development/api-reference.md) | All service endpoints: gateway, admin, channels |
| [Extensions Guide](docs/extensions-guide.md) | Plugin system, gallery, building channel plugins |
| [Extensions Reference](docs/reference/extensions-reference.md) | Technical reference for all extension types (API/schema details) |
| [Extensions Analysis](docs/draft/extensions-analysis.md) | Architecture analysis of the extension system (design rationale) |
| [Plugin Authoring](docs/development/plugin-authoring.md) | How to write OpenCode plugins with lifecycle hooks |
| [Docker Compose Guide](docs/docker-compose-guide.md) | Hosting, observability, extending the stack |
| [Host System Reference](docs/reference/host-system-reference.md) | Host paths, environment variables, system requirements |
| [Implementation Guide](docs/draft/implementation-guide.md) | Design rationale and build order |
| [Security Guide](docs/security.md) | Security controls by layer and why they exist |
| [Testing Plan](docs/development/testing-plan.md) | Test strategy, coverage goals, and test categories |
| [Backup & Restore](docs/backup-restore.md) | How to back up and restore OpenPalm data |
| [Upgrade Guide](docs/upgrade-guide.md) | How to upgrade OpenPalm to a new version |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and how to resolve them |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and workflows.

## License

See [LICENSE](LICENSE).
