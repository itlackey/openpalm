# docs

Documentation index for OpenPalm.

Repo layout convention:
- `packages/*` contains app/package source code.
- `containers/*` contains container/runtime assembly assets and Docker build contexts.

## Glossary

Quick definitions for terms used throughout these docs, in first-use order you'd
meet them:

| Term | Meaning |
|---|---|
| **Harness** | The host-side manager (CLI binary or Electron app) that seeds `OP_HOME`, controls Docker Compose, and serves the admin UI. |
| **Stack** | The Docker Compose services the harness runs: the always-on assistant, the profile-gated Guardian, and addons. |
| **Principal** | An authenticated identity Guardian issues credentials to — a portal, a bot, or a direct client — not an end user behind a portal. |
| **Guardian** | The profile-gated proxy in front of portals and direct/API clients. Authenticates principals, enforces ownership and rate limits, and screens content before forwarding to the assistant. |
| **Portal** | A protocol adapter (Discord, Slack, web chat) that turns its native protocol into authenticated Guardian requests. |
| **Addon** | An optional, profile-gated Compose service (Voice, Discord, Slack, Ollama, etc.), enabled through `OP_ENABLED_ADDONS`. |
| **AKM** | The assistant's persistent memory and knowledge-stash layer (skills, lessons, embeddings) — a separate open-source project ([itlackey/akm](https://github.com/itlackey/akm)) the assistant container uses through the `akm` CLI. |
| `OP_HOME` | The single host directory (default `~/.openpalm/`) holding all OpenPalm state. |

See [How It Works](how-it-works.md) for the full architecture behind these terms.

## Getting started

| Document | Description |
|---|---|
| [CONTRIBUTING.md](../.github/CONTRIBUTING.md) | **Dev environment cheatsheet** — clone, bootstrap, run, test |
| [system-requirements.md](system-requirements.md) | CPU, RAM, disk, network — minimum and recommended specs |
| [setup-guide.md](setup-guide.md) | Installation, updating, troubleshooting |
| [troubleshooting.md](troubleshooting.md) | Common problems and solutions |
| [manual-compose-runbook.md](operations/manual-compose-runbook.md) | Step-by-step manual host configuration (no scripts) |
| [how-it-works.md](how-it-works.md) | Architecture overview and data flow |
| [managing-openpalm.md](managing-openpalm.md) | Configuration, portals, secrets, access control, automations |
| [theming.md](theming.md) | UI theming — Stillness tokens today; the editable `config/ui/theme.css` workflow is planned for 0.14.0 (#426) |
| [discord-setup.md](portals/discord-setup.md) | Discord bot setup — create app, install portal addon, invite bot |
| [slack-setup.md](portals/slack-setup.md) | Slack bot setup — create app, install portal addon, configure Socket Mode |

## Upgrade & migration

| Document | Description |
|---|---|
| [upgrade-0.10-to-0.11.md](operations/upgrade-0.10-to-0.11.md) | **Start here to upgrade from 0.10.x** — ordered procedure, old→new file/env/port mapping, troubleshooting |
| [secrets-env-migration.md](operations/secrets-env-migration.md) | Detailed secrets/env file-move reference (also covers 0.11.0 beta layouts) |

## Operations

| Document | Description |
|---|---|
| [release.md](operations/release.md) | The product release: architecture, dry-run/live commands, checklist, and the independent extensions workflow |
| [manual-compose-runbook.md](operations/manual-compose-runbook.md) | Step-by-step manual host configuration (no scripts) |
| [manual-headless-install.md](operations/manual-headless-install.md) | Hand-built install disk contract (tokens, auth.json, setup stamp) + scripted `openpalm install --file` |
| [diagnostic-playbook.md](operations/diagnostic-playbook.md) | Layer-by-layer debugging workflow for UI, admin API, OpenCode, and container/config issues |
| [persistent-assistant-tools.md](operations/persistent-assistant-tools.md) | How to keep assistant-installed tools across recreates and upgrades |

## Architecture (must-read for contributors)

| Document | Description |
|---|---|
| [core-principles.md](technical/core-principles.md) | **Authoritative.** Core goals, security invariants, filesystem + volume-mount contracts |
| [foundations.md](technical/foundations.md) | Stripped-down runtime contract for env, filesystem, mounts, and networks |

## Implementation rules

| Document | Applies to |
|---|---|
| [adding-an-addon.md](technical/adding-an-addon.md) | **Read before adding a stack service.** Build-vs-pull, the touch-point checklist, and the traps |
| [code-quality-principles.md](technical/code-quality-principles.md) | All code |
| [bunjs-rules.md](technical/bunjs-rules.md) | Guardian and portal-side Bun services |
| [sveltekit-rules.md](technical/sveltekit-rules.md) | Admin UI (`packages/ui/`) |
| [ui-styling-unification.md](technical/ui-styling-unification.md) | UI styling — verified drift inventory + refactor plan to the unified token/component system (`packages/ui/src/lib/`) |

## Reviews & analysis

Point-in-time deep dives. Each is stamped with the revision it reviewed and is
not kept current as the code moves.

| Document | Description |
|---|---|
| [onboarding-setup-review.md](reviews/onboarding-setup-review.md) | End-to-end review of the new-user journey: discovery, install, setup wizard, first deploy, first chat |
| [paperclip-integration-analysis.md](reviews/paperclip-integration-analysis.md) | OpenPalm vs [Paperclip](https://github.com/paperclipai/paperclip): overlap, integration seams, and a phased recommendation for the "agents at work" use case |

## Release notes

| Document | Description |
|---|---|
| [CHANGELOG.md](../CHANGELOG.md) | Version history in Keep a Changelog format |

## Reference

| Document | Description |
|---|---|
| [api-spec.md](technical/api-spec.md) | Admin API conventions, security gates, and route-map pointer |
| [backup-restore.md](backup-restore.md) | Backup, restore, and migration procedures |
| [environment-and-mounts.md](technical/environment-and-mounts.md) | All env vars and volume mounts |
| [opencode-configuration.md](technical/opencode-configuration.md) | OpenCode runtime integration |
| [community-portals.md](portals/community-portals.md) | Guardian `/oc/*` contract for custom portal adapters |
| [paperclip-addon-design.md](technical/paperclip-addon-design.md) | Paperclip as a standard loopback-only first-party service addon |
| [remote-provider-contract.md](technical/remote-provider-contract.md) | The `remote` addon's provider-variant contract, with Tailscale as the reference implementation |
