# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenPalm is a self-hosted multi-channel AI assistant platform. It connects communication channels (Discord, Telegram, Voice, Chat, Webhook) through a security gateway to an OpenCode agent runtime, with long-term memory via OpenMemory. All services run as Docker containers orchestrated by Docker Compose, fronted by a Caddy reverse proxy.

**Core principle**: Simplicity in UX, DX, and architecture. The tools (CLI, Admin) manage configuration for known technologies — take a simple spec and convert it to config and filesystem resources.

## Build & Development Commands

```bash
# Setup and run
bun run dev:setup          # Create .env, seed .dev/ directories
bun run dev:build          # Build images and start the stack
bun run dev:up             # Start without rebuilding
bun run dev:down           # Stop containers
bun run dev:restart        # Restart (append -- <service> for one service)
bun run dev:logs           # Tail logs (append -- <service> to filter)
bun run dev:ps             # Container status
bun run dev:fresh          # Full clean rebuild from scratch
bun run dev:setup:clean    # Wipe .dev/ and .env, re-seed

# Type checking
bun run typecheck

# Tests (5 layers)
bun test                          # All tests
bun run test:unit                 # Unit only
bun test --filter integration     # Integration only
bun test --filter contract        # Contract tests
bun test --filter security        # Security tests
bun run test:ui                   # Playwright E2E (or: cd admin && npx playwright test)

# Single test file
bun test gateway/src/channel-intake.test.ts

# Tests matching a pattern
bun test --match "channel intake"

# Workspace tests
cd gateway && bun test
cd admin && bun test

# Workflow tests (requires: act — https://github.com/nektos/act)
bun run test:workflows             # Test all GitHub Actions workflows locally
./dev/test-workflows.sh --list     # List available workflows
./dev/test-workflows.sh test       # Test a single workflow
./dev/test-workflows.sh --dry-run  # Validate workflow YAML only
```

## Pre-push Checklist

Before pushing to the remote, ensure all local tests and workflow tests pass:

```bash
bun run typecheck                  # Type-check all workspaces
bun test                           # Run all unit/integration/contract/security tests
bun run test:workflows             # Verify all GitHub Actions workflows locally
```

## Architecture

```
Channels (Discord/Telegram/Voice/Chat/Webhook)
  ↓ HMAC-signed requests
Caddy reverse proxy (:80/:443, LAN-restricted)
  ↓
Gateway (security: HMAC verify → rate limit → intake validation → audit)
  ↓
Assistant/OpenCode (agent runtime with extensions and OpenMemory integration)
  ↓
OpenMemory (MCP server + Qdrant vector DB + PostgreSQL)

Admin (control plane: UI, API, Docker Compose lifecycle, cron automations)
```

**Network rules**: Channels talk only to Gateway — never directly to Assistant, Admin, or OpenMemory. Admin/Assistant/OpenMemory are LAN-only (Caddy IP restrictions).

**Five core concepts**: Extensions (capabilities added to assistant), Connections (credential sets), Channels (platform adapters), Automations (cron-scheduled prompts), Gateway (security/routing layer).

## Monorepo Structure

Bun workspaces: `gateway`, `admin`, `channels/{chat,discord,voice,telegram,webhook}`, `packages/lib`, `packages/cli`, `packages/ui`.

| Directory | Purpose |
|-----------|---------|
| `admin/` | Control-plane service (legacy Bun server in src/, being replaced by packages/ui/) |
| `gateway/` | Security layer (HMAC, rate limiting, intake validation, audit) |
| `assistant/` | OpenCode agent runtime with built-in extensions |
| `channels/` | Channel adapter services |
| `packages/lib/` | Shared library (`@openpalm/lib`) used by all services |
| `packages/cli/` | CLI tool (installer, management commands) |
| `packages/ui/` | SvelteKit admin UI (admin UI implementation) |
| `assets/` | Docker Compose base, Caddy config, install scripts |
| `dev/` | Dev utilities, setup scripts, dev compose overlay |
| `test/` | Cross-service tests (integration, contract, security) |
| `docs/` | User-facing documentation |

## Compose Layer Stacking

Two compose files are layered; `--project-directory .` is required so paths resolve from repo root:
1. `packages/lib/src/embedded/state/docker-compose.yml` — production base
2. `dev/docker-compose.dev.yml` — dev overlay (local builds from source)

The `dev:*` scripts handle this automatically.

## XDG Directory Layout (.dev/)

```
.dev/
├── config/    (OPENPALM_CONFIG_HOME) — secrets.env, channel envs, caddy, opencode.jsonc
├── data/      (OPENPALM_DATA_HOME)   — postgres, qdrant, openmemory, admin, assistant
└── state/     (OPENPALM_STATE_HOME)  — runtime artifacts, state envs
```

Delete `.dev/data/setup-state.json` to reset the admin wizard to first-boot state.

## Code Conventions

- **Runtime**: Bun with ES modules (`"type": "module"`)
- **TypeScript**: Strict mode, target ES2022, module ESNext, bundler resolution
- **No linter/formatter configured** — follow existing patterns
- **Path aliases**: `@openpalm/lib`, `@openpalm/lib/*`, `@openpalm/lib/assets/*`
- **File names**: kebab-case (`channel-intake.ts`)
- **Imports**: Use `import type` for type-only imports; use full `.ts` extensions in relative paths
- **Env vars**: Access via `Bun.env` with defaults: `const PORT = Number(Bun.env.PORT ?? 8090);`
- **Error codes**: snake_case strings (`"missing_summary_for_valid_intake"`)
- **Catch clauses**: Use `unknown`, then narrow with type guards
- **Tests**: `bun:test` framework with `describe`/`it`/`expect`

## Playwright E2E Tests

Located in `packages/ui/e2e/`. Config at `packages/ui/playwright.config.ts`.

## Dev Access URLs

- Admin UI: `http://localhost/`
- OpenCode UI: `http://localhost/opencode/`
- OpenMemory UI: `http://localhost:3000/`
- Admin API (direct): `http://localhost:8100/`

## Documentation Map

<!-- Last verified: 2026-02-22 -->

| Question | Location |
|----------|----------|
| Message flow / container layout | `dev/docs/architecture.md` |
| API endpoints (gateway, admin, channels) | `dev/docs/api-reference.md` |
| Security model | `docs/security.md` |
| Backup, restore, upgrade | `docs/maintenance.md` |
| Troubleshooting | `docs/troubleshooting.md` |
| Host paths and XDG layout | `docs/host-system-reference.md` |
| Stack generation spec | `packages/lib/docs/specification.md` |
| Channel setup | `channels/<name>/README.md` |
| Versioning and releases | `dev/docs/versioning.md` |
| Testing strategy | `dev/docs/testing-plan.md` |
| Contributor checklist | `dev/docs/contributor-checklist.md` |
