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
- **Built for safety** — defense-in-depth security protects the assistant and your data.

## Prerequisites

You need **one thing** installed before starting: a container runtime. If you have never heard of Docker, think of it as a way to run apps in isolated boxes so they don't interfere with the rest of your computer.

| Your computer | What to install | Link |
|---|---|---|
| **Windows** | Docker Desktop | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) |
| **Mac** | Docker Desktop _or_ OrbStack | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) / [orbstack.dev](https://orbstack.dev/download) |
| **Linux** | Docker Engine | Run `curl -fsSL https://get.docker.com \| sh` |

After installing, **open the app and wait for it to finish starting** (you'll see a green/running indicator). Then run the installer below.

## Get started

Copy-paste **one** command into your terminal and the installer does the rest:

**Mac or Linux** — open Terminal and paste:
```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/assets/state/scripts/install.sh | bash
```

**Windows** — open PowerShell and paste:
```powershell
pwsh -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/itlackey/openpalm/main/assets/state/scripts/install.ps1 -OutFile $env:TEMP/openpalm-install.ps1; & $env:TEMP/openpalm-install.ps1"
```

<details>
<summary>Alternative: install via npx or bunx</summary>

If you already have Node.js or Bun installed:
```bash
npx openpalm install
# or
bunx openpalm install
```
</details>

### What happens when you run the installer

1. It checks your system and downloads the OpenPalm services
2. It generates a secure admin password and prints it to your screen
3. It starts all services and opens a setup wizard in your browser
4. The wizard walks you through connecting your AI provider, setting a password, and choosing channels

No config files to edit. See the [CLI documentation](docs/cli.md) for all available commands.

## What you get

### Talk from anywhere

Connect Discord, Telegram, a web chat widget, or a voice interface. Each channel runs as a lightweight adapter — your assistant's core logic stays the same regardless of where the message comes from.

### It remembers

OpenPalm includes a built-in memory system (powered by OpenMemory). Your assistant recalls past conversations, preferences, and context. A strict policy layer ensures passwords, tokens, and private keys are never saved to memory.

### Admin dashboard

A web-based control panel lets you:
- Start, stop, and restart services
- Browse and install extensions from the community registry or npm
- Edit agent configuration with validation
- Toggle channel access between private and public
- Create and manage automations
- Monitor system health

Everything is password-protected. The admin panel is only accessible from your local network.

### Extensions

OpenPalm supports all OpenCode extension types: plugins, agents, commands, skills, tools, and providers. Extensions add new abilities to your assistant — behavioral skills, slash commands, specialized agents, custom tools, and lifecycle plugins.

The admin UI and CLI manage npm plugins (the `plugin[]` list in `opencode.json`). Skills, agents, commands, and tools can be managed manually in the OpenCode config directory by advanced users.

### Automations

Automations let your assistant act on a schedule -- daily briefings, weekly reports, periodic checks -- without anyone sending a message. Create them with standard cron expressions, toggle them on and off, or trigger them manually from the admin UI.

OpenPalm also ships with non-configurable system maintenance cron jobs in the admin-managed stack by default. These jobs automatically pull image updates, restart services after updates, rotate maintenance logs, prune old images, run health checks with auto-restart, run best-effort security scans, perform Postgres maintenance, clean stale temporary files, and scrape runtime metrics.

## OpenPalm vs OpenClaw

OpenPalm was inspired by [OpenClaw](https://github.com/openclaw/openclaw) but takes a fundamentally different approach to security. Where OpenClaw runs as a local daemon with broad system access, OpenPalm isolates every component in its own container with explicit, layered controls.

| | OpenPalm | OpenClaw |
|---|---|---|
| **Runs as** | Isolated Docker containers on a private network | Local daemon with direct host access |
| **Message security** | Cryptographically signed and verified | DM pairing codes |
| **Tool access** | Approval gates + locked-down intake validation | Elevated bash toggled per session |
| **Extensions** | Admin-authenticated install | Auto-discovery from registry |
| **Admin** | Web dashboard with password auth (LAN only) | Chat commands in messaging channels |
| **Memory** | Explicit-save-only with secret detection | Session-based with compression |
| **Deployment** | Single compose command (docker/podman/orbstack) | Daemon install with multiple modes |

For more context: [data exfiltration and prompt injection vulnerabilities found in OpenClaw's skill ecosystem](https://news.northeastern.edu/2026/02/10/open-claw-ai-assistant/).

## Documentation

| Guide | What's inside |
|---|---|
| [CLI](docs/cli.md) | Install methods, commands, flags, and building from source |
| [User Concepts](docs/concepts.md) | What OpenPalm is and how end users interact with it |
| [Admin Guide](admin/docs/admin-guide.md) | Installation, admin console, authentication |
| [Admin Concepts](admin/docs/admin-concepts.md) | Extensions, secrets, channels, automations, gateway |
| [Security Guide](docs/security.md) | Security controls by layer and why they exist |
| [Host System Reference](docs/host-system-reference.md) | Host paths, environment variables, system requirements |
| [Maintenance](docs/maintenance.md) | Backup, restore, upgrade, and rollback procedures |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and how to resolve them |
| [Architecture](dev/docs/architecture.md) | Container inventory, data flow diagrams, URL routing |
| [API Reference](dev/docs/api-reference.md) | All service endpoints: gateway, admin, channels |

### Project READMEs

| Service | README |
|---|---|
| Admin service | [admin/README.md](admin/README.md) |
| Gateway service | [gateway/README.md](gateway/README.md) |
| Assistant service | [assistant/README.md](assistant/README.md) |
| Chat channel | [channels/chat/README.md](channels/chat/README.md) |
| Discord channel | [channels/discord/README.md](channels/discord/README.md) |
| Voice channel | [channels/voice/README.md](channels/voice/README.md) |
| Telegram channel | [channels/telegram/README.md](channels/telegram/README.md) |
| Webhook channel | [channels/webhook/README.md](channels/webhook/README.md) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and workflows.

## License

See [LICENSE](LICENSE).
