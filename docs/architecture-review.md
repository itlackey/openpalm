# OpenPalm Comprehensive Architecture Review

**Date**: 2026-02-21
**Version Reviewed**: v0.1.1
**Reviewer**: bun-node-architect agent

## Executive Summary

OpenPalm is an early-stage (v0.1.1) self-hosted AI assistant platform with a well-conceived architecture: channel adapters normalize messages, a gateway enforces security (HMAC, rate limiting, intake validation), and an OpenCode runtime handles AI processing. The codebase demonstrates strong fundamentals -- clean separation of concerns, consistent patterns, type-safe interfaces, and a thoughtful shared library. However, several issues across security, maintainability, and code quality should be addressed before any production exposure.

**Total issues found: 38** (2 Critical, 10 High, 18 Medium, 10 Low)

---

## 1. Architecture

### 1.1 [High] Duplicated `ChannelMessage` type across gateway and shared lib

The gateway defines its own `ChannelMessage` type in `gateway/src/types.ts` (lines 1-9) with an `attachments` field, while the shared library defines a separate `ChannelMessage` in `packages/lib/src/shared/channel-sdk.ts` (lines 3-10) without `attachments`. The `ChannelPayload` type in `packages/lib/src/shared/channel.ts` (lines 20-25) is yet a third variant. This creates three overlapping message shapes for what should be a single contract. If a channel adapter adds metadata fields expecting one shape, the gateway may silently ignore them.

### 1.2 [High] Duplicated `json()` helper and `signPayload`/`verifySignature` across gateway and shared lib

The gateway at `gateway/src/server.ts` lines 28-33 defines its own `json()` helper identical to the one exported from `@openpalm/lib/shared/http.ts`. The gateway also duplicates the entire HMAC implementation in `gateway/src/channel-security.ts`, which is character-for-character identical to `packages/lib/src/shared/crypto.ts`. The gateway should import from the shared library instead. This is a maintenance risk -- a bug fix in one copy would not propagate to the other.

### 1.3 [Medium] `ChannelAdapter` interface defined but never used

The `ChannelAdapter`, `ChannelRoute`, and `HealthStatus` types in `packages/lib/src/shared/channel.ts` are exported but no channel adapter actually implements this interface. Instead, each channel exports a `createXxxFetch` factory function returning a raw `(req: Request) => Promise<Response>`. The interface represents a good design direction but is currently dead code. Either remove it or refactor channel adapters to use it.

### 1.4 [Medium] Admin server is a monolithic 781-line fetch handler

`admin/src/server.ts` contains a single massive `fetch()` function with over 40 route handlers implemented as sequential `if` statements. This file is the hardest to navigate in the entire codebase. Extracting route handlers into separate modules (or at minimum a router pattern) would significantly improve maintainability.

### 1.5 [Medium] Dual API surface with identical logic

The admin server exposes the same operations through two parallel APIs:
- REST-style endpoints (`/admin/setup/access-scope`, `/admin/setup/channels`, etc.)
- Command-based endpoint (`/admin/command` with `type: "setup.access_scope"`, `type: "setup.channels"`, etc.)

Both are wired to the same underlying logic but have independent implementations. For example, channel setup logic appears at lines 313-326 (command style) and again at lines 503-529 (REST style). This doubles the bug surface and maintenance cost.

### 1.6 [Low] Webhook channel not in stack spec or compose definitions

The webhook channel exists as a workspace (`channels/webhook/`), has a Dockerfile, server, and tests, but it is not listed in the `docker-compose.yml`, not in the `ALLOWED_CHANNELS` set in the gateway, not in `BuiltInChannelNames`, and not in `stack-spec.json`. It is essentially dead code that would fail silently if someone tried to use it.

### 1.7 [Low] Flat Docker network topology

All services share a single `assistant_net` network. There is no network segmentation between the security-sensitive gateway, the admin with Docker socket access, the database layer, and the channel adapters. In a production deployment, a compromised channel adapter could reach PostgreSQL, Qdrant, or the Docker socket (via admin).

---

## 2. Security

### 2.1 [Critical] Empty HMAC secrets accepted and verify as valid

