# AGENTS.md — OpenPalm

> **CRITICAL:** All work must comply with [`docs/technical/core-principles.md`](docs/technical/core-principles.md).
> That document is the **authoritative source of architectural rules** for this project.
> No implementation may violate its Core Goals, Security Invariants, or Filesystem Contract.
> **IT IS VERY IMPORTANT THAT YOU AVOID AND/OR REMOVE ALL COMPLEXITY THAT YOU CANNOT PROPERLY JUSTIFY. ALWAYS CALLOUT ANY COMPLEXITY THAT YOU FIND AND CANNOT JUSTIFY**

---

## Project Overview

OpenPalm is a self-hosted personal AI platform built on Docker Compose and OpenCode. It manages a stack of containers orchestrated by the host CLI or an optional admin web UI.

Four core containers: **guardian** (HMAC ingress), **assistant** (OpenCode runtime), **memory** (vector-backed agentic memory), **scheduler** (cron/automations). Channels (chat, API, Discord, Slack, voice) and services (Ollama, etc.) are added as addon compose overlays.

Repo layout convention:
- `packages/*` — app/package source workspaces
- `core/*` — container/runtime assembly assets and image build contexts

```
CLI (host)            ->  Docker Compose (lifecycle)    <- primary orchestrator
Admin UI / Assistant  ->  Admin API  ->  Docker Compose  <- optional web orchestrator
External clients      ->  Channel    ->  Guardian (HMAC/validate)  ->  Assistant
```

See [`docs/technical/core-principles.md`](docs/technical/core-principles.md) for the filesystem/volume-mount contract.

---

## Architecture

- **Lib** (`packages/lib/`) — Shared control-plane library (`@openpalm/lib`). All portable lifecycle, staging, secrets, channels, connections, scheduler logic. Both CLI and admin import from this package.
- **CLI** (`packages/cli/`) — Host-side orchestrator. Manages Docker Compose directly. Serves setup wizard during install. Self-sufficient without admin.
- **Admin** (`packages/admin/`) — SvelteKit app: optional operator web UI + API. Uses Docker socket via docker-socket-proxy. Behind `profiles: ["admin"]` compose profile.
- **Guardian** (`core/guardian/`) — Bun HTTP server: HMAC verification, replay detection, rate limiting for all channel traffic.
- **Assistant** (`core/assistant/`) — OpenCode runtime with tools/skills. No Docker socket. When admin is present, calls Admin API for stack operations.
- **Memory** (`packages/memory/`, `core/memory/`) — Bun-based memory service with sqlite-vec. Provides vector-backed agentic memory.
- **Scheduler** (`packages/scheduler/`) — Lightweight Bun sidecar: sole automation engine. Runs cron jobs (http, shell, assistant, api actions). Reads from `config/automations/`.
- **Channel runtime** (`core/channel/`) — Unified `channel` image build and startup entrypoint.
- **Channel adapters** (`packages/channel-chat/`, `packages/channel-api/`, `packages/channel-discord/`, `packages/channel-slack/`, `packages/channel-voice/`) — Translate external protocols into signed guardian messages.
- **Channels SDK** (`packages/channels-sdk/`) — Shared SDK for channel adapters: signing, assistant client, base classes.
- **Assistant-tools** (`packages/assistant-tools/`) — Memory tools and session hooks for the assistant. No admin dependency.
- **Admin-tools** (`packages/admin-tools/`) — Admin API tools for the assistant. Only loaded when admin is present.
- **Stack** (`.openpalm/stack/`) — Self-contained Docker Compose foundation. Core compose, addons, automations, schemas. Consumed by CLI (from `data/`) and admin (from Vite bundle).

---

## Commands

### Development

```bash
# Admin (SvelteKit admin + API)
cd packages/admin && npm install && npm run dev     # Dev server on :8100
npm run build                                       # Production build
npm run check                                       # svelte-check + TypeScript

# Guardian (Bun)
cd core/guardian && bun install && bun run src/server.ts

# Channel Chat (Bun)
cd packages/channel-chat && bun install && bun run src/index.ts

# Root shortcuts
bun run admin:dev        # Runs admin dev from root
bun run admin:build      # Builds admin from root
bun run admin:check      # svelte-check + TypeScript for admin
bun run guardian:dev     # Runs guardian server
bun run channel:chat:dev    # Runs chat channel dev server
bun run channel:api:dev     # Runs api channel dev server
bun run channel:discord:dev # Runs discord channel dev server

# Dev environment setup
./scripts/dev-setup.sh --seed-env       # Creates .dev/ dirs, seeds configs

# Setup wizard (dev)
bun run wizard:dev                      # Runs install --no-start --force with OP_HOME=.dev
```

