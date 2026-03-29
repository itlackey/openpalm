<img src="packages/admin/static/banner.png" alt="OpenPalm" width="500" />

<p>
  <strong>Your own AI assistant. Private, self-hosted, no hype required.</strong>
</p>

---

## What is this?

OpenPalm started as a hobby project — a weekend experiment to see if a useful AI assistant could be built on boring, standard tools instead of whatever the VC-funded flavor of the month is. Turns out it can. It's now a daily driver, and it keeps getting better.

The idea is simple: you run your own assistant on your own hardware, using Docker Compose and plain files you can actually read. No proprietary orchestration layer, no magic runtime, no lock-in. Just containers, env files, and compose overlays. If you can run `docker compose up`, you can run OpenPalm.

This is the anti-hype alternative. No "autonomous agent swarms." No "AGI-powered workflows." Just a well-structured assistant that stays on your LAN, remembers what you tell it, and does what you ask — built on standards that will still work next year.

## Where things stand

OpenPalm is in active development. It works — I use it every day — but there's a lot of rough edges being sanded down right now:

- **Stabilizing the core** — The assistant, guardian, and memory services are solid, but the install and upgrade lifecycle is still getting hardened.
- **Improving setup** — The setup wizard works, but the goal is a one-command install that just does the right thing on any Docker host.
- **Extending the assistant** — More built-in tools, better memory integration, and first-class support for plugins and automations.


## What you get

- **An AI assistant that's yours** — Runs on [OpenCode](https://opencode.ai), talks to any OpenAI-compatible model (local or remote), and remembers things between sessions.
- **Channels** — Talk to your assistant through a web chat, an API, Discord, Slack, or build your own adapter.
- **Security by default** — Every message passes through HMAC-signed verification, replay detection, and rate limiting before it reaches the assistant. The assistant itself has no Docker socket access.
- **Plain files all the way down** — The stack is Docker Compose files. Config is env files. Addons are compose overlays. No database for state, no hidden config, nothing you can't `cat`.
- **LAN-first** — Nothing is exposed to the internet unless you explicitly choose to expose it.

## Get started

You need Docker with Compose V2 — that's it.

| Platform | Install |
|---|---|
| **Windows** | [Docker Desktop](https://www.docker.com/products/docker-desktop/) |
| **Mac** | [Docker Desktop](https://www.docker.com/products/docker-desktop/) or [OrbStack](https://orbstack.dev/download) |
| **Linux** | `curl -fsSL https://get.docker.com \| sh` |

Then run the install script:

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

This downloads the CLI binary for your platform, seeds your `~/.openpalm/` directory, walks you through a setup wizard, and starts the stack. No cloning, no runtime dependencies beyond Docker.

If you'd rather set things up by hand with raw `docker compose`, see the [setup guide](docs/setup-guide.md).

## Make it yours

- **Swap models** — Point it at OpenAI, Anthropic, Groq, Ollama, LMStudio, or anything OpenAI-compatible.
- **Add channels** — Enable Discord, Slack, API, or web chat by copying an addon into your stack.
- **Extend the assistant** — Drop in OpenCode plugins, custom tools, or let the assistant find what they need with built-in [AKM](https://github.com/itlackey/akm) support.
- **Schedule automations** — Add YAML files to run recurring tasks on a cron schedule.
- **Protect your secrets** — [Varlock](https://varlock.dev) optionally scans for leaks, validates env files, and redacts secrets from assistant output.

## How it works

<div>
<img src="packages/admin/static/fu-128.png" alt="OpenPalm" width="90" style="float: right; shape-margin: 0.25rem;" />
<p>Clients talk to channels. Channels sign messages and send them through the guardian. The guardian validates everything and forwards to the assistant. The assistant does the work. That's it.</p>
</div>

![Architecture](docs/technical/architecture.svg)

For the full walkthrough, see [How It Works](docs/how-it-works.md). For security invariants and architectural rules, see [Core Principles](docs/technical/core-principles.md).

## Documentation

| Guide | What's inside |
|---|---|
| [Setup Guide](docs/setup-guide.md) | Install, update, and troubleshoot |
| [How It Works](docs/how-it-works.md) | Architecture and data flow |
| [Managing OpenPalm](docs/managing-openpalm.md) | Config, addons, secrets, automations |
| [Core Principles](docs/technical/core-principles.md) | Security invariants and design rules |
| [Community Channels](docs/channels/community-channels.md) | Build your own channel adapter |
| [Full docs index](docs/README.md) | Everything else |

## Contributing

OpenPalm is open source under [MPL-2.0](LICENSE). Contributions are welcome — just know that things move fast right now and the architecture is still settling. Check out the [docs index](docs/README.md) to get oriented, and don't hesitate to open an issue if something breaks or doesn't make sense.