In `gateway/src/server.ts` line 193, an empty `channelSecret` correctly returns `channel_not_configured`. However, the shared library's HMAC functions and the gateway's copy both allow signing and verifying with an empty secret string. The test at `gateway/src/channel-security.test.ts` lines 20-25 even demonstrates this: `signPayload("", body)` succeeds and `verifySignature("", body, sig)` returns `true`. If a channel secret is accidentally left empty in the environment (which is the default in `stack-spec.json` -- all channel secrets default to `""`), the HMAC provides zero protection. The `signPayload` and `verifySignature` functions should reject empty secrets.

### 2.2 [Critical] Admin token comparison is not timing-safe

In `admin/src/server.ts` line 87:
```typescript
function auth(req: Request) {
  return req.headers.get("x-admin-token") === ADMIN_TOKEN;
}
```
This is a plain string equality check, vulnerable to timing attacks. The gateway correctly uses `timingSafeEqual` for HMAC verification, but the admin token (which grants Docker socket access, secret management, and full system control) uses a naive comparison.

### 2.3 [High] Admin CORS allows all origins

In `admin/src/server.ts` line 79:
```typescript
resp.headers.set("access-control-allow-origin", "*");
```
Combined with the `x-admin-token` header-based auth, this means any website visited by a user on the same network could make authenticated cross-origin requests to the admin API if the token is in a cookie or local storage. While the current UI sends the token as a header (which requires a preflight), the wildcard CORS policy is unnecessarily permissive.

### 2.4 [High] Default admin token logged as warning but still functional

`admin/src/server.ts` lines 778-780 log a warning when the default token `"change-me-admin-token"` is used, but the server continues to operate. In production, this default token grants full admin access including Docker socket control.

### 2.5 [High] `secret.raw.set` command allows arbitrary file write to secrets.env

`admin/src/server.ts` lines 339-344 accept arbitrary string content and write it directly to the secrets env file. There is no validation that the content is valid env file format, no size limit, and no sanitization. A malicious or buggy client could write arbitrary content.

### 2.6 [Medium] Setup endpoints allow unauthenticated writes before completion

Multiple setup endpoints (`/admin/setup/status`, `/admin/setup/step`, `/admin/setup/service-instances`, `/admin/setup/channels`) are accessible without authentication during first-boot setup. While this is necessary for the setup wizard UX, it means any device on the LAN can complete the setup wizard and set API keys, access scopes, and channel configurations before the legitimate user does.

### 2.7 [Medium] Nonce in channel messages is not verified

The `buildChannelMessage` function generates a `nonce` (UUID) and `timestamp`, but the gateway never checks for nonce replay or timestamp freshness. An attacker who captures a valid signed message can replay it indefinitely.

### 2.8 [Medium] Rate limiting keyed only on userId, which is self-reported

In `gateway/src/server.ts` line 54, rate limiting uses `payload.userId` as the key. But `userId` comes from the payload body, which is set by the channel adapter (e.g., `body.userId ?? "chat-user"`). An attacker can trivially bypass rate limiting by rotating userId values.

### 2.9 [Low] Docker socket mounted into admin container

The admin container has the Docker socket mounted (`/var/run/docker.sock`), giving it full Docker API access. Combined with the other security issues above, this significantly amplifies the blast radius of any admin compromise.

---

## 3. Code Quality

### 3.1 [High] `normalizeState` in setup-manager silently drops "public" scope

In `packages/lib/admin/setup-manager.ts` line 97:
```typescript
const accessScope = parsed.accessScope === "lan" ? "lan" : "host";
```
This only recognizes "lan" and defaults everything else to "host", including the valid "public" scope. Yet `setAccessScope` at line 139 accepts `"host" | "lan" | "public"`. If a user sets scope to "public", saves, and the server restarts, the state file would be read back and silently converted to "host".

### 3.2 [High] Inconsistent type safety for `body.payload` in admin command handler

Throughout the admin server's command handler (`/admin/command`), `payload` is typed as `Record<string, unknown>`, but individual properties are accessed without runtime validation. For example, `payload.spec` at line 246, `payload.scope` at line 277, `payload.service` at line 363 -- all accessed as-is. While `sanitizeEnvScalar` is used for some values, the overall pattern is inconsistent. Some paths validate, some do not.

### 3.3 [Medium] `env.ts` reads entire file for every `upsertEnvVar` call

