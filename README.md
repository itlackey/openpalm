<img src="assets/banner.png" alt="OpenPalm" width="500" />

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
- **Admin dashboard** — manage everything from a browser: services, extensions, agent config, and scheduled tasks.
- **Built for safety** — eight layers of security stand between the internet and your assistant's actions.

## Get started

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/install.sh | bash
```

```powershell
pwsh -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/install.ps1 -OutFile $env:TEMP/openpalm-install.ps1; & $env:TEMP/openpalm-install.ps1"
```

The installer detects your container runtime, generates secure credentials, starts all services, and opens a setup wizard in your browser. The whole process is guided — no config files to edit.

During setup you choose whether your assistant is accessible only from this machine or from your local network. You can change this later from the admin dashboard.

## What you get

### Talk from anywhere

Connect Discord, Telegram, a web chat widget, or a voice interface. Each channel runs as a lightweight adapter — your assistant's core logic stays the same regardless of where the message comes from.

### It remembers

OpenPalm includes a built-in memory system (powered by OpenMemory). Your assistant recalls past conversations, preferences, and context. A strict policy layer ensures passwords, tokens, and private keys are never saved to memory.

### Admin dashboard

A web-based control panel lets you:
- Start, stop, and restart services
- Browse and install extensions from a curated gallery or npm
- Edit agent configuration with validation
- Toggle channel access between private and public
- Create and manage scheduled tasks (cron jobs)
- Monitor system health

Everything is password-protected. The admin panel is only accessible from your local network.

### Extensions

Add capabilities through the admin UI, API, or command line. Extensions include OpenCode plugins, behavioral skills, and container services. Install from a curated gallery or directly from npm.

### Scheduled tasks

Set up recurring jobs that run on your assistant — daily summaries, periodic checks, maintenance tasks. Create them with standard cron expressions, toggle them on and off, or trigger them manually from the admin UI.

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
Admin Dashboard --> Controller --> Docker Compose
```

Every component runs in its own container on a private network. The gateway verifies message signatures and validates input before anything reaches your assistant. The admin dashboard and controller manage the system lifecycle.

For the full architecture, container inventory, and routing details, see the [Architecture Guide](docs/architecture.md).

## Configuration

All data is organized following standard conventions:

| What | Where | Purpose |
|---|---|---|
| Databases & storage | `~/.local/share/openpalm/` | PostgreSQL, vector store, shared files |
| Configuration | `~/.config/openpalm/` | Agent config, channel settings, secrets |
| Runtime state | `~/.local/state/openpalm/` | Logs, audit trail, workspace |

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
| [Architecture](docs/architecture.md) | Container inventory, data flow diagrams, URL routing |
| [API Reference](docs/API.md) | All service endpoints: gateway, admin, controller, channels |
| [Admin Guide](docs/admin-guide.md) | Installer details, admin console, authentication |
| [Extensions Guide](docs/extensions-guide.md) | Plugin system, gallery, building channel plugins |
| [Docker Compose Guide](docs/docker-compose-guide.md) | Hosting, observability, extending the stack |
| [Implementation Guide](docs/implementation-guide.md) | Design rationale and build order |
| [Security Guide](docs/security.md) | Security controls by layer and why they exist |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and workflows.

## License

See [LICENSE](LICENSE).
