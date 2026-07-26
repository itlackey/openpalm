# AGENTS.md — OpenPalm

> **CRITICAL:** All work must comply with [`docs/technical/core-principles.md`](docs/technical/core-principles.md).
> That document is the **authoritative source of architectural rules** for this project.
> No implementation may violate its Core Goals, Security Invariants, or Filesystem Contract.
> **IT IS VERY IMPORTANT THAT YOU AVOID AND/OR REMOVE ALL COMPLEXITY THAT YOU CANNOT PROPERLY JUSTIFY. ALWAYS CALLOUT ANY COMPLEXITY THAT YOU FIND AND CANNOT JUSTIFY**

---

## Project Overview

OpenPalm is a self-hosted personal AI platform built on Docker Compose and OpenCode. It manages a stack of containers orchestrated by the host CLI or an optional admin web UI.

One always-on core container: **assistant** (OpenCode runtime — also hosts the scheduler co-process and uses the akm CLI for memory/skills/lessons via a shared akm stash). The **guardian** (principal-authenticated ingress + content validation, ON by default in the shipped compose) is not a core container — it is profile-gated in `portals.compose.yml` and is deployed only when a guardian-ingress addon (`chat`, `api`, `discord`, `slack`, or `gateway`) is enabled. Portal-style ingress addons and services (Ollama, etc.) are added as compose overlays.

Repo layout convention:
- `packages/*` — app/package source workspaces
- `containers/*` — container/runtime assembly assets and image build contexts

```
CLI (host)            ->  Docker Compose (lifecycle)    <- primary orchestrator
Admin UI              ->  Admin API  ->  Docker Compose  <- optional web orchestrator
External clients      ->  Portal     ->  Guardian (/oc proxy)      ->  Assistant
```

The assistant is not an Admin API caller: it has no Docker socket, no admin
credential, and (loopback-only admin bind) no default network path to the
admin process — see Security invariant 3 (assistant isolation).

See [`docs/technical/core-principles.md`](docs/technical/core-principles.md) for the filesystem/volume-mount contract.

---

## Architecture

- **Lib** (`packages/lib/`) — Shared control-plane library (`@openpalm/lib`). All portable lifecycle, staging, secrets, portal discovery, connections, scheduler logic. Both CLI and UI import from this package.
- **CLI** (`packages/cli/`) — Host-side orchestrator. Manages Docker Compose directly. Serves setup wizard during install. Self-sufficient without UI.
- **UI** (`packages/ui/`) — SvelteKit app: operator web UI + API. Served as a host process by `openpalm ui serve` (no container). Accesses Docker socket directly on the host.
- **Guardian** (`packages/guardian/`, `@openpalm/guardian`; image build assets in `containers/guardian/`) — Bun HTTP server: a **transparent 1:1 OpenCode reverse proxy** (`/oc/*` forwards native OpenCode — method/path/query/body/SSE — untouched) with fail-closed policy overlays: principal auth (HTTP Basic + constant-time sha256 token compare, `auth.ts`), SQLite-persisted session/permission ownership, rate limiting, and content validation of inbound messages. `GUARDIAN_CONTENT_VALIDATION` ships **ON by default** in `portals.compose.yml` (`${GUARDIAN_CONTENT_VALIDATION:-1}`); the guardian package's own fallback when the var is fully unset is off, but every shipped install sets it, so the stage is on unless an operator explicitly opts out.
- **Assistant** (`containers/assistant/`) — OpenCode runtime with tools/skills. No Docker socket and no admin network path. When UI is absent, only the akm-backed memory/knowledge tools are available. Memory/skills/lessons are served by the akm CLI (akm-opencode plugin) via a shared akm stash bind-mounted from `~/.openpalm/knowledge/`.
- **Scheduler** — OS cron daemon (`crond`) started by the assistant container entrypoint. No network port. Automations are AKM YAML task files (`*.yml`) in `knowledge/tasks/`; `akm tasks sync` registers them with cron at container startup and re-syncs every 60 s to pick up new files.
- **Portal runtime** (`containers/portal/`) — Unified `portal` image build for baked first-party adapters.
- **Portal adapters** (`portals/discord/`, `portals/slack/`) — Translate external protocols into guardian `/oc/*` traffic. The OpenAI-compatible API now runs from the guardian image.
- **Stack** (`packages/skeleton/`) — Repo-shipped skeleton that seeds `OP_HOME` on install/update. Managed compose files (`core.compose.yml`, `services.compose.yml`, `portals.compose.yml`) ship in `packages/skeleton/system/stack/` and materialize to `~/.openpalm/system/stack/` (overwritten on reconcile); the user overlay ships as `packages/skeleton/config/stack/custom.compose.yml` and materializes to `~/.openpalm/config/stack/` (seeded once). Enabled first-party addons are tracked in the app-written record `~/.openpalm/state/stack.env` via `OP_ENABLED_ADDONS` and resolved to Compose `--profile addon.<name>` arguments; custom services go in `custom.compose.yml`.

