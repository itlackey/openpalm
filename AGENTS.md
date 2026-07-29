# AGENTS.md — OpenPalm

> **CRITICAL:** All work must comply with [`docs/technical/core-principles.md`](docs/technical/core-principles.md).
> That document is the **authoritative source of architectural rules** for this project.
> No implementation may violate its Core Goals, Security Invariants, or Filesystem Contract.
> **IT IS VERY IMPORTANT THAT YOU AVOID AND/OR REMOVE ALL COMPLEXITY THAT YOU CANNOT PROPERLY JUSTIFY. ALWAYS CALLOUT ANY COMPLEXITY THAT YOU FIND AND CANNOT JUSTIFY**
> Never take shortcuts that weaken correctness, security, or user-data safety.

---

## Never Delete User Data Without Path-Specific Approval

This rule overrides every approved plan and cleanup request that does not name
the exact path in the user's current message.

Never delete a file or directory that:

- the user did not explicitly name in their current message
- is matched by `.gitignore` and may contain user secrets or state
- lives outside obviously generated paths such as `node_modules/`,
  `.svelte-kit/`, `dist/`, `build/`, or `.cache/`

This includes `.dev*`, `.private`, `.env*`, `knowledge`, `private`, `data`,
`state`, backups, `~/.openpalm`, `~/.config`, planning directories, and any
directory containing credentials.

For any other deletion:

1. List every exact path and explain why it is safe.
2. Wait for explicit approval of each path.
3. Use the OS trash for untracked user data. Git history is sufficient only for
   tracked files.

---

## Project Overview

OpenPalm is a self-hosted personal AI platform built on Docker Compose and OpenCode. It manages a stack of containers orchestrated by the host CLI or an optional admin web UI.

One always-on core container: **assistant** (OpenCode runtime, image-baked non-admin UI, BusyBox `crond`, and akm CLI memory/skills/lessons over the shared stash). The **guardian** (principal-authenticated ingress) is not a core container; it is profile-gated in `portals.compose.yml` and deployed only when a guardian-ingress addon (`chat`, `api`, `discord`, `slack`, or `gateway`) is enabled. Portal-style ingress addons and services such as Ollama are added through Compose.

Repo layout convention:
- `packages/*` — app/package source workspaces
- `containers/*` — container/runtime assembly assets and image build contexts

```
CLI (host)            ->  Docker Compose (lifecycle)    <- primary orchestrator
Admin UI              ->  Admin API  ->  Docker Compose  <- optional web orchestrator
External clients      ->  Portal     ->  Guardian (/oc proxy)      ->  Assistant
```

See [`docs/technical/core-principles.md`](docs/technical/core-principles.md) for the filesystem/volume-mount contract.

---

## Architecture

- **Lib** (`packages/lib/`) — Shared control-plane library (`@openpalm/lib`). All portable lifecycle, staging, secrets, portal discovery, connections, access-toggle, and task-file logic. Both CLI and UI import from this package.
- **CLI** (`packages/cli/`) — Host-side orchestrator. Manages Docker Compose directly. Serves setup wizard during install. Self-sufficient without UI.
- **UI** (`packages/ui/`) — One SvelteKit adapter-node app. Electron and CLI host launches can carry admin capability and use the host Docker socket; the assistant image runs the same build as a non-admin child with no socket or host-control capability.
- **Guardian** (`packages/guardian/`, `@openpalm/guardian`; image build assets in `containers/guardian/`) — Bun HTTP server: a **transparent 1:1 OpenCode reverse proxy** (`/oc/*` forwards native OpenCode method/path/query/body/SSE) with fail-closed policy overlays for principal auth, SQLite-persisted ownership, rate limiting, event filtering, and content validation. `GUARDIAN_CONTENT_VALIDATION` defaults ON in package code and shipped Compose; only explicit `0`, `false`, `no`, or `off` disables it. Escalated moderator failure blocks the message.
- **Assistant** (`containers/assistant/`) — OpenCode runtime with tools/skills and the local UI child. No Docker socket, admin credential, or admin network path. Memory/skills/lessons use the akm-opencode plugin and the shared `knowledge/` stash. The entrypoint does not source `knowledge/env/user.env`; scoped tools load it on demand.
- **Scheduler** — OS cron daemon (`crond`) started by the assistant container entrypoint. No network port. Automations are AKM YAML task files (`*.yml`) in `knowledge/tasks/`; `akm tasks sync` registers them at startup and every 60 s. Supported targets are `command`, `prompt`, and `workflow`.
- **Portal runtime** (`containers/portal/`) — Unified `portal` image build for baked first-party adapters.
- **Voice** (`containers/voice/`) — Optional addon: FastAPI service exposing OpenAI-compatible `/v1/audio/speech` (Kokoro) and `/v1/audio/transcriptions` (faster-whisper). Gated by an `addon.voice.*` Compose profile in `services.compose.yml`; joins `addon_net` only (never `assistant_net`), loopback-published, reached by the UI via the same-origin `/voice/*` pass-through.
- **Portal adapters** (`packages/portal-discord/`, `packages/portal-slack/`) — Translate external protocols into guardian `/oc/*` traffic. The OpenAI-compatible API now runs from the guardian image.
- **Stack** (`packages/skeleton/`) — Repo-shipped skeleton that seeds `OP_HOME` on install/update. Managed compose files (`core.compose.yml`, `services.compose.yml`, `portals.compose.yml`) ship in `packages/skeleton/system/stack/` and materialize to `~/.openpalm/system/stack/` (overwritten on reconcile); the user overlay ships as `packages/skeleton/config/stack/custom.compose.yml` and materializes to `~/.openpalm/config/stack/` (seeded once). Enabled first-party addons are tracked in the app-written record `~/.openpalm/state/stack.env` via `OP_ENABLED_ADDONS` and resolved to Compose `--profile addon.<name>` arguments; custom services go in `custom.compose.yml`.

