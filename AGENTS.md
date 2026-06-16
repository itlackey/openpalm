# AGENTS.md — OpenPalm

> **CRITICAL:** All work must comply with [`docs/technical/core-principles.md`](docs/technical/core-principles.md).
> That document is the **authoritative source of architectural rules** for this project.
> No implementation may violate its Core Goals, Security Invariants, or Filesystem Contract.
> **IT IS VERY IMPORTANT THAT YOU AVOID AND/OR REMOVE ALL COMPLEXITY THAT YOU CANNOT PROPERLY JUSTIFY. ALWAYS CALLOUT ANY COMPLEXITY THAT YOU FIND AND CANNOT JUSTIFY**

---

## Project Overview

OpenPalm is a self-hosted personal AI platform built on Docker Compose and OpenCode. It manages a stack of containers orchestrated by the host CLI or an optional admin web UI.

Two core containers: **guardian** (principal-authenticated ingress + optional content validation) and **assistant** (OpenCode runtime — also hosts the scheduler co-process and uses the akm CLI for memory/skills/lessons via a shared akm stash). Portal-style ingress addons (chat/api, Discord, Slack) and services (Ollama, etc.) are added as compose overlays.

Repo layout convention:
- `packages/*` — app/package source workspaces
- `containers/*` — container/runtime assembly assets and image build contexts

```
CLI (host)            ->  Docker Compose (lifecycle)    <- primary orchestrator
Admin UI / Assistant  ->  Admin API  ->  Docker Compose  <- optional web orchestrator
External clients      ->  Portal     ->  Guardian (/oc proxy)      ->  Assistant
```

See [`docs/technical/core-principles.md`](docs/technical/core-principles.md) for the filesystem/volume-mount contract.

---

## Architecture

- **Lib** (`packages/lib/`) — Shared control-plane library (`@openpalm/lib`). All portable lifecycle, staging, secrets, portal discovery, connections, scheduler logic. Both CLI and UI import from this package.
- **CLI** (`packages/cli/`) — Host-side orchestrator. Manages Docker Compose directly. Serves setup wizard during install. Self-sufficient without UI.
- **UI** (`packages/ui/`) — SvelteKit app: operator web UI + API. Served as a host process by `openpalm ui serve` (no container). Accesses Docker socket directly on the host.
- **Guardian** (`containers/guardian/`) — Bun HTTP server: principal auth, allowlisted `/oc/*` proxying, ownership checks, rate limiting, and opt-in fail-closed content validation of inbound messages (`GUARDIAN_CONTENT_VALIDATION`, off by default).
- **Assistant** (`containers/assistant/`) — OpenCode runtime with tools/skills. No Docker socket and no admin network path. When UI is absent, only the akm-backed memory/knowledge tools are available. Memory/skills/lessons are served by the akm CLI (akm-opencode plugin) via a shared akm stash bind-mounted from `~/.openpalm/knowledge/`.
- **Scheduler** — OS cron daemon (`crond`) started by the assistant container entrypoint. No network port. Automations are AKM YAML task files (`*.yml`) in `knowledge/tasks/`; `akm tasks sync` registers them with cron at container startup and re-syncs every 60 s to pick up new files.
- **Portal runtime** (`containers/portal/`) — Unified `portal` image build for baked first-party adapters.
- **Portal adapters** (`portals/discord/`, `portals/slack/`) — Translate external protocols into guardian `/oc/*` traffic. The OpenAI-compatible API now runs from the guardian image.
- **Stack** (`.openpalm/config/stack/`) — Repo-shipped Docker Compose foundation. Contains core, services, portals, and custom compose files. Enabled first-party addons are tracked in `~/.openpalm/knowledge/env/stack.env` via `OP_ENABLED_ADDONS` and resolved to Compose `--profile addon.<name>` arguments; custom services go in `custom.compose.yml`.

---

## Commands

### Development

