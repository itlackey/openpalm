<img src="packages/admin/static/banner.png" alt="OpenPalm" width="500" />

<p>
  <strong>A foundation for building your own AI assistant — private, extensible, and yours to keep.</strong>
</p>

---

## You deserve your own assistant

AI assistants shouldn't be someone else's product. They should be something you own, shape, and trust. OpenPalm exists because we believe everyone should have a DIY assistant that runs on their own hardware, remembers what they care about, and works the way they want it to.

OpenPalm isn't a finished product you consume. It's a starter kit — a secure, modular foundation you build on top of. Swap models, add channels, wire in your own tools, and make it yours. The architecture is designed so you can go as far as you want without fighting the framework.

## What makes the core strong

OpenPalm's value isn't in any single feature. It's in the decisions baked into the architecture:

- **Defense in depth** — Every message passes through HMAC-signed verification, replay detection, and rate limiting before reaching the assistant. The assistant itself has no Docker socket and no host access. Nothing is exposed beyond your LAN unless you explicitly opt in.
- **File-drop modularity** — Adding a channel, automation, or service means dropping a file. No code changes, no rebuilds, no pull requests. The admin assembles everything at runtime from plain files.
- **Memory that persists** — Your assistant remembers context across conversations. Secrets are never stored in memory. You control what it knows and what it forgets.
- **Single-command setup** — One copy-paste command gets you a running stack. Re-run to update. Your config is never overwritten.

## Extend it with integrations

OpenPalm is built to integrate, not to lock you in.

### Varlock — secret protection at every layer