---

## Commands

### Development

```bash
# UI (SvelteKit UI + API)
cd packages/ui && npm install && npm run dev     # Dev server on :5173
npm run build                                       # Production build
npm run check                                       # svelte-check + TypeScript

# Guardian (Bun)
cd packages/guardian && bun install && bun run src/server.ts

# Root shortcuts
bun run ui:dev     # Runs UI dev from root
bun run ui:dev:isolated # Isolated non-admin UI/API process on :3880
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

### Tests

Bun test, Vitest, and Playwright across all packages:

| Runner | Command | Scope |
|--------|---------|-------|
| `bun test` (root) | `bun run test` | guardian, cli, lib, all portal packages, electron admin-tools, scripts (excludes ui). An untracked repo-root `.env` breaks its isolation tripwire — run in a clean worktree if one exists |
| `bun test` (guardian) | `bun run guardian:test` | packages/guardian security tests |
| `bun test` (cli) | `bun run cli:test` | packages/cli tests |
| Vitest (UI) | `bun run ui:test:unit` | packages/ui unit + browser component tests |
| Playwright (UI integration) | `bun run ui:test:e2e` | packages/ui integration tests (no browser route mocks) |
| Both UI | `bun run ui:test` | Vitest then Playwright (requires running build) |
| Playwright (stack) | `bun run ui:test:stack` | Stack-dependent integration tests (needs running stack + `OP_UI_LOGIN_PASSWORD`) |

```bash
# Run a single test file
cd packages/guardian && bun test src/server.test.ts

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
| [`docs/technical/api-spec.md`](docs/technical/api-spec.md) | Admin API conventions, security gates, and route-map pointer |
| [`docs/technical/environment-and-mounts.md`](docs/technical/environment-and-mounts.md) | Every env var and mount point per service |
| [`docs/technical/opencode-configuration.md`](docs/technical/opencode-configuration.md) | OpenCode integration, tools, plugins, startup flow |
| [`docs/technical/package-management.md`](docs/technical/package-management.md) | Single lock file policy and dependency workflow |

---

## Code Style

### Language & Runtime

