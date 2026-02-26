# OpenPalm Architecture Review

**Date:** 2026-02-25
**Scope:** Full monorepo — core services, channels, CLI, admin UI, shared library, infrastructure, testing
**Reviewer:** Automated deep-dive analysis

---

## Executive Summary

OpenPalm is a Docker Compose-based platform that routes messages from various channels (chat, Discord, Telegram, etc.) through an HMAC-secured gateway to an AI assistant runtime (OpenCode). It includes an admin UI (SvelteKit), a CLI installer, a stack configuration engine, and an automation/cron system.

The architecture has a solid conceptual foundation — the channel→gateway→assistant pipeline with two-phase LLM security filtering, HMAC-signed payloads, a declarative stack spec, and a lean admin hub are well-designed primitives appropriate for a v1 MVP. Several design decisions (file-based state, hub admin container, synchronous channel communication) are intentional simplicity choices documented in this review.

However, the codebase suffers from significant code duplication across channels, configuration sprawl, version drift, incomplete abstractions (the `ChannelAdapter` interface), dead code, and several security concerns at trust boundaries that should be addressed before wider deployment.

**Severity summary:**
- **Critical:** 5 findings (security & correctness)
- **High:** 12 findings (duplication, consistency, infrastructure)
- **Medium:** 15 findings (robustness, code quality)
- **Low:** 10 findings (cleanup, convention)

---

## Table of Contents

