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

### L4. `bunfig.toml` Contains Only Install Configuration

**File:** `bunfig.toml`

```toml
[install]
peer = false
```

A configuration file that exists only to disable peer dependency installation.

### L9. `export * from` Barrel File Re-exports Everything

**File:** `packages/lib/src/index.ts`

All 14 modules are re-exported via `export *`. This makes the public API surface implicit — consumers can import any symbol from any sub-module. There's no API boundary.

### L10. Unused `compose-runner.ts` Import in `packages/lib/src/compose.ts`

**File:** `packages/lib/src/compose.ts:2`

The `compose.ts` file imports from `./compose-runner.ts`. Meanwhile, there's also a `packages/lib/src/admin/compose-runner.ts` with different functionality. Having two `compose-runner` files at different levels is confusing.