```bash
# UI (SvelteKit UI + API)
cd packages/ui && npm install && npm run dev     # Dev server on :8100
npm run build                                       # Production build
npm run check                                       # svelte-check + TypeScript

# Guardian (Bun)
cd containers/guardian && bun install && bun run src/server.ts

# Root shortcuts
bun run ui:dev     # Runs UI dev from root
bun run ui:build   # Builds UI from root
bun run ui:check   # svelte-check + TypeScript for UI
bun run guardian:dev     # Runs guardian server
bun run guardian:api:dev    # Runs guardian OpenAI-compatible API server
bun run portal:discord:dev # Runs discord portal dev server
bun run portal:slack:dev   # Runs slack portal dev server

# Dev environment setup
./scripts/dev-setup.sh --seed-env       # Creates .dev/ dirs, seeds configs

# Setup wizard (dev)
bun run wizard:dev                      # Runs install --no-start --force with OP_HOME=.dev
```

### Type Checking

```bash
cd packages/ui && npm run check
# or from root:
bun run check            # Runs ui:check
```

### Tests

The project has ~100 test files across all packages using Bun test, Vitest, and Playwright.

| Runner | Command | Scope |
|--------|---------|-------|
| `bun test` (root) | `bun run test` | guardian, cli, all portal packages (excludes ui) |
| `bun test` (guardian) | `bun run guardian:test` | containers/guardian security tests |
| `bun test` (cli) | `bun run cli:test` | packages/cli tests |
| Vitest (UI) | `bun run ui:test:unit` | packages/ui unit + browser component tests |
| Playwright (UI integration) | `bun run ui:test:e2e` | packages/ui integration tests (no browser route mocks) |
| Playwright (UI mocked) | `bun run ui:test:e2e:mocked` | packages/ui mocked browser contract tests |
| Both UI | `bun run ui:test` | Vitest then Playwright (requires running build) |
| Playwright (stack) | `bun run ui:test:stack` | Stack-dependent integration tests (needs running stack + ADMIN_TOKEN) |
| Playwright (LLM) | `bun run ui:test:llm` | LLM-dependent pipeline tests (needs stack + ADMIN_TOKEN + API keys) |

```bash
# Run guardian tests
cd containers/guardian && bun test

# Run a single test file
cd containers/guardian && bun test src/server.test.ts

# Run UI unit tests (Vitest, CI-friendly)
bun run ui:test:unit

# Run all non-UI tests
bun run test

# Stack integration tests (requires running compose stack)
RUN_DOCKER_STACK_TESTS=1 ADMIN_TOKEN=dev-admin-token bun run ui:test:e2e
```

> **Important:** Always use `bun run ui:test:e2e` (not `npx playwright test` directly) to avoid Playwright version conflicts.

### Docker

```bash
# Dev stack (build from source)
bun run dev:build

# Dev stack (pull images)
bun run dev:stack

# Manual equivalent with portal overlay:
docker compose --project-directory . \
  -f .openpalm/config/stack/core.compose.yml \
  -f compose.dev.yml \
  --env-file .dev/knowledge/env/stack.env \
  up --build -d
```

---

## Rules and Principles Documents

Read these before making significant changes. They are the authoritative sources for their domains.

| Document | Scope |
|---|---|
| [`docs/technical/core-principles.md`](docs/technical/core-principles.md) | Architectural rules, security invariants, filesystem contract |
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
- **Bun** for guardian, portals, and the scheduler co-process; **Node/Vite** for admin (SvelteKit + `adapter-node`)
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
- **`config/` is user-owned.** Automatic lifecycle operations are non-destructive for existing user files and only seed missing defaults. Allowed writers: user direct edits, explicit UI/API config actions, assistant calls through authenticated admin APIs on user request.
- **Secret boundary.** `knowledge/env/stack.env` is non-secret runtime configuration only. Secret values live as files under `knowledge/secrets/` and are granted per service through Compose `secrets:`. `knowledge/env/user.env` is AKM env backing state, not a Compose env file.
- **Host CLI or UI is the orchestrator.** CLI manages Docker Compose directly on the host. UI provides a web UI as a host process (no container, no docker-socket-proxy).
- **Shared control-plane library (`@openpalm/lib`) is the single source of truth.** All portable control-plane logic lives in `packages/lib/`. CLI and UI both import from this package. Never duplicate control-plane logic in a consumer.
- **Guardian-only ingress.** All portal traffic must enter through the guardian (`/oc/*` proxy, ownership checks, rate limiting).
- **Assistant isolation.** Assistant has no Docker socket and no admin network path. When UI is absent, only the akm-backed memory/knowledge tools are available.
- **LAN-first by default.** Nothing is publicly exposed without explicit user opt-in.
- **Add a portal** by enabling its first-party addon name in `~/.openpalm/knowledge/env/stack.env` or adding a service block to `custom.compose.yml` (for custom portals) — no code changes.
- **No shell interpolation.** Docker commands use `execFile` with argument arrays, never shell strings.
- **Docker dependency resolution pattern.** Guardian and portal Dockerfiles install each service's own deps directly. UI is a host binary — no Docker build needed.