[Varlock](https://varlock.dev) is an open-source secret management and redaction tool integrated throughout the stack:

- **Validation** — Environment files are checked against schemas before the stack starts, catching missing or malformed secrets early.
- **Leak scanning** — Pre-commit hooks and CLI commands scan for accidentally committed keys before they reach your repo.
- **Runtime redaction** — Every bash command the assistant runs is wrapped through Varlock, stripping API keys and tokens from output before they enter the LLM context window.

If Varlock isn't installed, the system falls back gracefully — nothing breaks, you just lose the protection layer. It's a safety net, not a hard dependency.

### AKM — agent knowledge management

[AKM](https://github.com/itlackey/akm) is an OpenCode plugin that extends the assistant with structured knowledge capabilities. It's auto-installed alongside OpenPalm's own assistant tools, giving your assistant a stash of reusable context that persists across sessions. Customize it by adding your own knowledge, skills, and tools to the stash directory.

### Bring your own everything

- **Models** — Connect any OpenAI-compatible endpoint: local (LM Studio, Ollama) or remote (OpenAI, Groq, any provider).
- **Channels** — Web chat and Discord are built in. Build your own adapter with the Channels SDK, or drop in a community channel.
- **Tools and skills** — The assistant runs on OpenCode, so any OpenCode plugin works out of the box.
- **Automations** — Schedule recurring tasks (updates, health checks, prompts) by dropping a YAML file.

## Get started

You need **one thing** installed: a container runtime.

| Your computer | What to install | Link |
|---|---|---|
| **Windows** | Docker Desktop | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) |
| **Mac** | Docker Desktop _or_ OrbStack | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) / [orbstack.dev](https://orbstack.dev/download) |
| **Linux** | Docker Engine | Run `curl -fsSL https://get.docker.com \| sh` |

Then copy-paste **one** command:

**Mac or Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
```

No config files to edit. Re-run the same command to update — your secrets are never overwritten. See the [setup guide](docs/setup-guide.md) for details.

## How it works

<div>
<img src="packages/admin/static/fu-128.png" alt="OpenPalm" width="90" style="float: right; shape-margin: 0.25rem;" />
<p>OpenPalm has defense built into its core — many layers working together to protect your system and your secrets from malicious activity, destructive actions, and other common disasters that can occur with unattended AI assistants.</p>
</div>

![Architecture](docs/technical/architecture.svg)

| Component | Role |
|---|---|
| **Admin** (`packages/admin/`) | SvelteKit app: operator UI + API + control plane. Sole component with Docker socket access. |
| **Guardian** (`core/guardian/`) | Bun HTTP server: HMAC verification, replay detection, rate limiting for all channel traffic. |
| **Assistant** (`core/assistant/`) | OpenCode runtime with tools/skills. No Docker socket. Calls Admin API for stack operations. |
| **Channel runtime** (`core/channel/`) | Unified image entrypoint for registry channel overlays. |
| **Channel packages** (`packages/channel-*/`) | Translate external protocols (Discord, OpenAI API, web chat) into signed guardian messages. |
| **Channels SDK** (`packages/channels-sdk/`) | `BaseChannel` abstract class, HMAC crypto, logger, and payload types for building adapters. |

**Architectural invariants:**
- The **CLI** is the primary host-side orchestrator; the **Admin** is optional and provides a web UI via docker-socket-proxy.
- The **Guardian** is the sole ingress — all channel traffic is HMAC-verified before reaching the assistant.
- The **Assistant** is fully isolated — no Docker socket, no host filesystem beyond designated mounts.
- **LAN-first by default** — nothing is publicly exposed without explicit opt-in.

See [`docs/how-it-works.md`](docs/how-it-works.md) for the full walkthrough and [`docs/technical/core-principles.md`](docs/technical/core-principles.md) for security invariants.

## Make it yours

OpenPalm is a starting point. Here's how people build on it:

- **Drop in a channel** — Write a Compose overlay + optional Caddy route. The admin picks it up automatically.
- **Add assistant tools** — Any OpenCode plugin works. Install from npm or build your own.
- **Customize memory** — Choose your embedding model, enable reranking, set custom instructions for how memories are processed.
- **Schedule automations** — Drop a YAML file to run health checks, send prompts, clean logs, or anything else on a cron schedule.
- **Swap the model** — Point at a different provider or local model at any time through the admin dashboard.

## Documentation

| Guide | What's inside |
|---|---|
| [Setup Guide](docs/setup-guide.md) | Installation, updating, troubleshooting, and first steps |
| [How It Works](docs/how-it-works.md) | Architecture overview and data flow |
| [Managing OpenPalm](docs/managing-openpalm.md) | Configuration, channels, secrets, access control |
| [Core Principles](docs/technical/core-principles.md) | Security invariants and architectural rules |
| [Directory Structure](docs/technical/directory-structure.md) | Host paths, XDG tiers, volume design |
| [Community Channels](docs/community-channels.md) | BaseChannel SDK for building custom adapters |
| [API Spec](docs/technical/api-spec.md) | Admin API endpoint contract |

### Component READMEs

| Component | README |
|---|---|
| Assets (compose, Caddyfile) | [assets/README.md](assets/README.md) |
| Admin (UI + API) | [packages/admin/README.md](packages/admin/README.md) |
| Guardian | [core/guardian/README.md](core/guardian/README.md) |
| Assistant | [core/assistant/README.md](core/assistant/README.md) |
| Channel runtime | [core/channel/README.md](core/channel/README.md) |
| Channels SDK | [packages/channels-sdk/README.md](packages/channels-sdk/README.md) |
| Assistant tools | [packages/assistant-tools/README.md](packages/assistant-tools/README.md) |
| CLI | [packages/cli/README.md](packages/cli/README.md) |
| Channel: API | [packages/channel-api/README.md](packages/channel-api/README.md) |
| Channel: Chat | [packages/channel-chat/README.md](packages/channel-chat/README.md) |
| Channel: Discord | [packages/channel-discord/README.md](packages/channel-discord/README.md) |
| Registry | [registry/README.md](registry/README.md) |
| Scripts | [scripts/README.md](scripts/README.md) |
| Docs index | [docs/README.md](docs/README.md) |

## License

See [MPL-2.0](LICENSE).