### Type Checking

```bash
cd packages/admin && npm run check
# or from root:
bun run check            # Runs admin:check + sdk:test
```

### Tests

The project has ~100 test files across all packages using Bun test, Vitest, and Playwright.

| Runner | Command | Scope |
|--------|---------|-------|
| `bun test` (root) | `bun run test` | channels-sdk, guardian, cli, all channel packages (excludes admin) |
| `bun test` (sdk) | `bun run sdk:test` | packages/channels-sdk unit tests |
| `bun test` (guardian) | `bun run guardian:test` | core/guardian security tests |
| `bun test` (cli) | `bun run cli:test` | packages/cli tests |
| Vitest (admin) | `bun run admin:test:unit` | packages/admin unit + browser component tests |
| Playwright (admin integration) | `bun run admin:test:e2e` | packages/admin integration tests (no browser route mocks) |
| Playwright (admin mocked) | `bun run admin:test:e2e:mocked` | packages/admin mocked browser contract tests |
| Both admin | `bun run admin:test` | Vitest then Playwright (requires running build) |
| Playwright (stack) | `bun run admin:test:stack` | Stack-dependent integration tests (needs running stack + ADMIN_TOKEN) |
| Playwright (LLM) | `bun run admin:test:llm` | LLM-dependent pipeline tests (needs stack + ADMIN_TOKEN + API keys) |

```bash
# Run guardian tests
cd core/guardian && bun test

# Run a single test file
cd core/guardian && bun test src/server.test.ts

# Run admin unit tests (Vitest, CI-friendly)
bun run admin:test:unit

# Run all non-admin tests
bun run test

# Stack integration tests (requires running compose stack)
RUN_DOCKER_STACK_TESTS=1 ADMIN_TOKEN=dev-admin-token bun run admin:test:e2e
```

> **Important:** Always use `bun run admin:test:e2e` (not `npx playwright test` directly) to avoid Playwright version conflicts.

### Docker

```bash
# Dev stack (build from source)
bun run dev:build

# Dev stack (pull images)
bun run dev:stack

# Manual equivalent with channel overlay:
docker compose --project-directory . \
  -f .openpalm/stack/core.compose.yml \
  -f compose.dev.yml \
  --env-file .dev/vault/stack/stack.env \
  --env-file .dev/vault/user/user.env \
  up --build -d
```

---

## Rules and Principles Documents

Read these before making significant changes. They are the authoritative sources for their domains.

| Document | Scope |
|---|---|
| [`docs/technical/core-principles.md`](docs/technical/core-principles.md) | Architectural rules, security invariants, filesystem contract |
| [`docs/technical/docker-dependency-resolution.md`](docs/technical/docker-dependency-resolution.md) | Docker build dependency patterns (must follow) |
| [`docs/technical/code-quality-principles.md`](docs/technical/code-quality-principles.md) | Engineering invariants, quality contracts |
| [`docs/technical/bunjs-rules.md`](docs/technical/bunjs-rules.md) | Bun-specific implementation rules, built-in API preference list |
| [`docs/technical/sveltekit-rules.md`](docs/technical/sveltekit-rules.md) | SvelteKit-specific rules, server/client boundaries, routing |
| [`docs/technical/api-spec.md`](docs/technical/api-spec.md) | Full Admin API spec, endpoint contracts, error shapes |
| [`docs/technical/environment-and-mounts.md`](docs/technical/environment-and-mounts.md) | Every env var and mount point per service |
| [`docs/technical/opencode-configuration.md`](docs/technical/opencode-configuration.md) | OpenCode integration, tools, plugins, startup flow |
| [`docs/technical/package-management.md`](docs/technical/package-management.md) | Single lock file policy and dependency workflow |