In `packages/lib/src/env.ts`, `upsertEnvVar` reads and writes the entire file for each key. The `install.ts` command calls `upsertEnvVar` 11 times sequentially (lines 130-140), performing 11 read-write cycles on the same file. This should be batched.

### 3.4 [Medium] Synchronous file I/O throughout admin service

The admin server uses `readFileSync`, `writeFileSync`, `existsSync`, `mkdirSync` extensively (the imports at line 1 of `server.ts`). For a Bun.serve handler, synchronous I/O blocks the event loop during every request. This is particularly concerning in `renderArtifacts()`, which writes many files synchronously per call.

### 3.5 [Medium] Compose YAML generated via string concatenation

`packages/lib/admin/stack-generator.ts` generates Docker Compose YAML through string array joining. This is fragile -- any change to indentation or quoting can produce invalid YAML. A proper YAML library or at minimum a structured template system would be safer. The fact that `composeConfigValidate()` is called in `applyStack` helps catch errors, but only after files are written.

### 3.6 [Medium] Error handling in admin command handler catches all errors as 400

In `admin/src/server.ts` line 376:
```typescript
} catch (error) {
  return cors(json(400, { ok: false, error: String(error), code: "command_failed" }));
}
```
All errors from any command are returned as HTTP 400 with the raw error message. This conflates client errors (bad input) with server errors (file system failures, compose failures), and may leak internal error details.

### 3.7 [Low] `caddyGuardHandler` has unused `ranges` parameter

In `packages/lib/admin/stack-generator.ts` line 99:
```typescript
function caddyGuardHandler(ranges: string[]): Record<string, unknown> {
```
The `ranges` parameter is never used in the function body. This is likely a leftover from a refactor.

### 3.8 [Low] Version string duplicated in CLI and package.json

The version `"0.1.1"` appears in `packages/cli/src/main.ts` line 16, `package.json`, `admin/package.json`, `gateway/package.json`, `assistant/package.json`. While there is a `dev/version.ts` script, the CLI still has a hardcoded string that can drift.

---

## 4. Testing

### 4.1 [High] No tests for the shared library (`packages/lib/src/`)

None of the core shared library files have test files: `env.ts`, `paths.ts`, `runtime.ts`, `tokens.ts`, `assets.ts`, `compose.ts`, `config.ts`, `preflight.ts`, `detect-providers.ts`, `ui.ts`, and the `shared/` modules. These are used by every service in the system. The env parsing, token generation, and XDG path resolution are particularly important to test.

### 4.2 [High] Security tests are minimal

`test/security/hmac.security.test.ts` contains a single test case (2 assertions). `test/security/input-bounds.security.test.ts` has one test. For a system where the gateway is the primary security boundary, this is insufficient. Missing tests include: HMAC replay, timestamp validation, empty secrets, oversized payloads, header injection, auth bypass, rate limit bypass.

### 4.3 [Medium] Contract test re-defines ChannelMessage type instead of importing it

`test/contracts/channel-message.contract.test.ts` defines its own `ChannelMessage` type locally (lines 3-9) rather than importing from the shared library. If the actual type changes, the contract test would not catch the drift -- defeating its purpose.

### 4.4 [Medium] Admin API contract test checks docs, not API

`test/contracts/admin-api.contract.test.ts` reads the API reference markdown file and checks for string presence. This tests documentation content, not actual API behavior. Some assertions check for endpoints that do not exist (e.g., `/admin/plugins/install` is checked as present, but no such endpoint exists in the server).

### 4.5 [Medium] Admin E2E tests assert `[200, 401]` ambiguously

Several tests in `admin/src/admin-e2e.test.ts` use `expect([200,401]).toContain(r.status)`. This means the test passes regardless of whether auth works or not. These should be deterministic -- either the test sends auth and expects 200, or it does not and expects 401.

### 4.6 [Low] No tests for CLI commands

No test files exist in `packages/cli/`. The install, uninstall, update, start, stop, restart, and extensions commands are all untested.

### 4.7 [Low] Rate limit test relies on `Bun.sleep(15)` timing

`gateway/src/rate-limit.test.ts` line 17 uses `Bun.sleep(15)` to test window expiry. This can flake on slow CI.

---

## 5. Maintainability

### 5.1 [High] `packages/lib` has two separate module structures with unclear boundaries