- **TypeScript** everywhere (`"strict": true`, no `any` for untrusted data)
- **Bun** for guardian and portals; **BusyBox `crond`** for scheduled tasks; **Node/Vite** for the SvelteKit `adapter-node` UI
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
- **Secret boundary.** `state/stack.env` is non-secret runtime configuration only. Provider `knowledge/secrets/auth.json` remains assistant-readable. Delegated UI/OpenCode-server/Guardian/API/portal/bot credentials live under `private/secrets/`, never in assistant `/stash`, and are granted as named Compose secret files. `knowledge/env/user.env` is AKM env backing state loaded on demand, not a Compose env file or entrypoint source.
- **Host CLI or UI is the orchestrator.** CLI manages Docker Compose directly on the host. UI provides a web UI as a host process (no container, no docker-socket-proxy).
- **Shared control-plane library (`@openpalm/lib`) is the single source of truth.** All portable control-plane logic lives in `packages/lib/`. CLI and UI both import from this package. Never duplicate control-plane logic in a consumer.
- **Guardian-only ingress.** All portal traffic must enter through the guardian (`/oc/*` proxy, ownership checks, rate limiting).
- **Assistant isolation.** Assistant has no Docker socket and no admin network path. When UI is absent, only the akm-backed memory/knowledge tools are available.
- **LAN-first by default.** Nothing is publicly exposed without explicit user opt-in.
- **Flat access model.** Setup uses the flat `access` booleans (`networkAccess`, `assistantDirect`, `guardianNetwork`, `guardianOpenaiApi` — `packages/lib/src/control-plane/access-toggles.ts`), which generate explicit per-service bind/auth variables (`OP_UI_BIND_ADDRESS`, `OP_ASSISTANT_BIND_ADDRESS`, `OP_GUARDIAN_BIND_ADDRESS`, `OP_API_BIND_ADDRESS`; voice is fixed to loopback). Do not reintroduce grouped access modes, global bind cascades, separate chat/API listeners, or assistant SSH controls.
- **No boot-time installs.** The assistant image bakes UI/skeleton/tools; the entrypoint installs nothing at boot. Optional CLIs (gcloud, gws, codex, claude, copilot, pi) install on demand via the `install-optional-tool` skill into the persistent volume. Guardian retains only its documented thin-host overrides.
- **Add a portal** by enabling its first-party addon name in the app-written record `~/.openpalm/state/stack.env` (`OP_ENABLED_ADDONS`) or adding a service block to `config/stack/custom.compose.yml` (for custom portals) — no code changes.
- **No shell interpolation.** Docker commands use `execFile` with argument arrays, never shell strings.
- **Docker dependency resolution pattern.** Assistant, Guardian, and portal images bake their runtime artifacts and dependencies. The UI has no standalone container image; the assistant image bakes its package build.
- **Package versions.** Internal workspace references may use `workspace:*`; `bun pm pack` resolves them. Platform manifests are stamped in lockstep, while portal SDK and adapters form the portal release unit.

---

## Filesystem Contract

All state lives under `~/.openpalm/` (configurable via `OP_HOME`), split into
trees by **ownership** so lifecycle sync can overwrite what it owns (`system/`,
`state/`) without touching a user file (`config/`, `knowledge/`, `workspace/`).
The authoritative per-directory table is in
[`docs/technical/core-principles.md`](docs/technical/core-principles.md); the
full env/mount map is in
[`docs/technical/environment-and-mounts.md`](docs/technical/environment-and-mounts.md).
Dev mode uses `.dev/` with the same subdirectory structure.

---

## Delivery Checklist

Before submitting any change:

- [ ] `bun run check` passes (UI type correctness)
- [ ] `bun run test` passes (all non-UI suites)
- [ ] `bun run guardian:test` passes for Guardian/security changes
- [ ] `bun run lint` passes
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
| `packages/lib/src/index.ts` | **Shared control-plane library** (`@openpalm/lib`) barrel export |
| `packages/lib/src/control-plane/lifecycle.ts` | State factory, lifecycle transitions (install/update/uninstall) |
| `packages/lib/src/control-plane/config-persistence.ts` | Runtime file writing (compose, env, secrets) |
| `packages/lib/src/control-plane/types.ts` | CORE_SERVICES, MANAGED_SERVICES, ControlPlaneState |
| `packages/ui/src/lib/server/docker.ts` | Docker compose wrapper (re-exports lib with preflight enforcement) |
| `packages/ui/src/lib/server/helpers.ts` | Shared request/response utilities |
| `packages/ui/src/lib/types.ts` | Shared TypeScript types |
| `packages/ui/src/lib/api.ts` | Barrel re-exporting the per-domain admin API clients in `packages/ui/src/lib/api/*` (`core`, `chat`, `voice`, `versions`, `akm`, …) |
| `packages/cli/src/lib/cli-state.ts` | CLI state helpers (ensureValidState) |
| `packages/cli/src/commands/install.ts` | CLI install (setup wizard + compose up) |
| `packages/guardian/src/server.ts` | Guardian request pipeline: HTTP Basic auth + sha256 token compare (`auth.ts`), then transparent OpenCode passthrough (`proxy.ts`) with SQLite-persisted ownership (`ownership.ts` + `state-db.ts`), rate limiting, and content validation overlays (`@openpalm/guardian`; `containers/guardian/` holds only the Dockerfile + entrypoint, no `src/`) |
| `packages/guardian/src/logger.ts` | Guardian-local logger (createLogger factory) |
| `packages/skeleton/system/stack/core.compose.yml` | Repo-shipped core service definition — assistant only; the guardian is profile-gated in `portals.compose.yml`, not a core service. Materializes to `~/.openpalm/system/stack/` on install/update |
| `packages/skeleton/system/stack/` | Repo-shipped managed compose files (core/services/portals). The user overlay is `packages/skeleton/config/stack/custom.compose.yml`; enabled add-ons/pins live in the runtime `state/stack.env` |
| `.opencode/opencode.json` | OpenCode project configuration |