1. [Critical Issues](#1-critical-issues)
2. [High-Severity Issues](#2-high-severity-issues)
3. [Medium-Severity Issues](#3-medium-severity-issues)
4. [Low-Severity Issues](#4-low-severity-issues)
5. [Architecture Decisions & Concerns](#5-architecture-decisions--concerns)
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

**Remediation status (2026-02-25):** Addressed by removing the module-level singleton from `core/gateway/src/nonce-cache.ts` and injecting a `NonceCache` instance through `createGatewayFetch()` dependencies in `core/gateway/src/server.ts`. The cache is now instantiated only in the runtime entrypoint (`import.meta.main`) and cleaned up via graceful shutdown. Covered by gateway tests in `core/gateway/src/server.test.ts` and `core/gateway/src/nonce-cache.test.ts`.

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

**Remediation status (2026-02-25):** Addressed in `packages/ui` by deriving a trusted socket client address in `hooks.server.ts`, removing the `127.0.0.1` fallback, and allowing `x-forwarded-for` only when the connection source is local/private. Added API coverage in `packages/ui/test/api/03-setup-api.test.ts`.

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

**Remediation status (2026-02-25):** Shared HTTP text-channel normalization was centralized in `packages/lib/src/shared/channel-simple-text.ts`. `channels/chat/server.ts` and `channels/webhook/server.ts` now consume this helper instead of maintaining duplicated route handlers. Coverage added in `packages/lib/src/shared/channel-simple-text.test.ts`, with channel-level behavior still verified by `channels/chat/server.test.ts` and `channels/webhook/server.test.ts`. Voice channel parity was also improved by adding optional inbound token enforcement (`VOICE_INBOUND_TOKEN` / `x-voice-token`) in `channels/voice/server.ts` with tests in `channels/voice/server.test.ts`.

### H2. `ChannelAdapter` Interface is Defined but Mostly Unused

**File:** `packages/lib/src/shared/channel.ts:1-64`

The `ChannelAdapter` interface (`ChannelAdapter`, `ChannelRoute`, `InboundResult`, `ChannelPayload`) is explicitly marked `@planned` in comments: *"These types define the intended design direction... They are not yet imported or used by any channel implementation."*

Only `mcp` and `a2a` channels actually implement this interface. The `chat`, `webhook`, `voice`, `telegram`, and `discord` channels all use ad-hoc `createXxxFetch` factory functions with no shared base.

**Impact:** The codebase has two competing patterns for the same thing. The "planned" abstraction has been around long enough to accumulate two implementations, meaning it should have been completed or removed.

**Remediation status (2026-02-25):** The shared `ChannelAdapter` contract is now the canonical ingress adapter pattern across built-in channels (`chat`, `webhook`, `voice`, `telegram`, `discord`, `api`, `mcp`, `a2a`). `packages/lib/src/shared/channel.ts` was updated to reflect this as implemented architecture instead of "planned" direction. Coverage remains enforced by cross-channel server suites (`channels/chat/server.test.ts`, `channels/webhook/server.test.ts`, `channels/voice/server.test.ts`, `channels/telegram/server.test.ts`, `channels/api/server.test.ts`, `channels/discord/server.test.ts`, `channels/mcp/server.test.ts`, `channels/a2a/server.test.ts`).

### H3. MCP and A2A Server Wrappers Are Also Duplicated

**Files:** `channels/mcp/server.ts`, `channels/a2a/server.ts`

The `createFetch()` functions in both MCP and A2A servers are essentially identical (route map, health check, gateway forwarding, JSON-RPC response wrapping). The only difference is the response envelope format (MCP uses `content` array, A2A uses `artifacts` array).

**Remediation status (2026-02-25):** Shared JSON-RPC channel fetch wiring was extracted to `packages/lib/src/shared/channel-jsonrpc-fetch.ts`, and both `channels/mcp/server.ts` and `channels/a2a/server.ts` now use this helper. Per-channel response envelope differences remain isolated to their local result mappers. Behavior is covered by `channels/mcp/server.test.ts` and `channels/a2a/server.test.ts`.

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

**Remediation status (2026-02-25):** Package versions were aligned to `0.4.0` for outlier channel workspaces (`channels/webhook`, `channels/mcp`, `channels/a2a`) to remove active version drift in published workspace metadata. Alignment is guarded by package contract tests in `test/contracts/playwright-version.contract.test.ts` and `test/contracts/workspace-config.contract.test.ts` and validated by channel suites (`channels/webhook/server.test.ts`, `channels/mcp/server.test.ts`, `channels/a2a/server.test.ts`).

### H5. `any` Types Used in Multiple Locations

**Files:** `channels/chat/server.ts:27`, `channels/webhook/server.ts:29`, `channels/voice/server.ts:25-31`, `packages/ui/src/lib/api.ts:8`

```ts
let body: any;     // chat, webhook
data: any;          // api.ts ApiResult
```

Despite `strict: true` in tsconfig, `any` is used for parsed request bodies and API responses. This defeats TypeScript's type safety guarantees at critical trust boundaries (user input parsing).

**Impact:** Runtime type errors that the compiler cannot catch; possible prototype pollution.

**Remediation status (2026-02-25):** Trust-boundary handlers now avoid `any` in the cited files (`channels/chat/server.ts`, `channels/webhook/server.ts`, `channels/voice/server.ts`, `packages/ui/src/lib/api.ts`) and rely on `unknown`/typed object guards. Added contract coverage in `test/contracts/no-any-trust-boundaries.contract.test.ts`.

### H6. Env File Parser is Duplicated Three Times

The project has three separate env file parsers:
1. `packages/lib/src/env.ts` — `readEnvFile()` (async, uses `Bun.file`)
2. `packages/lib/src/admin/runtime-env.ts` — `parseRuntimeEnvContent()` (sync, string-based)
3. `core/gateway/src/server.ts:27-39` — `parseEnvContent()` (sync, inline)

All three handle comment stripping, key=value splitting, and blank line skipping with slightly different edge-case behavior (e.g., quote stripping is only in #1).

**Impact:** Inconsistent env file parsing across the system; maintenance burden.

**Remediation status (2026-02-25):** Env parsing is now centralized in `packages/lib/src/shared/env-parser.ts`, and both `packages/lib/src/env.ts` and `packages/lib/src/admin/runtime-env.ts` consume this shared parser. The previous gateway-local parser was removed in favor of `parseRuntimeEnvContent`. Added parser unit coverage in `packages/lib/src/shared/env-parser.test.ts`.

### H7. `composeServiceName()` is Duplicated

**Files:** `packages/lib/src/admin/stack-manager.ts:75-77`, `packages/lib/src/admin/stack-generator.ts:36-38`

Identical function defined in two files in the same package:
```ts
function composeServiceName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}
```

**Remediation status (2026-02-25):** Service-name normalization is centralized in `packages/lib/src/admin/service-name.ts` and consumed from both stack manager/generator paths. Added dedicated unit coverage in `packages/lib/src/admin/service-name.test.ts`.

### H8. Docker Images Use Outdated Base Image

**Files:** All Dockerfiles

```dockerfile
FROM oven/bun:1.3.5
```

All four Dockerfiles pin to Bun 1.3.5. The root `package.json` specifies `@types/bun: ^1.3.9` and the CLI requires `bun >= 1.2.0`. There's a mismatch between the Docker runtime version and the types/engine requirements, and no CI automation to keep the base image current.

**Remediation status (2026-02-25):** Bun-based container images are aligned on `FROM oven/bun:1.3.9` across core and channel Dockerfiles. Added contract coverage in `test/contracts/docker-base-image.contract.test.ts` to prevent drift.

### H9. Admin Dockerfile Installs Docker CLI Inside Container

**File:** `core/admin/Dockerfile:1-11`

The admin container installs the full Docker CE CLI (`docker-ce-cli`) to manage containers from within a container. This is a Docker-in-Docker anti-pattern. It also mounts the Docker socket (`/var/run/docker.sock`) into the container, which grants root-equivalent access to the host.

**Impact:** Security risk — any container escape or admin API compromise gives full host control.

**Remediation status (2026-02-25):** This remains an intentional architecture tradeoff for the admin control-plane container. Guardrails are now documented and tested: admin image installs Docker CLI client tooling only (no daemon), and runtime user hardening is preserved in `core/admin/Dockerfile`. Added contract coverage in `test/contracts/admin-dockerfile-security.contract.test.ts`.

### H10. `export { signPayload }` Re-exported for No Reason in Every Channel

**Files:** Every channel `server.ts`

```ts
import { signPayload } from "@openpalm/lib/shared/crypto.ts";
export { signPayload };
```

Every single channel server re-exports `signPayload` for test convenience. This is a test smell leaking into production code — the channels don't need to export this function.

**Remediation status (2026-02-25):** Channel server modules no longer import/re-export `signPayload`; signing remains encapsulated in shared adapter forwarding utilities. Added contract coverage in `test/contracts/channel-server-exports.contract.test.ts` to prevent test-only crypto exports from reappearing in production entrypoints.

### H11. No Graceful Shutdown Handling

**Files:** All `server.ts` files across channels and gateway

None of the servers implement graceful shutdown. There is no `process.on('SIGTERM')` handler, no connection draining, and no cleanup of the nonce cache prune timer. When Docker sends SIGTERM during `docker compose down`, in-flight requests are dropped.

**Remediation status (2026-02-25):** Server entrypoints now install shared graceful shutdown handling via `installGracefulShutdown(...)` across gateway and channel services, and gateway shutdown explicitly destroys nonce cache timers/resources. Added contract coverage in `test/contracts/graceful-shutdown.contract.test.ts`.

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

**Remediation status (2026-02-25):** Simplified `resolveInContainerSocketPath()` in `packages/lib/src/runtime.ts` to a single return path without a dead conditional branch. Added explicit unit coverage in `packages/lib/src/runtime.test.ts`.

---

## 3. Medium-Severity Issues

### M1. `json()` Helper Formats Responses with `JSON.stringify(data, null, 2)`

**File:** `packages/lib/src/shared/http.ts:1-6`

Every API response is pretty-printed with 2-space indentation. This increases response sizes by 20-40% for structured data, wastes bandwidth, and adds CPU overhead for every request.

**Remediation status (2026-02-25):** `packages/lib/src/shared/http.ts` now emits compact JSON (`JSON.stringify(data)`), eliminating pretty-print overhead on API responses. Added unit coverage in `packages/lib/src/shared/http.test.ts`.

### M2. Rate Limiter Uses Fixed Window Algorithm with Global Mutable State

**File:** `core/gateway/src/rate-limit.ts`

The rate limiter uses a simple fixed-window counter stored in a global `Map`. This has several issues:
- Not distributed: rate limits are per-process, so horizontal scaling resets limits.
- Burst vulnerability: a client can send 120 requests at window boundary and 120 at the start of the next, getting 240 requests in under 1 second.
- Global mutable singleton: impossible to reset between tests without module-level side effects.

**Remediation status (2026-02-25):** Gateway now uses explicit `RateLimiter` instances without module-level singleton exports (`core/gateway/src/rate-limit.ts`), and tests instantiate isolated limiters per test case (`core/gateway/src/rate-limit.test.ts`). The implementation uses timestamp-based sliding windows rather than fixed window counters.

### M3. Audit Log Has Single-File Rotation with No Compression

**File:** `core/gateway/src/audit.ts`

The audit log rotates at 50MB by renaming to `.1`, but:
- Only keeps one rotated file (the next rotation overwrites `.1`).
- No compression — 50MB+ of JSON lines sitting on disk.
- No configurable retention policy.

**Remediation status (2026-02-25):** Audit rotation now writes gzip-compressed files with configurable retention and max file size in `core/gateway/src/audit.ts` (`OPENPALM_AUDIT_RETENTION_COUNT`, `OPENPALM_AUDIT_MAX_FILE_SIZE`). Added rotation/retention coverage in `core/gateway/src/audit.test.ts`.

### M4. `StackManager` Reads and Writes Files Synchronously on Every Operation

**File:** `packages/lib/src/admin/stack-manager.ts`

Every method (`getSpec()`, `setSpec()`, `setChannelAccess()`, etc.) calls `readFileSync()` and `writeFileSync()`. For the admin UI serving concurrent requests, this blocks the event loop on filesystem I/O. The `getSpec()` call alone re-reads and re-parses the YAML file on every single invocation.

**Remediation status (2026-02-25):** `StackManager` now caches parsed spec/secrets/runtime env content in-memory between operations (`cachedSpec`, `cachedSecrets`, `runtimeEnvCache`) to reduce repeated read/parse overhead while retaining deterministic file outputs. Added cache behavior coverage in `packages/lib/src/admin/stack-manager.test.ts`.

### M5. CLI Argument Parser is Hand-Rolled

**File:** `packages/cli/src/main.ts:76-106`

The CLI implements its own argument parser (`parseArg`, `hasFlag`, `getPositionalArgs`) rather than using an established library. The parser doesn't handle edge cases like `--flag=value` syntax, combined short flags, or `--` separator.

**Remediation status (2026-02-25):** CLI argument parsing is now centralized on Node's `parseArgs` in `packages/cli/src/main.ts`, with parser behavior validated in `packages/cli/src/main-args.test.ts` (including `--flag=value`, `--` positional separator, and boolean flags). CLI entrypoint invocation is gated with `import.meta.main` to enable deterministic parser unit tests.

### M6. `confirm()` Function Leaks Stdin Reader

**File:** `packages/lib/src/ui.ts:129-150`

```ts
const reader = Bun.stdin.stream().getReader();
// ... reads ...
reader.releaseLock();
```

The reader is released but the underlying stream is not closed. Calling `confirm()` multiple times may create multiple readers on the same stream.

**Remediation status (2026-02-25):** `confirm()` now uses `node:readline/promises.createInterface(...)` and always closes the interface after each prompt in `packages/lib/src/ui.ts`, avoiding stdin reader leakage. Added unit coverage in `packages/lib/src/ui.test.ts` to verify prompt behavior and `close()` invocation per call.

### M7. Setup Wizard State and Stack Spec Are Redundant

**Files:** `packages/lib/src/admin/setup-manager.ts`, `packages/lib/src/admin/stack-spec.ts`

Both `SetupState` and `StackSpec` track `accessScope` and `enabledChannels`. The setup wizard writes to `SetupState`, and separately the stack manager writes to `StackSpec`. These can drift apart, creating confusion about which is the source of truth.

**Remediation status (2026-02-25):** Setup manager now synchronizes `accessScope` and `enabledChannels` with stack spec when `stackSpecPath` is configured (`withMutableStackSpec` + `withStackSpecState` in `packages/lib/src/admin/setup-manager.ts`). Added synchronization coverage in `packages/lib/src/admin/setup-manager.test.ts`.

### M8. UI Package Named `"ui"` Not `"@openpalm/ui"`

**File:** `packages/ui/package.json:2`

```json
{ "name": "ui" }
```

Unlike all other packages (`@openpalm/lib`, `@openpalm/gateway`, etc.), the UI package is just named `"ui"`. This breaks the naming convention and could collide with other packages in a monorepo context.

**Remediation status (2026-02-25):** UI package naming is aligned to `@openpalm/ui` in `packages/ui/package.json`. Added contract coverage in `test/contracts/workspace-config.contract.test.ts`.

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

**Remediation status (2026-02-25):** Root `tsconfig.json` no longer includes `packages/ui/src/**/*.ts` while still excluding `packages/ui`, removing contradictory config. Added contract coverage in `test/contracts/workspace-config.contract.test.ts`.

### M10. `checkPort80()` is Deprecated but Still Exported

**File:** `packages/lib/src/preflight.ts:87-89`

```ts
/** @deprecated Use checkPort() instead. */
export async function checkPort80(): Promise<PreflightWarning | null> {
  return checkPort(80);
}
```

A deprecated function that's still part of the public API. Should be removed.

**Remediation status (2026-02-25):** The deprecated `checkPort80()` shim has been removed from `packages/lib/src/preflight.ts`. Consumers now use `checkPort()`/`checkPortDetailed()` only. Export-surface coverage was added in `packages/lib/src/preflight.test.ts` to prevent reintroduction.

### M11. Nonce Cache Persists to Disk on Every Single Request

**File:** `core/gateway/src/nonce-cache.ts:41-43`

Every `checkAndStore()` call writes the entire nonce map to disk via `persistToDisk()`. For high-throughput scenarios, this is a filesystem write per inbound request.

**Remediation status (2026-02-25):** Nonce persistence is debounced in `core/gateway/src/nonce-cache.ts` (`schedulePersist()` with `PERSIST_DEBOUNCE_MS`) so accepted requests do not perform synchronous disk writes per call. Added coverage in `core/gateway/src/nonce-cache.test.ts` to verify persistence is deferred and flushed on shutdown.

### M12. No Input Sanitization on Metadata Fields

**Files:** All channel `server.ts` files

User-supplied `metadata` objects from request bodies are passed through unvalidated:
```ts
metadata: body.metadata ?? {}
```

No type checking, no depth limiting, no key filtering. A client can send arbitrarily nested metadata that gets forwarded to the gateway and stored in audit logs.

**Remediation status (2026-02-25):** Metadata sanitization is now centralized in `packages/lib/src/shared/metadata.ts` and applied to untrusted HTTP metadata inputs in `packages/lib/src/shared/channel-simple-text.ts` (chat/webhook) and `channels/voice/server.ts`. Sanitization enforces depth/key limits, truncates oversized strings, and drops prototype-pollution keys. Coverage added in `packages/lib/src/shared/metadata.test.ts`, `packages/lib/src/shared/channel-simple-text.test.ts`, and `channels/voice/server.test.ts`.

### M13. OpenCode Client Has No Retry Logic

**File:** `core/gateway/src/assistant-client.ts`

The `OpenCodeClient` has no retry logic for transient failures (network timeouts, 503s). If the assistant is briefly unavailable (e.g., during container restart), every request immediately fails with a 502.

**Remediation status (2026-02-25):** `OpenCodeClient` now retries transient failures with bounded exponential backoff (`OPENCODE_RETRIES`, `OPENCODE_RETRY_BASE_DELAY_MS`) and preserves timeout behavior. Retry coverage was expanded in `core/gateway/src/assistant-client.test.ts` to verify retry-on-503 success and no-retry behavior for non-retryable 400 responses.

### M14. `@playwright/test` Version Mismatch Between Admin and UI

**Files:** `core/admin/package.json`, `packages/ui/package.json`

```
core/admin: "@playwright/test": "^1.40.0"
packages/ui: "@playwright/test": "^1.58.1"
```

Major version gap (1.40 vs 1.58) for the same test framework in the same monorepo.

**Remediation status (2026-02-25):** `@playwright/test` is aligned at `^1.58.1` in both `core/admin/package.json` and `packages/ui/package.json`. Added contract coverage in `test/contracts/playwright-version.contract.test.ts` to prevent future version drift.

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

**Remediation status (2026-02-25):** `core/assistant` is no longer listed in root workspace members (`package.json`), while still retained as an image/build context and versioned component. Added contract coverage in `test/contracts/workspace-config.contract.test.ts`.

---

## 4. Low-Severity Issues

### L4. `bunfig.toml` Contains Only Install Configuration

**File:** `bunfig.toml`

```toml
[install]
peer = false
```

A configuration file that exists only to disable peer dependency installation.

**Remediation status (2026-02-25):** `bunfig.toml` now carries meaningful workspace policy (test discovery/exclusions and frozen installs) rather than a single peer-install toggle. Added guard coverage in `test/contracts/bunfig.contract.test.ts`.

### L9. `export * from` Barrel File Re-exports Everything

**File:** `packages/lib/src/index.ts`

All 14 modules are re-exported via `export *`. This makes the public API surface implicit — consumers can import any symbol from any sub-module. There's no API boundary.

**Remediation status (2026-02-25):** `packages/lib/src/index.ts` now uses explicit named/type exports to define an intentional public API surface instead of blanket `export *` re-exports. Added guard coverage in `packages/lib/src/index.test.ts`.

### L10. Unused `compose-runner.ts` Import in `packages/lib/src/compose.ts`

**File:** `packages/lib/src/compose.ts:2`

The `compose.ts` file imports from `./compose-runner.ts`. Meanwhile, there's also a `packages/lib/src/admin/compose-runner.ts` with different functionality. Having two `compose-runner` files at different levels is confusing.

**Remediation status (2026-02-25):** Compose execution is consolidated on a single shared runner implementation in `packages/lib/src/compose-runner.ts`; admin compose utilities in `packages/lib/src/admin/compose-runner.ts` delegate to this shared path rather than implementing a parallel execution stack. Added contract coverage in `test/contracts/compose-runner-path.contract.test.ts`.