---

## Commands

### Development

```bash
# UI (SvelteKit UI + API)
cd packages/ui && npm install && npm run dev     # Dev server on :8100
npm run build                                       # Production build
npm run check                                       # svelte-check + TypeScript

# Guardian (Bun)
cd packages/guardian && bun install && bun run src/server.ts

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
bun run wizard:dev                      # Runs `install --no-start` in a throwaway temp OP_HOME (OP_IMAGE_TAG=dev)
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
| `bun test` (guardian) | `bun run guardian:test` | packages/guardian security tests |
| `bun test` (cli) | `bun run cli:test` | packages/cli tests |
| Vitest (UI) | `bun run ui:test:unit` | packages/ui unit + browser component tests |
| Playwright (UI integration) | `bun run ui:test:e2e` | packages/ui integration tests (no browser route mocks) |
| Both UI | `bun run ui:test` | Vitest then Playwright (requires running build) |
| Playwright (stack) | `bun run ui:test:stack` | Stack-dependent integration tests (needs running stack + `OP_UI_LOGIN_PASSWORD`) |
| Playwright (LLM) | `bun run ui:test:llm` | LLM-dependent pipeline tests (needs stack + `OP_UI_LOGIN_PASSWORD` + API keys) |

```bash
# Run guardian tests
cd packages/guardian && bun test

# Run a single test file
cd packages/guardian && bun test src/server.test.ts

# Run UI unit tests (Vitest, CI-friendly)
bun run ui:test:unit

# Run all non-UI tests
bun run test

# Stack integration tests (requires running compose stack)
source scripts/load-test-env.sh && RUN_DOCKER_STACK_TESTS=1 OP_UI_LOGIN_PASSWORD="$OP_UI_LOGIN_PASSWORD" bun run ui:test:e2e
```

> **Important:** Always use `bun run ui:test:e2e` (not `npx playwright test` directly) to avoid Playwright version conflicts.

### Docker

```bash
# Dev stack (build from source)
bun run dev:build

# Dev stack (pull images)
bun run dev:stack

# Manual equivalent (mirrors dev:build — MANAGED core/services/portals from
# .dev/system/stack/, USER custom from .dev/config/stack/):
docker compose --project-name openpalm-dev --project-directory . \
  -f .dev/system/stack/core.compose.yml \
  -f .dev/system/stack/services.compose.yml \
  -f .dev/system/stack/portals.compose.yml \
  -f .dev/config/stack/custom.compose.yml \
  -f compose.dev.yml \
  --env-file .dev/state/stack.env \
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

Biome is configured repo-wide (`biome.jsonc`) and enforced by a CI gate
(`.github/workflows/lint.yml`). Run `bun run lint` (or `bun run lint:fix` /
`bun run format`) before committing. `.svelte` files are excluded from Biome —
they are linted by `svelte-check` + `eslint-plugin-svelte` in `packages/ui`.
Match the existing file style:
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
- **`config/` is user-owned.** Automatic lifecycle operations are non-destructive for existing user files and only seed missing defaults. Allowed writers: user direct edits, explicit UI/API config actions, and — for exactly one file — the assistant itself. The assistant maintains its own `config/assistant/user-profile.md` (what it has learned about the operator) and writes nothing else in the tree. It still holds no admin credential and has no default network path to the admin process (Security invariant 3), so this is a file write inside its own mounted config dir, not a control-plane action.
- **Secret boundary.** `state/stack.env` is non-secret runtime configuration only. Secret values live as files under `knowledge/secrets/` and are granted per service through Compose `secrets:`. `knowledge/env/user.env` is AKM env backing state, not a Compose env file.
- **Host CLI or UI is the orchestrator.** CLI manages Docker Compose directly on the host. UI provides a web UI as a host process (no container, no docker-socket-proxy).
- **Shared control-plane library (`@openpalm/lib`) is the single source of truth.** All portable control-plane logic lives in `packages/lib/`. CLI and UI both import from this package. Never duplicate control-plane logic in a consumer.
- **Guardian-only ingress.** All portal traffic must enter through the guardian (`/oc/*` proxy, ownership checks, rate limiting).
- **Assistant isolation.** Assistant has no Docker socket and no admin network path. When UI is absent, only the akm-backed memory/knowledge tools are available.
- **LAN-first by default.** Nothing is publicly exposed without explicit user opt-in.
- **Add a portal** by enabling its first-party addon name in the app-written record `~/.openpalm/state/stack.env` (`OP_ENABLED_ADDONS`) or adding a service block to `config/stack/custom.compose.yml` (for custom portals) — no code changes.
- **No shell interpolation.** Docker commands use `execFile` with argument arrays, never shell strings.
- **Docker dependency resolution pattern.** Guardian and portal Dockerfiles install each service's own deps directly. UI is a host binary — no Docker build needed.