The lib package has two top-level directories: `src/` (re-exported from index.ts) and `admin/` (imported directly). The `src/` directory also has a `shared/` subdirectory. The exports map in `package.json` has four patterns:
```json
".": "./src/index.ts",
"./*.ts": "./src/*.ts",
"./admin/*.ts": "./admin/*.ts",
"./shared/*.ts": "./src/shared/*.ts"
```
The channel adapters import from `@openpalm/lib/shared/channel-sdk.ts`. The admin server imports from `@openpalm/lib/admin/setup-manager.ts`. The CLI imports from `@openpalm/lib/ui.ts`. There is no clear documentation of which path pattern to use and when.

### 5.2 [Medium] Docker images pinned to Bun 1.1.42 but no lockfile mechanism

All Dockerfiles use `FROM oven/bun:1.1.42`. The host `@types/bun` is `^1.3.9`. There is no guarantee these are compatible. The Bun version should be coordinated across Dockerfiles and the type definitions.

### 5.3 [Medium] Admin Dockerfile copies `packages/lib` as `node_modules/@openpalm/lib`

In `admin/Dockerfile` line 12:
```dockerfile
COPY packages/lib /app/node_modules/@openpalm/lib
```
This is a build-time workaround for the Bun workspace resolution not being available in Docker. It copies the raw TypeScript source. If the lib structure changes, the Dockerfile path must be manually updated. The same pattern appears in all channel Dockerfiles.

### 5.4 [Medium] No structured logging

The gateway logs structured JSON at startup (`console.log(JSON.stringify(...))`), but the audit log uses its own format, and the admin server uses `console.error` and `console.warn` with free-form strings. There is no consistent logging strategy.

### 5.5 [Low] `CLAUDE.md` is gitignored

`.gitignore` includes `CLAUDE.md`, yet it exists in the repo (checked in at the last commit). This means local modifications to CLAUDE.md would be invisible to `git status`.

---

## 6. Configuration and DevEx

### 6.1 [Medium] `.env` file checked into the repo with real paths

The `.env` file at the root contains absolute paths like `/home/founder3/code/github/itlackey/openpalm/.dev/data`. While `.env` is in `.gitignore`, the file currently exists in the working tree. New developers cloning the repo would not have this file, and the dev setup script generates it. The concern is that any accidental `git add -A` could commit machine-specific paths.

### 6.2 [Medium] Dev overlay has inconsistent COMPOSE_PROJECT_PATH values

In `dev/docker-compose.dev.yml`, admin's `COMPOSE_PROJECT_PATH` is set to `/compose`, and the repo root is mounted as `.:/compose:ro`. But in production compose, it is `/state`. The `compose-runner.ts` defaults to `/workspace`. Three different default values across three contexts creates confusion.

### 6.3 [Low] Stack spec version migration is lenient

`parseStackSpec` accepts both version 1 and version 2 (`if (version !== 1 && version !== 2)`) but always outputs version 2. There is no migration logic -- a version 1 spec would pass validation but might have a different schema that silently produces incorrect artifacts.

### 6.4 [Low] `qdrant:latest` in compose file

The Qdrant image uses `:latest` tag which can cause reproducibility issues and unexpected breaking changes on container restart.

---

## 7. Integration Points

### 7.1 [High] AI-powered intake validation is a reliability bottleneck

The gateway's intake validation (`buildIntakeCommand` in `gateway/src/channel-intake.ts`) sends every inbound message to the AI runtime for safety screening before processing. This means:
- Every message requires two LLM calls (intake + actual processing)
- If the AI returns malformed JSON or non-JSON text, the message is rejected (502)
- The `extractJsonObject` parser is brittle -- it takes the first `{` and last `}`, which can break on nested objects in prose
- There is a 15-second timeout per LLM call, so a single message can take up to 30 seconds

This is a significant latency and cost multiplier. Consider making intake validation optional or rules-based with LLM as a fallback.

### 7.2 [Medium] Gateway has no retry logic for AI runtime calls

`OpenCodeClient.send()` in `gateway/src/assistant-client.ts` makes a single attempt. If the assistant returns a transient error (503, timeout), the user gets a 502 with no retry. For a self-hosted system where the assistant may be restarting, at least one retry with backoff would improve reliability.

### 7.3 [Medium] Caddy config generation outputs both Caddyfile and JSON formats