---

## Code Style

### Language & Runtime

- **TypeScript** everywhere (`"strict": true`, no `any` for untrusted data)
- **Bun** for guardian, channels, memory, and scheduler; **Node/Vite** for admin (SvelteKit + `adapter-node`)
- All packages use `"type": "module"` (ES modules only)

### Imports

- Use **named imports** by default; default imports only for framework/config objects
- Relative imports **must include `.js` extension** (ESM + `verbatimModuleSyntax` requirement)
  ```ts
  import { getState } from "./state.js";
  import type { RequestHandler } from "./$types";
  ```
- Use `import type` for type-only imports
- SvelteKit path aliases: `$lib/`, `$lib/server/`, `$app/environment`
- **Prefer Bun and Web Platform built-ins** before adding third-party dependencies (see `docs/technical/bunjs-rules.md`)

### Naming

| Thing | Convention |
|---|---|
| Files/dirs | `kebab-case` |
| Types/interfaces | `PascalCase` |
| Functions, variables | `camelCase` |
| Constants | `SCREAMING_SNAKE_CASE` |
| HTTP route handlers | `export const GET`, `export const POST` (uppercase verb) |
| Unused params | `_prefixed` |
| CSS classes | `kebab-case` (BEM-light) |

### Types

- Prefer **type aliases** over interfaces for data shapes
- Use `unknown` (not `any`) for external/untrusted data; narrow with type guards or schema validation
- Use **discriminated unions** for operation results:
  ```ts
  type Result = { ok: true; data: T } | { ok: false; error: string };
  ```
- Use `Record<K, V>` for typed plain objects; `as const` for literal narrowing
- Add explicit return types on exported library functions; omit on route handlers

### Error Handling

- **Guard-and-return** (early exit) pattern for auth/validation:
  ```ts
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;
  ```
- Structured error responses via `errorResponse()` helper (`$lib/server/helpers.ts`)
- **Fail closed** on auth/signature/timestamp errors — always return an explicit HTTP error status
- Cast errors with `e instanceof Error ? e.message : e` in user-facing messages

### Formatting

No Prettier or ESLint configured. Match the existing file style:
- 2-space indentation
- Single quotes in JS/TS, double quotes in JSON
- Trailing commas in multi-line arrays/objects

### Module Structure

- `+server.ts` route handlers perform transport concerns only; business logic lives in `$lib/server/*`
- Bun service entrypoints: parse request -> validate/auth -> call domain logic -> return structured response
- No hidden global state; shared state must be explicit, typed, and owned by a clear module
- Keep files small and single-responsibility

---

## Architecture Rules (summary)

Full detail in [`docs/technical/core-principles.md`](docs/technical/core-principles.md).

- **File assembly, not rendering.** Write whole files; no string interpolation or template generation.
- **`config/` is user-owned.** Automatic lifecycle operations are non-destructive for existing user files and only seed missing defaults. Allowed writers: user direct edits, explicit admin UI/API config actions, assistant calls through authenticated admin APIs on user request.
- **`vault/` boundary.** Only admin mounts full `vault/` (rw). Assistant mounts `vault/user/` (rw). No other container mounts anything from vault. Guardian loads `vault/stack/guardian.env` as env_file (channel HMAC secrets with hot-reload).
- **Host CLI or admin is the orchestrator.** CLI manages Docker Compose directly on the host. Admin (optional) provides a web UI via docker-socket-proxy.
- **Shared control-plane library (`@openpalm/lib`) is the single source of truth.** All portable control-plane logic lives in `packages/lib/`. CLI, admin, and scheduler all import from this package. Never duplicate control-plane logic in a consumer.
- **Guardian-only ingress.** All channel traffic must enter through the guardian (HMAC, replay protection, rate limiting).
- **Assistant isolation.** Assistant has no Docker socket. When admin is present, it calls the admin API. When admin is absent, only memory tools are available.
- **LAN-first by default.** Nothing is publicly exposed without explicit user opt-in.
- **Add a channel** by installing from the registry or dropping an addon compose file into `stack/addons/<name>/` — no code changes.
- **No shell interpolation.** Docker commands use `execFile` with argument arrays, never shell strings.
- **Docker dependency resolution pattern is mandatory.** Admin uses plain `npm install` (no Bun in Docker). Guardian and channel Dockerfiles install `packages/channels-sdk` deps with `bun install --production` after copying sdk source. See [`docs/technical/docker-dependency-resolution.md`](docs/technical/docker-dependency-resolution.md).