---

## Filesystem Contract

All state lives under `~/.openpalm/` (configurable via `OP_HOME`):

| Directory | Owner | Purpose |
|-----------|-------|---------|
| `config/` | User | Non-secret config: assistant + guardian OpenCode config (`config/assistant/`, `config/guardian/`) |
| `knowledge/env/` | User | User-managed secrets: `user.env` (LLM keys, owner info) |
| `config/stack/` | Admin | System-managed compose files and runtime assembly |
| `knowledge/` | User/Services | AKM knowledge (skills, env, secrets, agents); `knowledge/tasks/` holds scheduled automation task files |
| `data/` | Services/System | Persistent data: assistant, guardian, akm, logs, backups, rollback |
| `data/akm/cache/` | Services/System | AKM cache and task logs |
| `data/akm/data/` | Services/System | AKM databases and durable data |
| `~/.cache/openpalm/` | System | Ephemeral cache |

Dev mode uses `.dev/` with the same subdirectory structure.

---

## Delivery Checklist

Before submitting any change:

- [ ] `cd packages/ui && npm run check` passes (UI type correctness)
- [ ] `cd containers/guardian && bun test` passes (security-critical branches covered)
- [ ] No new dependency duplicates a built-in Bun/platform capability
- [ ] Filesystem, guardian ingress, and assistant-isolation rules in `docs/technical/core-principles.md` remain intact
- [ ] Errors and logs are structured and include request identifiers where available
- [ ] No secrets leak through client bundles or logs
- [ ] Docker builds follow the dependency resolution pattern (no symlink-based node_modules, portal deps installed after COPY)
- [ ] Control-plane logic lives in `packages/lib/`, not duplicated in CLI or UI

---

## Key Files

| Path | Purpose |
|---|---|
| `docs/technical/core-principles.md` | **Authoritative architectural rules** |
| `docs/technical/code-quality-principles.md` | Engineering invariants and quality contracts |
| `docs/technical/bunjs-rules.md` | Bun built-in API rules |
| `docs/technical/sveltekit-rules.md` | SvelteKit-specific implementation rules |
| `packages/lib/src/index.ts` | **Shared control-plane library** (`@openpalm/lib`) barrel export |
| `packages/lib/src/control-plane/lifecycle.ts` | State factory, lifecycle transitions (install/update/uninstall) |
| `packages/lib/src/control-plane/config-persistence.ts` | Runtime file writing (compose, env, secrets) |
| `packages/lib/src/control-plane/types.ts` | CORE_SERVICES, OPTIONAL_SERVICES, ControlPlaneState |
| `packages/ui/src/lib/server/docker.ts` | Docker compose wrapper (re-exports lib with preflight enforcement) |
| `packages/ui/src/lib/server/helpers.ts` | Shared request/response utilities |
| `packages/ui/src/lib/types.ts` | Shared TypeScript types |
| `packages/ui/src/lib/auth.ts` | Auth utilities |
| `packages/ui/src/lib/api.ts` | API call functions |
| `packages/cli/src/lib/cli-state.ts` | CLI state helpers (ensureValidState) |
| `packages/cli/src/commands/install.ts` | CLI install (setup wizard + compose up) |
| `containers/guardian/src/server.ts` | HMAC-signed message guardian |
| `containers/guardian/src/logger.ts` | Guardian-local logger (createLogger factory) |
| `.openpalm/config/stack/core.compose.yml` | Core service definitions (assistant + guardian) |
| `.openpalm/config/stack/` | Fixed stack compose files and enabled-addon state |
| `.opencode/opencode.json` | OpenCode project configuration |
