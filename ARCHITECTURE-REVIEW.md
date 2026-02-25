# OpenPalm Architecture Review

**Date:** 2026-02-25
**Scope:** Full monorepo — core services, channels, CLI, admin UI, shared library, infrastructure, testing
**Reviewer:** Automated deep-dive analysis

---

## Executive Summary

OpenPalm is a Docker Compose-based platform that routes messages from various channels (chat, Discord, Telegram, etc.) through an HMAC-secured gateway to an AI assistant runtime (OpenCode). It includes an admin UI (SvelteKit), a CLI installer, a stack configuration engine, and an automation/cron system.

The architecture has a solid conceptual foundation — the channel→gateway→assistant pipeline, HMAC-signed payloads, and a declarative stack spec are well-designed primitives. However, the codebase suffers from significant code duplication, configuration sprawl, version drift, incomplete abstractions, dead code, and several security concerns that undermine the quality of the implementation.

**Severity summary:**
- **Critical:** 5 findings
- **High:** 12 findings
- **Medium:** 15 findings
- **Low:** 10 findings

---

## Table of Contents

1. [Critical Issues](#1-critical-issues)
2. [High-Severity Issues](#2-high-severity-issues)
3. [Medium-Severity Issues](#3-medium-severity-issues)
4. [Low-Severity Issues](#4-low-severity-issues)
5. [Architecture Anti-Patterns](#5-architecture-anti-patterns)
6. [Configuration Sprawl](#6-configuration-sprawl)
7. [Testing Assessment](#7-testing-assessment)
8. [Recommendations](#8-recommendations)

---

## 1. Critical Issues

### C1. Nonce Cache is a Module-Level Singleton with Filesystem Side Effects

**File:** `core/gateway/src/nonce-cache.ts:109`

```ts
export const nonceCache = new NonceCache(Bun.env.GATEWAY_NONCE_CACHE_PATH ?? "/app/data/nonce-cache.json");
```

The `NonceCache` is instantiated at **module load time** as a singleton. This means:
- Any file that imports from this module triggers filesystem I/O (`loadFromDisk`, `persistToDisk`) and starts a `setInterval` timer — even in test contexts.
- Tests that import the gateway server indirectly get a live nonce cache writing to disk.
- The hardcoded fallback path `/app/data/nonce-cache.json` will fail on developer machines (only works inside Docker).
- The `prune()` interval is never cleaned up in production, only via `.destroy()` in tests.

**Impact:** Test pollution, resource leaks, impossible to test in isolation without workarounds.

### C2. Hardcoded Default Admin Token is Insecure

**File:** `packages/ui/src/lib/server/config.ts:17-18`

```ts
export const ADMIN_TOKEN = env.ADMIN_TOKEN ?? 'change-me-admin-token';
export const DEFAULT_INSECURE_TOKEN = 'change-me-admin-token';
```

The admin token defaults to a well-known string. While `verifyAdminToken()` rejects this default, the system still **starts and serves requests**. There is only a `log.warn()` in `init.ts:95-98`. An operator who forgets to set `ADMIN_TOKEN` will have a running instance with all authenticated endpoints returning 401, but unauthenticated endpoints (setup wizard, health, meta) fully accessible.

**Impact:** Operators may unknowingly run an unauthenticated admin panel.

### C3. `isLocalRequest()` Trusts Spoofable `x-forwarded-for` Header

**File:** `packages/ui/src/lib/server/auth.ts:38-64`

```ts
export function isLocalRequest(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() ?? '127.0.0.1';
```

This function uses `x-forwarded-for` to determine if a request is local. This header can be trivially spoofed by any client if the proxy chain does not strip/overwrite it. The code comment acknowledges this ("SECURITY NOTE: This relies on x-forwarded-for which can be spoofed") but depends on Caddy being the only ingress point — which is not guaranteed in development, testing, or misconfigured deployments.

Worse: when `x-forwarded-for` is absent, it **defaults to `127.0.0.1`**, meaning any request without the header is treated as local.

**Impact:** Setup wizard endpoints may be accessible from the public internet.

### C4. Channel Servers Lack `content-length` Enforcement Before Body Parsing

**Files:** All channel `server.ts` files

Every channel checks `content-length` header but then immediately calls `req.json()` regardless:

```ts
const contentLength = Number(req.headers.get("content-length") ?? "0");
if (contentLength > 1_048_576) {
  return new Response(..., { status: 413 });
}
let body: any;
try {
  body = await req.json();  // reads entire body anyway if header is absent/wrong
} catch { ... }
```

The `content-length` header is client-supplied and can be omitted or falsified. A malicious client can send a 100MB body with `content-length: 0` and the server will happily parse it. The check only guards against honest clients.

**Impact:** Denial of service via memory exhaustion.

### C5. Automation Runner Script Has Shell Injection Vulnerability

**File:** `packages/lib/src/admin/automations.ts:120-155`

The `writeRunner()` function generates a bash script that uses `$ID` in file paths:
```bash
ID="${1:?automation ID required}"
SCRIPT="${scriptsDir()}/${ID}.sh"
```

While `fileSafeId()` validates the ID format (`/^[a-zA-Z0-9_-]+$/`), the validation is only called in `syncAutomations()` and `triggerAutomation()` — but the runner script itself is a standalone bash script that can be invoked directly. If the runner is called with a crafted argument outside of the TypeScript validation boundary, it could execute arbitrary commands via path traversal.

**Impact:** Potential command injection if runner script is invoked outside the TypeScript boundary.

---

## 2. High-Severity Issues

### H1. Massive Code Duplication Across Channel Implementations

**Files:** `channels/chat/server.ts`, `channels/webhook/server.ts`, `channels/voice/server.ts`, `channels/telegram/server.ts`

The `chat`, `webhook`, and `voice` channel servers are nearly identical — copy-paste clones with only the channel name, port, and env var names changed. Compare:

| Line | chat/server.ts | webhook/server.ts |
|------|---------------|-------------------|
| 8 | `createLogger("channel-chat")` | `createLogger("channel-webhook")` |
| 10 | `PORT ?? 8181` | `PORT ?? 8185` |
| 12 | `CHANNEL_CHAT_SECRET` | `CHANNEL_WEBHOOK_SECRET` |
| 15 | `createChatFetch(...)` | `createWebhookFetch(...)` |
| 19 | `/chat` | `/webhook` |

The entire body of each function is character-for-character identical except for names. This is ~50 lines duplicated 3+ times.

**Impact:** Bug fixes must be applied in 4+ places. Inconsistencies will inevitably creep in (some already have — voice has no inbound token support unlike chat/webhook).

### H2. `ChannelAdapter` Interface is Defined but Mostly Unused

**File:** `packages/lib/src/shared/channel.ts:1-64`

The `ChannelAdapter` interface (`ChannelAdapter`, `ChannelRoute`, `InboundResult`, `ChannelPayload`) is explicitly marked `@planned` in comments: *"These types define the intended design direction... They are not yet imported or used by any channel implementation."*

Only `mcp` and `a2a` channels actually implement this interface. The `chat`, `webhook`, `voice`, `telegram`, and `discord` channels all use ad-hoc `createXxxFetch` factory functions with no shared base.

**Impact:** The codebase has two competing patterns for the same thing. The "planned" abstraction has been around long enough to accumulate two implementations, meaning it should have been completed or removed.

### H3. MCP and A2A Server Wrappers Are Also Duplicated

**Files:** `channels/mcp/server.ts`, `channels/a2a/server.ts`

The `createFetch()` functions in both MCP and A2A servers are essentially identical (route map, health check, gateway forwarding, JSON-RPC response wrapping). The only difference is the response envelope format (MCP uses `content` array, A2A uses `artifacts` array).

### H4. Version Mismatch Across Packages

| Package | Version |
|---------|---------|
| Root `package.json` | 0.4.0 |
| `packages/cli` | 0.4.0 |
| `packages/lib` | **0.3.0** |
| `packages/ui` | **0.3.0** |
| `core/gateway` | 0.4.0 |
| `core/admin` | 0.4.0 |
| `core/assistant` | 0.4.0 |
| A2A `AGENT_CARD` | **0.3.4** |
| MCP `serverInfo` | **0.3.4** |

Three different version numbers are live in the codebase. The lib and UI packages lag behind at 0.3.0. The MCP/A2A channels have a hardcoded `0.3.4` string that doesn't match anything.

**Impact:** Confusing for users and contributors; no single source of truth for the project version.

### H5. `any` Types Used in Multiple Locations

**Files:** `channels/chat/server.ts:27`, `channels/webhook/server.ts:29`, `channels/voice/server.ts:25-31`, `packages/ui/src/lib/api.ts:8`

```ts
let body: any;     // chat, webhook
data: any;          // api.ts ApiResult
```

Despite `strict: true` in tsconfig, `any` is used for parsed request bodies and API responses. This defeats TypeScript's type safety guarantees at critical trust boundaries (user input parsing).

**Impact:** Runtime type errors that the compiler cannot catch; possible prototype pollution.

### H6. Env File Parser is Duplicated Three Times

The project has three separate env file parsers:
1. `packages/lib/src/env.ts` — `readEnvFile()` (async, uses `Bun.file`)
2. `packages/lib/src/admin/runtime-env.ts` — `parseRuntimeEnvContent()` (sync, string-based)
3. `core/gateway/src/server.ts:27-39` — `parseEnvContent()` (sync, inline)

All three handle comment stripping, key=value splitting, and blank line skipping with slightly different edge-case behavior (e.g., quote stripping is only in #1).

**Impact:** Inconsistent env file parsing across the system; maintenance burden.

### H7. `composeServiceName()` is Duplicated

**Files:** `packages/lib/src/admin/stack-manager.ts:75-77`, `packages/lib/src/admin/stack-generator.ts:36-38`

Identical function defined in two files in the same package:
```ts
function composeServiceName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}
```

### H8. Docker Images Use Outdated Base Image

**Files:** All Dockerfiles

```dockerfile
FROM oven/bun:1.3.5
```

All four Dockerfiles pin to Bun 1.3.5. The root `package.json` specifies `@types/bun: ^1.3.9` and the CLI requires `bun >= 1.2.0`. There's a mismatch between the Docker runtime version and the types/engine requirements, and no CI automation to keep the base image current.

### H9. Admin Dockerfile Installs Docker CLI Inside Container

**File:** `core/admin/Dockerfile:1-11`

The admin container installs the full Docker CE CLI (`docker-ce-cli`) to manage containers from within a container. This is a Docker-in-Docker anti-pattern. It also mounts the Docker socket (`/var/run/docker.sock`) into the container, which grants root-equivalent access to the host.

**Impact:** Security risk — any container escape or admin API compromise gives full host control.

### H10. `export { signPayload }` Re-exported for No Reason in Every Channel

**Files:** Every channel `server.ts`

```ts
import { signPayload } from "@openpalm/lib/shared/crypto.ts";
export { signPayload };
```

Every single channel server re-exports `signPayload` for test convenience. This is a test smell leaking into production code — the channels don't need to export this function.

### H11. No Graceful Shutdown Handling

**Files:** All `server.ts` files across channels and gateway

None of the servers implement graceful shutdown. There is no `process.on('SIGTERM')` handler, no connection draining, and no cleanup of the nonce cache prune timer. When Docker sends SIGTERM during `docker compose down`, in-flight requests are dropped.

### H12. `resolveInContainerSocketPath()` Has Dead Branch

**File:** `packages/lib/src/runtime.ts:100-107`

```ts
export function resolveInContainerSocketPath(platform: ContainerPlatform): string {
  if (platform === "podman") {
    return "/var/run/docker.sock";
  }
  return "/var/run/docker.sock";
}
```

Both branches return the same string. The `if` statement is dead code.

---

## 3. Medium-Severity Issues

### M1. `json()` Helper Formats Responses with `JSON.stringify(data, null, 2)`

**File:** `packages/lib/src/shared/http.ts:1-6`

Every API response is pretty-printed with 2-space indentation. This increases response sizes by 20-40% for structured data, wastes bandwidth, and adds CPU overhead for every request.

### M2. Rate Limiter Uses Fixed Window Algorithm with Global Mutable State

**File:** `core/gateway/src/rate-limit.ts`

The rate limiter uses a simple fixed-window counter stored in a global `Map`. This has several issues:
- Not distributed: rate limits are per-process, so horizontal scaling resets limits.
- Burst vulnerability: a client can send 120 requests at window boundary and 120 at the start of the next, getting 240 requests in under 1 second.
- Global mutable singleton: impossible to reset between tests without module-level side effects.

### M3. Audit Log Has Single-File Rotation with No Compression

**File:** `core/gateway/src/audit.ts`

The audit log rotates at 50MB by renaming to `.1`, but:
- Only keeps one rotated file (the next rotation overwrites `.1`).
- No compression — 50MB+ of JSON lines sitting on disk.
- No configurable retention policy.

### M4. `StackManager` Reads and Writes Files Synchronously on Every Operation

**File:** `packages/lib/src/admin/stack-manager.ts`

Every method (`getSpec()`, `setSpec()`, `setChannelAccess()`, etc.) calls `readFileSync()` and `writeFileSync()`. For the admin UI serving concurrent requests, this blocks the event loop on filesystem I/O. The `getSpec()` call alone re-reads and re-parses the YAML file on every single invocation.

### M5. CLI Argument Parser is Hand-Rolled

**File:** `packages/cli/src/main.ts:76-106`

The CLI implements its own argument parser (`parseArg`, `hasFlag`, `getPositionalArgs`) rather than using an established library. The parser doesn't handle edge cases like `--flag=value` syntax, combined short flags, or `--` separator.

### M6. `confirm()` Function Leaks Stdin Reader

**File:** `packages/lib/src/ui.ts:129-150`

```ts
const reader = Bun.stdin.stream().getReader();
// ... reads ...
reader.releaseLock();
```

The reader is released but the underlying stream is not closed. Calling `confirm()` multiple times may create multiple readers on the same stream.

### M7. Setup Wizard State and Stack Spec Are Redundant

**Files:** `packages/lib/src/admin/setup-manager.ts`, `packages/lib/src/admin/stack-spec.ts`

Both `SetupState` and `StackSpec` track `accessScope` and `enabledChannels`. The setup wizard writes to `SetupState`, and separately the stack manager writes to `StackSpec`. These can drift apart, creating confusion about which is the source of truth.

### M8. UI Package Named `"ui"` Not `"@openpalm/ui"`

**File:** `packages/ui/package.json:2`

```json
{ "name": "ui" }
```

Unlike all other packages (`@openpalm/lib`, `@openpalm/gateway`, etc.), the UI package is just named `"ui"`. This breaks the naming convention and could collide with other packages in a monorepo context.

### M9. tsconfig Includes `packages/ui` in `include` but Excludes It Immediately

**File:** `tsconfig.json:35,42-43`

```json
"include": [
  "packages/ui/src/**/*.ts",
],
"exclude": [
  "packages/ui"
]
```

The root tsconfig includes UI source files and then excludes the entire `packages/ui` directory. This is contradictory and confusing — the exclusion wins, making the include a no-op.

### M10. `checkPort80()` is Deprecated but Still Exported

**File:** `packages/lib/src/preflight.ts:87-89`

```ts
/** @deprecated Use checkPort() instead. */
export async function checkPort80(): Promise<PreflightWarning | null> {
  return checkPort(80);
}
```

A deprecated function that's still part of the public API. Should be removed.

### M11. Nonce Cache Persists to Disk on Every Single Request

**File:** `core/gateway/src/nonce-cache.ts:41-43`

Every `checkAndStore()` call writes the entire nonce map to disk via `persistToDisk()`. For high-throughput scenarios, this is a filesystem write per inbound request.

### M12. No Input Sanitization on Metadata Fields

**Files:** All channel `server.ts` files

User-supplied `metadata` objects from request bodies are passed through unvalidated:
```ts
metadata: body.metadata ?? {}
```

No type checking, no depth limiting, no key filtering. A client can send arbitrarily nested metadata that gets forwarded to the gateway and stored in audit logs.

### M13. OpenCode Client Has No Retry Logic

**File:** `core/gateway/src/assistant-client.ts`

The `OpenCodeClient` has no retry logic for transient failures (network timeouts, 503s). If the assistant is briefly unavailable (e.g., during container restart), every request immediately fails with a 502.

### M14. `@playwright/test` Version Mismatch Between Admin and UI

**Files:** `core/admin/package.json`, `packages/ui/package.json`

```
core/admin: "@playwright/test": "^1.40.0"
packages/ui: "@playwright/test": "^1.58.1"
```

Major version gap (1.40 vs 1.58) for the same test framework in the same monorepo.

### M15. Workspace Member `core/assistant` is Empty

**File:** `core/assistant/package.json`

```json
{
  "name": "@openpalm/assistant",
  "version": "0.4.0",
  "private": true
}
```

This package has no scripts, no dependencies, and no source code. It exists only to hold its `Dockerfile` and `extensions/` directory. But it's listed as a workspace member, adding noise to `bun install`.

---

## 4. Low-Severity Issues

### L1. `.plans/` Directory Contains 17 Plan Files Checked into Git

**Directory:** `.plans/`

Seventeen remediation plan files (R01-R17) and a `tasks.json` are committed to the repo. These are internal task-tracking artifacts that belong in an issue tracker, not in the source tree.

### L2. `.opencode/` Directory Contains Development-Specific AI Tooling Config

**Directory:** `.opencode/`

The `.opencode/` directory contains "Ralph Wiggum" plugin code, skill definitions, and worktree management scripts. This is developer-specific AI tooling configuration that shouldn't be in the repo root.

### L3. Multiple AGENTS.md Files Scattered Across the Repo

**Files:** 10+ `AGENTS.md` files across `channels/`, `core/`, `packages/`

These are AI-assistant instruction files. They add noise and create maintenance burden (they must be updated when the code changes).

### L4. `bunfig.toml` Contains Only Install Configuration

**File:** `bunfig.toml`

```toml
[install]
peer = false
```

A configuration file that exists only to disable peer dependency installation.

### L5. Two VSCode Settings Files

**Files:** `.vscode/settings.json`, `packages/ui/.vscode/mcp.json`

IDE-specific configuration committed to the repo.

### L6. `packages/lib/src/embedded/state/` Contains Binary and JSON Fixtures

**Files:** `banner.png`, `caddy.json`, `docker-compose.yml`, `registry/`

These are runtime state files embedded in the source tree of a library package. They mix concerns — the lib package should not contain deployment artifacts.

### L7. `dev/docs/` Contains 12+ Analysis/Review Documents

**Directory:** `dev/docs/`

An unusually large number of review documents, strategy docs, and TODO lists are committed to the repo, several of which acknowledge the issues identified in this review.

### L8. Community Snippets Have No Schema Validation in Loader

**File:** `community/snippet-schema.json` exists but `packages/lib/src/admin/snippet-discovery.ts` does not validate against it at load time (ajv is a devDependency, not a runtime dependency).

### L9. `export * from` Barrel File Re-exports Everything

**File:** `packages/lib/src/index.ts`

All 14 modules are re-exported via `export *`. This makes the public API surface implicit — consumers can import any symbol from any sub-module. There's no API boundary.

### L10. Unused `compose-runner.ts` Import in `packages/lib/src/compose.ts`

**File:** `packages/lib/src/compose.ts:2`

The `compose.ts` file imports from `./compose-runner.ts`. Meanwhile, there's also a `packages/lib/src/admin/compose-runner.ts` with different functionality. Having two `compose-runner` files at different levels is confusing.

---

## 5. Architecture Anti-Patterns

### A1. Two-Phase LLM Processing is Expensive and Fragile

The gateway makes **two sequential LLM calls** for every inbound message:
1. An "intake" call to validate/summarize the user message
2. A "core" call to generate the actual response

This doubles latency and LLM cost for every request. The intake validation uses prompt engineering to make the LLM return JSON, which is inherently unreliable (the `extractJsonObject` function exists specifically to handle LLM responses that aren't clean JSON).

### A2. Tight Coupling Between Docker Compose and Business Logic

The `StackManager`, `stack-generator`, `compose-runner`, and `core-services` modules generate raw Docker Compose YAML files, Caddy JSON configs, and env files as strings. The business logic (channel management, access control) is directly coupled to infrastructure concerns (Docker networking, port bindings, volume mounts).

### A3. No Database — Everything is Files

All state is stored as flat files:
- Stack spec: `openpalm.yaml` (YAML)
- Setup state: `setup-state.json` (JSON)
- Secrets: `secrets.env` (dotenv)
- Nonce cache: `nonce-cache.json` (JSON)
- Audit log: `audit.log` (JSONL)
- Automation history: JSONL files
- Cron schedules: flat files in directories

Despite having PostgreSQL in the stack (for OpenMemory), none of the OpenPalm core services use it. This leads to file locking issues, no transaction semantics, and O(n) lookups for everything.

### A4. Admin Container is a "God Container"

The admin container:
- Runs the SvelteKit UI
- Manages Docker containers via mounted socket
- Reads/writes stack specs and env files
- Runs cron jobs
- Manages secrets
- Handles setup wizard state

This violates the single responsibility principle. It's essentially a monolith deployed inside a "microservice" architecture.

### A5. Channel↔Gateway Communication Pattern is Synchronous Request-Response

Every channel sends a message to the gateway and **blocks waiting for the LLM to respond**. For platforms like Discord (which expects responses within 3 seconds), this is handled by deferring — but the underlying pattern means every channel is blocked on a 15-second timeout for the LLM. No queueing, no async processing, no webhooks back to channels.

---

## 6. Configuration Sprawl

The project has an extraordinary number of configuration files and env vars:

### Config Files Per Deployment
| File | Purpose |
|------|---------|
| `openpalm.yaml` | Stack spec (channels, services, automations) |
| `secrets.env` | User secrets (API keys, passwords) |
| `system.env` | Generated system config |
| `.env` (state root) | Runtime compose interpolation vars |
| `docker-compose.yml` | Generated compose file |
| `caddy.json` | Generated reverse proxy config |
| `gateway/.env` | Gateway-specific env |
| `assistant/.env` | Assistant-specific env |
| `openmemory/.env` | OpenMemory-specific env |
| `postgres/.env` | Postgres-specific env |
| `qdrant/.env` | Qdrant-specific env |
| `channel-*/.env` | Per-channel env (one per channel) |
| `service-*/.env` | Per-service env (one per service) |
| `setup-state.json` | Setup wizard state |
| `nonce-cache.json` | Nonce replay cache |
| `render-report.json` | Last render report |
| `automations/cron.schedule` | Combined cron schedule |
| `automations/scripts/*.sh` | Per-automation scripts |

That's **18+ files** for a single deployment, not counting per-channel and per-service env files. Adding 3 channels means 21+ config files.

### Environment Variables
The system uses 40+ environment variables across containers, with multiple naming conventions:
- `OPENPALM_*` (26 vars)
- `CHANNEL_*_SECRET` (per channel)
- `ADMIN_TOKEN`
- `POSTGRES_*`
- `GATEWAY_*`
- `OPENCODE_*`
- `LOG_LEVEL`, `DEBUG`
- `NO_COLOR`

---

## 7. Testing Assessment

### What's Good
- Gateway server tests (`core/gateway/src/server.test.ts`) are thorough and well-structured
- HMAC security tests are comprehensive with edge cases
- Channel adapter tests verify HMAC signing and forwarding
- Stack manager tests cover configuration mutations
- Setup manager tests cover state persistence

### What's Problematic
- **Admin API contract test** (`test/contracts/admin-api.contract.test.ts`) only checks that strings appear in a markdown documentation file — it doesn't test any actual API behavior.
- **Integration tests** require running Docker containers and are permanently skipped in CI (acknowledged in `testing-architecture-review.md`).
- **No UI unit test coverage** for most Svelte components — only 5 component test files exist for 20+ components.
- **E2E tests** (`packages/ui/e2e/`) are numbered sequentially (01-11) suggesting they must run in order — a state machine disguised as independent tests.
- **The project's own testing review** (`dev/docs/testing-architecture-review.md`) states: *"Roughly 40% of the test suite provides no meaningful safety net."*
- **Channel test files** are minimal (2-3 tests each) and only test happy path.
- No fuzz testing, no property-based testing, no load testing.

---

## 8. Recommendations

### Immediate (P0)
1. **Fix `isLocalRequest()`** — default to deny when `x-forwarded-for` is absent, or use the connection's remote address.
2. **Add real request body size limiting** — use Bun's built-in body size limits or read the body with a size-capped stream.
3. **Extract channel duplication into a shared harness** — complete the `ChannelAdapter` migration for all channels.
4. **Synchronize versions** — use a single version source (root `package.json`) and derive all others.

### Short-term (P1)
5. **Consolidate env file parsers** into a single implementation in `@openpalm/lib`.
6. **Replace module-level singletons** (nonce cache, rate limiter) with dependency injection.
7. **Add graceful shutdown** — handle SIGTERM, drain connections, flush audit log.
8. **Remove dead code** — `checkPort80()`, `resolveInContainerSocketPath()` dead branch, unused `signPayload` re-exports.
9. **Implement request-level body parsing limits** instead of trusting `content-length`.

### Medium-term (P2)
10. **Consider async queuing** for the channel→gateway→assistant pipeline to handle LLM latency.
11. **Extract infrastructure generation** (Caddy config, Docker Compose) from business logic.
12. **Consolidate `SetupState` and `StackSpec`** into a single source of truth.
13. **Add sliding window or token bucket** rate limiting.
14. **Make `StackManager` cache the parsed spec** instead of re-reading on every call.

### Long-term (P3)
15. **Evaluate whether the two-phase LLM intake is worth the cost** — consider rule-based validation as an alternative.
16. **Consider using PostgreSQL** for state management instead of flat files.
17. **Separate admin API from admin UI** into distinct services.
18. **Add structured API documentation** (OpenAPI/Swagger) for the admin API.

---

*End of review.*
