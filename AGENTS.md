# AGENTS.md — OpenPalm MVP

> **CRITICAL:** All work must comply with [`docs/core-principles.md`](docs/core-principles.md).
> That document is the **authoritative source of architectural rules** for this project.
> No implementation may violate its Core Goals, Security Invariants, or Filesystem Contract.

---

## Project Overview

OpenPalm is a self-hosted personal AI platform built on Docker Compose, Caddy, and OpenCode.
Key components: `core/admin/` (SvelteKit admin UI + API), `core/guardian/` (HMAC-signed ingress), `channels/chat/` (OpenAI-compatible adapter), `core/assistant/` (OpenCode runtime config).

See [`docs/core-principles.md`](docs/core-principles.md) for the filesystem/volume-mount contract.

---

## Commands

### Development

```bash
# Install UI dependencies
cd core/admin && npm install

# Run UI dev server (port 5173)
bun run admin:dev
# or: cd core/admin && npm run dev

# Build UI
bun run admin:build

# Run guardian directly
cd core/guardian && bun run src/server.ts

# Run channel-chat adapter directly
cd channels/chat && bun run server.ts

# Dev environment setup (creates .dev/ XDG dirs, seeds .env)
./scripts/dev-setup.sh --seed-env
```

### Type Checking (no separate lint/format tooling)

```bash
# Type-check UI + Svelte components
cd core/admin && npm run check
# or: cd core/admin && bun run check
```

### Tests

Tests use Bun's built-in test runner (`bun:test`). No test files exist yet; add them in `core/guardian/src/` for guardian/channel code and `core/admin/tests/` for UI (Vitest/Playwright).

```bash
# Run all guardian tests
cd core/guardian && bun test

# Run a single test file
cd core/guardian && bun test src/path/to/file.test.ts

# Run tests matching a name pattern
cd core/guardian && bun test --test-name-pattern "pattern"
```

### Docker

```bash
docker compose up -d          # start stack
docker compose down           # stop stack
docker compose logs -f admin     # tail a service
```

---

## Rules and Principles Documents

Read these before making significant changes. They are the authoritative sources for their domains.

| Document | Scope |
|---|---|
| [`docs/core-principles.md`](docs/core-principles.md) | Architectural rules, security invariants, filesystem contract |
| [`docs/code-quality-principles.md`](docs/code-quality-principles.md) | Engineering invariants, Bun and SvelteKit quality contracts, delivery checklist |
| [`docs/bunjs-rules.md`](docs/bunjs-rules.md) | Bun-specific implementation rules, built-in API preference list |
| [`docs/sveltekit-rules.md`](docs/sveltekit-rules.md) | SvelteKit-specific rules, server/client boundaries, routing, UX |
| [`docs/api-spec.md`](docs/api-spec.md) | Full Admin API spec, endpoint contracts, error shapes |
| [`docs/directory-structure.md`](docs/directory-structure.md) | XDG three-tier layout, volume mounts, network topology |
| [`docs/environment-and-mounts.md`](docs/environment-and-mounts.md) | Every env var and mount point per service |
| [`docs/opencode-configuration.md`](docs/opencode-configuration.md) | OpenCode integration, tools, plugins, startup flow |

---

## Code Style

### Language & Runtime

- **TypeScript** everywhere (`"strict": true`, no `any` for untrusted data)
- **Bun** for guardian and channels; **Node/Vite** for the UI (SvelteKit + `adapter-node`)
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
- Custom Vite aliases: `$assets` → `assets/` (repo root), `$registry` → `registry/` (channel registry)
- **Prefer Bun and Web Platform built-ins** before adding third-party dependencies (see `docs/bunjs-rules.md`)

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
- Catch-with-fallback for JSON parse: `try { body = await req.json() } catch { return json(400, ...) }`
- Silent `try {} catch {}` only for best-effort/non-critical side effects (e.g., audit log writes)
- Cast errors with `e instanceof Error ? e.message : e` in user-facing messages
- `void (async () => { ... })()` for fire-and-forget async in Svelte `onMount`
- **Fail closed** on auth/signature/timestamp errors — always return an explicit HTTP error status

### Formatting

No Prettier or ESLint configured. Match the existing file style:
- 2-space indentation
- Single quotes in JS/TS, double quotes in JSON
- Trailing commas in multi-line arrays/objects

### Module Structure

- `+server.ts` route handlers perform transport concerns only; business logic lives in `$lib/server/*`
- Bun service entrypoints: parse request → validate/auth → call domain logic → return structured response
- No hidden global state; shared state must be explicit, typed, and owned by a clear module
- Keep files small and single-responsibility

---

## Architecture Rules (summary — full detail in `docs/core-principles.md`)

- **File assembly, not rendering.** Copy whole files between tiers; no string interpolation or template generation.
- **Never overwrite CONFIG_HOME.** Seed defaults once; all subsequent writes go to STATE_HOME.
- **Admin is sole orchestrator.** Only the admin container has Docker socket access.
- **Guardian-only ingress.** All channel traffic must enter through the guardian (HMAC, replay protection, rate limiting).
- **Assistant isolation.** Assistant has no Docker socket; it calls the admin API only.
- **LAN-first by default.** Nothing is publicly exposed without explicit user opt-in.
- **Add a channel** by dropping a `.yml` compose overlay (+ optional `.caddy` snippet) into `channels/` — no code changes.
- **No shell interpolation.** Docker commands use `execFile` with argument arrays, never shell strings.

---

## Delivery Checklist

Before submitting any change:

- [ ] `cd core/admin && npm run check` passes (UI type correctness)
- [ ] `cd core/guardian && bun test` passes (security-critical branches covered)
- [ ] No new dependency duplicates a built-in Bun/platform capability
- [ ] Filesystem, guardian ingress, and assistant-isolation rules in `docs/core-principles.md` remain intact
- [ ] Errors and logs are structured and include request identifiers where available
- [ ] No secrets leak through client bundles or logs

---

## Key Files

| Path | Purpose |
|---|---|
| `docs/core-principles.md` | **Authoritative architectural rules** |
| `docs/code-quality-principles.md` | Engineering invariants and quality contracts |
| `docs/bunjs-rules.md` | Bun built-in API rules |
| `docs/sveltekit-rules.md` | SvelteKit-specific implementation rules |
| `core/admin/src/lib/server/control-plane.ts` | Core state, types, business logic |
| `core/admin/src/lib/server/helpers.ts` | Shared request/response utilities |
| `core/admin/src/lib/server/docker.ts` | Docker Compose shell-out wrapper |
| `core/guardian/src/server.ts` | HMAC-signed message guardian |
| `assets/` | Bundled compose files, Caddyfile, channel overlays |
| `core/assistant/AGENTS.md` | Assistant persona and operational guidelines |
| `.opencode/opencode.json` | OpenCode project configuration |
