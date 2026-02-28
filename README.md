<img src="core/admin/static/banner.png" alt="OpenPalm" width="500" />

<p>
  <strong>Your own AI assistant — private, secure, and ready in minutes.</strong><br/>
  Talk to it from Discord, web chat, or any channel you add. It remembers what matters and forgets what it should.
</p>

---

## Why OpenPalm?

Most AI assistants live on someone else's servers. OpenPalm runs on yours. Your conversations, your memory, your rules — nothing leaves your network unless you want it to.

- **Simple to run** — a single Docker Compose stack on Linux, macOS, or Windows.
- **Connect your channels** — web chat and Discord are built in. Add more by dropping files — no code changes.
- **Long-term memory** — your assistant remembers context across conversations via OpenMemory. Secrets are never stored.
- **Admin dashboard** — manage everything from a browser: services, channels, access control.
- **Built for safety** — defense-in-depth security: HMAC-signed messages, guardian validation, assistant isolation, LAN-first by default.

## Prerequisites

You need **one thing** installed before starting: a container runtime.

| Your computer | What to install | Link |
|---|---|---|
| **Windows** | Docker Desktop | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) |
| **Mac** | Docker Desktop _or_ OrbStack | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) / [orbstack.dev](https://orbstack.dev/download) |
| **Linux** | Docker Engine | Run `curl -fsSL https://get.docker.com \| sh` |

After installing, open the app and wait for it to finish starting (you'll see a green/running indicator).

## Get Started

Copy-paste **one** command into your terminal and the installer does the rest:

**Mac or Linux** — open Terminal and paste:
```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

**Windows (PowerShell)** — open PowerShell and paste:
```powershell
irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
```

No config files to edit. Re-run the same command to update — your secrets are never overwritten.

See the [setup guide](docs/setup-guide.md) for details.

## What You Get

### Talk from anywhere

Connect Discord, a web chat widget, or build your own channel adapter. Each channel runs as a lightweight Docker container — your assistant's core logic stays the same regardless of where the message comes from.

### It remembers

OpenPalm includes a built-in memory system powered by OpenMemory. Your assistant recalls past conversations, preferences, and context. Secrets are never saved to memory.

### Admin dashboard

A web-based control panel lets you:
- Start, stop, and restart services
- Install and manage channels
- Toggle channel access between LAN-only and public
- Monitor system health

All admin operations require an admin token (`x-admin-token` header). The admin panel is only accessible from your local network by default.

### Add channels by file-drop

Adding a channel requires no code changes — just drop a Docker Compose overlay (`.yml`) and an optional Caddy route (`.caddy`) into the registry. The admin stages these into the runtime automatically. Built-in channels include web chat and Discord, with community channels documented in [`docs/community-channels.md`](docs/community-channels.md).

<div>

## How It Works

<img src="core/admin/static/fu-128.png" alt="OpenPalm" width="90" style="float: right; shape-margin: 0.25rem;" />
<p>OpenPalm has defense built into it's core. It has many layers working together to protect your system and your secrets for malicious activity, destructive actions, and other common disasters than can occur with unattended AI assistants.</p>
</div>

- **Admin** (`core/admin/`) — SvelteKit app: operator UI + API + control plane. Only component with Docker socket access.
- **Guardian** (`core/guardian/`) — Bun HTTP server: HMAC verification, replay detection, rate limiting for all channel traffic.
- **Assistant** (`core/assistant/`) — OpenCode runtime. No Docker socket. Calls Admin API for stack operations.
- **Channel adapters** (`channels/`) — Translate external protocols into signed guardian messages.
- **Shared lib** (`packages/lib/`) — SDK for channel validation, crypto, and logging.

**Key rules:**
- The **Admin API** is the sole orchestrator — no other component runs Docker commands.
- The **Guardian** is the sole ingress for channel traffic — all messages are HMAC-verified before reaching the assistant.
- The **Assistant** is fully isolated — no Docker socket, no host filesystem beyond designated mounts.
- **LAN-first by default** — nothing is publicly exposed without explicit opt-in.

See [`docs/how-it-works.md`](docs/how-it-works.md) for the full architecture walkthrough and [`docs/core-principles.md`](docs/core-principles.md) for security invariants.

## Documentation

| Guide | What's inside |
|---|---|
| [Setup Guide](docs/setup-guide.md) | Installation, updating, troubleshooting, and first steps |
| [How It Works](docs/how-it-works.md) | Architecture overview and data flow |
| [Managing OpenPalm](docs/managing-openpalm.md) | Configuration, channels, secrets, access control |
| [Core Principles](docs/core-principles.md) | Security invariants and architectural rules |
| [Directory Structure](docs/directory-structure.md) | Host paths, XDG tiers, volume design |
| [Community Channels](docs/community-channels.md) | BaseChannel SDK for building custom adapters |
| [API Spec](docs/api-spec.md) | Admin API endpoint contract |
| [PRD](docs/prd.md) | MVP requirements and constraints |

### Project READMEs

| Component | README |
|---|---|
| Assets (compose, Caddyfile) | [assets/README.md](assets/README.md) |
| API channel | [channels/api/README.md](channels/api/README.md) |
| Discord channel | [channels/discord/README.md](channels/discord/README.md) |

## Development

```bash
./scripts/dev-setup.sh --seed-env

cd core/admin
npm install
npm run dev
```

Admin UI + API runs on `http://localhost:8100`.

From the repo root, convenience scripts are available:

```bash
bun run admin:dev        # core/admin dev server
bun run admin:check      # svelte-check + TypeScript
bun run guardian:dev     # core/guardian server
bun run guardian:test    # guardian tests
bun run lib:test         # packages/lib tests
bun run dev:setup        # seed .dev/ dirs and configs
bun run dev:stack        # start dev stack via docker compose
bun run check            # admin:check + lib:test
```

`dev-setup.sh --seed-env` seeds `.dev/config/secrets.env` from `assets/secrets.env` and sets the `OPENPALM_*_HOME` variables to absolute `.dev/` paths. The UI dev server picks these up automatically — no additional environment setup needed.

## License

See [LICENSE](LICENSE).