The `stack-generator.ts` generates a Caddy JSON config, and the static `Caddyfile` also exists in `assets/state/caddy/Caddyfile`. The production compose mounts the Caddyfile, but the generated compose switches to `caddy run --config /etc/caddy/caddy.json`. During the install flow, a minimal Caddyfile is written. This dual-format approach creates confusion about which config is active at any given time.

### 7.4 [Low] `applyStack` calls `renderArtifacts` twice

In `packages/lib/admin/stack-apply-engine.ts`, `applyStack` first calls `manager.renderPreview()` (line 142) to compute diff, then calls `manager.renderArtifacts()` (line 158) to write files. But `renderArtifacts` internally calls `renderPreview()` again (line 104 of stack-manager.ts). The generation is duplicated on every apply.

---

## 8. Dependencies and Package Management

### 8.1 [Medium] No production dependencies declared in workspace packages

`gateway/package.json` and all channel `package.json` files have zero dependencies. The `admin/package.json` is not shown but also appears minimal. All runtime code depends on `@openpalm/lib` via workspace resolution and built-in Bun APIs. This works in development but the Docker builds rely on the `COPY packages/lib /app/node_modules/@openpalm/lib` workaround (section 5.3), which could break with any structural change.

### 8.2 [Low] Only one devDependency at root level

The root `package.json` has only `@types/bun` as a devDependency. No linter, formatter, or any code quality tool is configured. While the codebase conventions doc says "No linter/formatter configured", adding at minimum `tsc --noEmit` to CI (which exists as `bun run typecheck`) is good. But there is no evidence of CI running.

---

## Priority Summary

### Critical (fix immediately)
| # | Issue | Section |
|---|-------|---------|
| 1 | Empty HMAC secrets accepted | 2.1 |
| 2 | Admin token not timing-safe compared | 2.2 |

### High (fix before any production use)
| # | Issue | Section |
|---|-------|---------|
| 1 | Duplicated ChannelMessage types | 1.1 |
| 2 | Duplicated HMAC/json code between gateway and lib | 1.2 |
| 3 | normalizeState drops "public" scope | 3.1 |
| 4 | Inconsistent type validation in admin commands | 3.2 |
| 5 | No tests for shared library | 4.1 |
| 6 | Minimal security tests | 4.2 |
| 7 | AI-powered intake as reliability bottleneck | 7.1 |
| 8 | Admin CORS wildcard | 2.3 |
| 9 | Default admin token functional in production | 2.4 |
| 10 | Arbitrary write via secret.raw.set | 2.5 |

### Medium (improve before v1.0)
| # | Issue | Section |
|---|-------|---------|
| 1 | ChannelAdapter interface unused | 1.3 |
| 2 | Monolithic admin server | 1.4 |
| 3 | Dual API surface | 1.5 |
| 4 | Unauthenticated setup endpoints | 2.6 |
| 5 | No nonce/replay protection | 2.7 |
| 6 | Rate limit bypass via userId rotation | 2.8 |
| 7 | Sequential env file writes | 3.3 |
| 8 | Sync I/O in admin server | 3.4 |
| 9 | YAML generation via strings | 3.5 |
| 10 | Error flattening to 400 | 3.6 |
| 11 | Contract test type drift | 4.3 |
| 12 | Ambiguous auth test assertions | 4.5 |
| 13 | Unclear lib module boundaries | 5.1 |
| 14 | Bun version pinning mismatch | 5.2 |
| 15 | No structured logging | 5.4 |
| 16 | Docker node_modules workaround | 5.3 |
| 17 | No retry in gateway AI client | 7.2 |
| 18 | Dual Caddy config formats | 7.3 |

### Low (nice to have)
| # | Issue | Section |
|---|-------|---------|
| 1 | Webhook channel dead code | 1.6 |
| 2 | Flat Docker network | 1.7 |
| 3 | Unused function parameter | 3.7 |
| 4 | Version string duplication | 3.8 |
| 5 | No CLI tests | 4.6 |
| 6 | Timing-sensitive rate limit test | 4.7 |
| 7 | CLAUDE.md gitignore conflict | 5.5 |
| 8 | Stack spec version migration | 6.3 |
| 9 | qdrant:latest tag | 6.4 |
| 10 | Double renderPreview call | 7.4 |