---

## Filesystem Contract

All state lives under `~/.openpalm/` (configurable via `OP_HOME`):

| Directory | Owner | Purpose |
|-----------|-------|---------|
| `config/` | User | Non-secret config: stack.yml, automations, assistant extensions |
| `vault/user/` | User | User-managed secrets: `user.env` (LLM keys, owner info) |
| `vault/stack/` | Admin | System-managed secrets: `stack.env` (admin token, HMAC, paths) |
| `stack/` | System | Live Docker Compose assembly: `core.compose.yml` + addon overlays |
| `data/` | Services | Persistent data: assistant, admin, memory, guardian |
| `logs/` | Services | Audit and debug logs |
| `backups/` | System | Durable upgrade backup snapshots |
| `~/.cache/openpalm/` | System | Ephemeral: rollback snapshots |

Dev mode uses `.dev/` with the same subdirectory structure.

---

## Delivery Checklist

Before submitting any change:

- [ ] `cd packages/admin && npm run check` passes (UI type correctness)
- [ ] `cd core/guardian && bun test` passes (security-critical branches covered)
- [ ] No new dependency duplicates a built-in Bun/platform capability
- [ ] Filesystem, guardian ingress, and assistant-isolation rules in `docs/technical/core-principles.md` remain intact
- [ ] Errors and logs are structured and include request identifiers where available
- [ ] No secrets leak through client bundles or logs
- [ ] Docker builds follow the dependency resolution pattern in `docs/technical/docker-dependency-resolution.md`
- [ ] Control-plane logic lives in `packages/lib/`, not duplicated in CLI or admin

---

## Key Files

| Path | Purpose |
|---|---|
| `docs/technical/core-principles.md` | **Authoritative architectural rules** |
| `docs/technical/docker-dependency-resolution.md` | **Docker build dependency patterns** |
| `docs/technical/code-quality-principles.md` | Engineering invariants and quality contracts |
| `docs/technical/bunjs-rules.md` | Bun built-in API rules |
| `docs/technical/sveltekit-rules.md` | SvelteKit-specific implementation rules |
| `packages/lib/src/index.ts` | **Shared control-plane library** (`@openpalm/lib`) barrel export |
| `packages/lib/src/control-plane/lifecycle.ts` | State factory, lifecycle transitions (install/update/uninstall) |
| `packages/lib/src/control-plane/config-persistence.ts` | Runtime file writing (compose, env, secrets) |
| `packages/lib/src/control-plane/types.ts` | CORE_SERVICES, OPTIONAL_SERVICES, ControlPlaneState |
| `packages/admin/src/lib/server/docker.ts` | Docker compose wrapper (re-exports lib with preflight enforcement) |
| `packages/admin/src/lib/server/helpers.ts` | Shared request/response utilities |
| `packages/admin/src/lib/types.ts` | Shared TypeScript types |
| `packages/admin/src/lib/auth.ts` | Auth utilities |
| `packages/admin/src/lib/api.ts` | API call functions |
| `packages/cli/src/lib/cli-state.ts` | CLI state helpers (ensureValidState) |
| `packages/cli/src/commands/install.ts` | CLI install (setup wizard + compose up) |
| `packages/scheduler/src/server.ts` | Scheduler sidecar entry point |
| `core/guardian/src/server.ts` | HMAC-signed message guardian |
| `packages/channels-sdk/src/logger.ts` | Shared logger (createLogger factory) |
| `.openpalm/stack/core.compose.yml` | Core service definitions (4 services) |
| `.openpalm/stack/addons/` | Optional add-on compose overlays (admin, chat, discord, etc.) |
| `packages/assistant-tools/AGENTS.md` | Assistant persona and operational guidelines |
| `packages/assistant-tools/src/index.ts` | Memory tools plugin |
| `packages/admin-tools/src/index.ts` | Admin tools plugin |
| `.opencode/opencode.json` | OpenCode project configuration |