---

## Filesystem Contract

All state lives under `~/.openpalm/` (configurable via `OP_HOME`):

The layout is split into trees by **ownership** so lifecycle sync can overwrite what it owns without touching a user file:

| Directory | Owner | Purpose |
|-----------|-------|---------|
| `config/` | User | Non-secret config: assistant + guardian OpenCode config (`config/assistant/`, `config/guardian/`); the `custom.compose.yml` overlay lives under `config/stack/` |
| `system/` | Managed | Release-shipped assets overwritten wholesale on reconcile: managed compose files (`system/stack/`) + managed OpenCode config (`system/assistant/`, `system/guardian/`) |
| `state/` | App | App-written records: version pins, enabled add-ons, channel, setup completion (`state/stack.env`, `state/host-identity.json`) |
| `knowledge/` | User/Services | AKM knowledge (skills, env, secrets, agents); `knowledge/env/user.env` holds user-managed secrets; `knowledge/tasks/` holds scheduled automation task files. Stack config is NOT here — it is `state/stack.env`, kept out of this tree because `knowledge/` is bind-mounted into the assistant at `/stash` |
| `data/` | Services/System | Persistent data: assistant, guardian, akm (`data/akm/cache/`, `data/akm/data/`), logs, backups, rollback |
| `workspace/` | User | Shared assistant work area (bind-mounted at `/work`) |
| `~/.cache/openpalm/` | System | Ephemeral cache (outside `OP_HOME`) |

Dev mode uses `.dev/` with the same subdirectory structure.

---

## Delivery Checklist

Before submitting any change:

- [ ] `cd packages/ui && npm run check` passes (UI type correctness)
- [ ] `cd packages/guardian && bun test` (or `bun run guardian:test`) passes (security-critical branches covered)
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
| `packages/ui/src/lib/api.ts` | Barrel re-exporting the per-domain admin API clients in `packages/ui/src/lib/api/*` (`core`, `chat`, `voice`, `versions`, `akm`, …) |
| `packages/cli/src/lib/cli-state.ts` | CLI state helpers (ensureValidState) |
| `packages/cli/src/commands/install.ts` | CLI install (setup wizard + compose up) |
| `packages/guardian/src/server.ts` | Guardian request pipeline: HTTP Basic auth + sha256 token compare (`auth.ts`), then transparent OpenCode passthrough (`proxy.ts`) with SQLite-persisted ownership (`ownership.ts` + `state-db.ts`), rate limiting, and content validation overlays (`@openpalm/guardian`; `containers/guardian/` holds only the Dockerfile + entrypoint, no `src/`) |
| `packages/guardian/src/logger.ts` | Guardian-local logger (createLogger factory) |
| `packages/skeleton/system/stack/core.compose.yml` | Repo-shipped core service definition — assistant only; the guardian is profile-gated in `portals.compose.yml`, not a core service. Materializes to `~/.openpalm/system/stack/` on install/update |
| `packages/skeleton/system/stack/` | Repo-shipped managed compose files (core/services/portals). The user overlay is `packages/skeleton/config/stack/custom.compose.yml`; enabled add-ons/pins live in the runtime `state/stack.env` |
| `.opencode/opencode.json` | OpenCode project configuration |
