# docs

Documentation index for OpenPalm.

Repo layout convention:
- `packages/*` contains app/package source code.
- `containers/*` contains container/runtime assembly assets and Docker build contexts.

## Getting started

| Document | Description |
|---|---|
| [CONTRIBUTING.md](../.github/CONTRIBUTING.md) | **Dev environment cheatsheet** — clone, bootstrap, run, test |
| [system-requirements.md](system-requirements.md) | CPU, RAM, disk, network — minimum and recommended specs |
| [setup-guide.md](setup-guide.md) | Installation, updating, troubleshooting |
| [troubleshooting.md](troubleshooting.md) | Top 10 common problems and solutions |
| [manual-compose-runbook.md](operations/manual-compose-runbook.md) | Step-by-step manual host configuration (no scripts) |
| [how-it-works.md](how-it-works.md) | Architecture overview and data flow |
| [managing-openpalm.md](managing-openpalm.md) | Configuration, portals, secrets, access control, automations |
| [theming.md](theming.md) | UI theming — Stillness tokens today; edit `config/ui/theme.css` to re-theme (0.14.0, #426) |
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
| [release-management.md](operations/release-management.md) | Authoritative release guide: platform release boundaries, image/package versioning, and beta→stable cutover |
| [release-rc-runbook.md](operations/release-rc-runbook.md) | Ordered RC release procedure with merge gates, commands, evidence capture, and post-publish verification |
| [unit-all-rc-checklist.md](operations/unit-all-rc-checklist.md) | Coordinated `unit=all` release-candidate worksheet with commands, pass criteria, and evidence capture |
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
| [code-quality-principles.md](technical/code-quality-principles.md) | All code |
| [bunjs-rules.md](technical/bunjs-rules.md) | Guardian and portal-side Bun services |
| [sveltekit-rules.md](technical/sveltekit-rules.md) | Admin UI (`packages/ui/`) |

## Release notes

| Document | Description |
|---|---|
| [CHANGELOG.md](../CHANGELOG.md) | Version history in Keep a Changelog format |

## Reference

| Document | Description |
|---|---|
| [api-spec.md](technical/api-spec.md) | Admin API endpoint contract |
| [backup-restore.md](backup-restore.md) | Backup, restore, and migration procedures |
| [environment-and-mounts.md](technical/environment-and-mounts.md) | All env vars and volume mounts |
| [opencode-configuration.md](technical/opencode-configuration.md) | OpenCode runtime integration |
| [community-portals.md](portals/community-portals.md) | Guardian `/oc/*` contract for custom portal adapters |
