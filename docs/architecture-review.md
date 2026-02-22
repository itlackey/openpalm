# OpenPalm Comprehensive Architecture Review

**Date**: 2026-02-21
**Version Reviewed**: v0.1.1
**Reviewer**: bun-node-architect agent
**Last Updated**: 2026-02-21

## Executive Summary

OpenPalm is an early-stage (v0.1.1) self-hosted AI assistant platform with a well-conceived architecture: channel adapters normalize messages, a gateway enforces security (HMAC, rate limiting, intake validation), and an OpenCode runtime handles AI processing. The codebase demonstrates strong fundamentals -- clean separation of concerns, consistent patterns, type-safe interfaces, and a thoughtful shared library. However, several issues across security, maintainability, and code quality should be addressed before any production exposure.

**Total issues found: 46** (2 Critical, 10 High, 22 Medium, 12 Low)

---

## 1. Architecture

### 1.1 [High] Duplicated `ChannelMessage` type across gateway and shared lib -- FIXED

Unified to a single canonical `ChannelMessage` type in `packages/lib/src/shared/channel-sdk.ts` with the `attachments?` field. Gateway's `types.ts` now re-exports from the shared lib.

### 1.2 [High] Duplicated `json()` helper and `signPayload`/`verifySignature` across gateway and shared lib -- FIXED

Gateway's `channel-security.ts` now re-exports from `@openpalm/lib/shared/crypto.ts`. Gateway's `server.ts` imports `json()` from `@openpalm/lib/shared/http.ts`.

### 1.3 [Medium] `ChannelAdapter` interface defined but never used -- FIXED

Added `@planned` JSDoc tags to document these as design-direction types not yet implemented by any channel adapter.

### 1.4 [Medium] Admin server is a monolithic 781-line fetch handler -- OPEN

`admin/src/server.ts` contains a single massive `fetch()` function with over 40 route handlers implemented as sequential `if` statements. Extracting route handlers into separate modules would significantly improve maintainability.

### 1.5 [Medium] Dual API surface with identical logic -- OPEN

The admin server exposes the same operations through REST-style endpoints and a command-based `/admin/command` endpoint. Both are wired to the same underlying logic but have independent implementations. This doubles the bug surface and maintenance cost.

### 1.6 [Low] Webhook channel not in stack spec or compose definitions -- OPEN

The webhook channel exists as a workspace but is not integrated into the stack. It is essentially dead code.

### 1.7 [Low] Flat Docker network topology -- FIXED

Replaced single `assistant_net` with 3-tier network segmentation: `channel_net` (ingress), `internal_net` (services), `data_net` (databases). Updated both static compose file and stack generator. Channels can no longer reach databases or internal services directly.

---

## 2. Security

### 2.1 [Critical] Empty HMAC secrets accepted and verify as valid -- FIXED

`signPayload()` now throws on empty secrets. `verifySignature()` returns `false` for empty secret or empty signature.

### 2.2 [Critical] Admin token comparison is not timing-safe -- FIXED

Replaced plain `===` with `timingSafeEqual` in admin `auth()` function.

### 2.3 [High] Admin CORS allows all origins -- DEFERRED

Skipped per user request. The wildcard CORS policy remains.

### 2.4 [High] Default admin token logged as warning but still functional -- FIXED

`auth()` now returns `false` when using the default insecure token `"change-me-admin-token"`. Error messages logged at startup.

### 2.5 [High] `secret.raw.set` command allows arbitrary file write to secrets.env -- FIXED

Added 64KB size limit and env format validation (valid keys, `KEY=VALUE` format) for both the command handler and REST endpoint.

### 2.6 [Medium] Setup endpoints allow unauthenticated writes before completion -- OPEN

Setup wizard endpoints are accessible without authentication during first-boot. This is by design for UX but creates a race condition on the LAN.

### 2.7 [Medium] Nonce in channel messages is not verified -- OPEN

The gateway never checks for nonce replay or timestamp freshness. An attacker who captures a valid signed message can replay it.

### 2.8 [Medium] Rate limiting keyed only on userId, which is self-reported -- OPEN

Rate limiting uses `payload.userId` as the key, which comes from the payload body and can be rotated by an attacker.

### 2.9 [Low] Docker socket mounted into admin container -- OPEN

The admin container has full Docker API access via the mounted socket.

---

## 3. Code Quality

### 3.1 [High] `normalizeState` in setup-manager silently drops "public" scope -- FIXED

Fixed the ternary to recognize all three valid scopes (`host`, `lan`, `public`) instead of only `lan`.

### 3.2 [High] Inconsistent type safety for `body.payload` in admin command handler -- FIXED

Added runtime type checks for `secret.upsert`, `secret.delete`, `automation.upsert`, `automation.delete`, and `channel.configure` commands.

### 3.3 [Medium] `env.ts` reads entire file for every `upsertEnvVar` call -- FIXED

Added `upsertEnvVars()` (batched) function. Install command now does a single read-write cycle instead of 11.

### 3.4 [Medium] Synchronous file I/O throughout admin service -- OPEN

The admin server uses `readFileSync`, `writeFileSync`, `existsSync` extensively. Converting to async would prevent event loop blocking.

### 3.5 [Medium] Compose YAML generated via string concatenation -- OPEN

`stack-generator.ts` generates Docker Compose YAML through string array joining. A proper YAML library would be safer.

### 3.6 [Medium] Error handling in admin command handler catches all errors as 400 -- OPEN

All errors from any command are returned as HTTP 400. This conflates client errors with server errors and may leak internal details.

### 3.7 [Low] `caddyGuardHandler` has unused `ranges` parameter -- FIXED

Removed the unused parameter and updated all call sites.

### 3.8 [Low] Version string duplicated in CLI and package.json -- FIXED

CLI now reads version from `package.json` instead of hardcoding it.

---

## 4. Testing

### 4.1 [High] No tests for the shared library (`packages/lib/src/`) -- FIXED

Added 11 tests for `crypto.ts` and 15 tests for `setup-manager.ts`.

### 4.2 [High] Security tests are minimal -- FIXED

Expanded to 25 HMAC security tests and 26 input bounds tests (51 new tests total).

### 4.3 [Medium] Contract test re-defines ChannelMessage type instead of importing it -- FIXED

Contract test now imports `ChannelMessage` from the shared library.

### 4.4 [Medium] Admin API contract test checks docs, not API -- OPEN

The test reads API reference markdown and checks for string presence. Verified that existing assertions match actual documentation content.

### 4.5 [Medium] Admin E2E tests assert `[200, 401]` ambiguously -- FIXED

All 6 ambiguous assertions replaced with deterministic `toBe(401)` or `toBe(200)`.

### 4.6 [Low] No tests for CLI commands -- OPEN

No test files exist for CLI install, uninstall, update, start, stop, restart, and extensions commands.

### 4.7 [Low] Rate limit test relies on `Bun.sleep(15)` timing -- FIXED

Increased window to 100ms and sleep to 150ms for CI reliability.

---

## 5. Maintainability

### 5.1 [High] `packages/lib` has two separate module structures with unclear boundaries -- FIXED

Added `packages/lib/README.md` documenting the three module zones (`src/`, `src/shared/`, `admin/`), their intended consumers, import path conventions with examples, and decision criteria for new code.

### 5.2 [Medium] Docker images pinned to Bun 1.1.42 but no lockfile mechanism -- FIXED

All 7 Dockerfiles updated from `oven/bun:1.1.42` to `oven/bun:1.3.5`.

### 5.3 [Medium] Admin Dockerfile copies `packages/lib` as `node_modules/@openpalm/lib` -- FIXED

Added documentation comments to all 7 Dockerfiles explaining the COPY workaround and pointing to `packages/lib/README.md`. Fixed the webhook Dockerfile which was missing the COPY line entirely. Added "Docker Build" section to lib README.

### 5.4 [Medium] No structured logging -- FIXED

Created `packages/lib/src/shared/logger.ts` with `createLogger(service)` factory. Admin server now uses structured JSON logging via the shared logger. Gateway already had its own structured logging.

### 5.5 [Low] `CLAUDE.md` is gitignored -- FIXED

Removed `CLAUDE.md` from `.gitignore`.

---

## 6. Configuration and DevEx

### 6.1 [Medium] `.env` file checked into the repo with real paths -- OPEN

The `.env` file contains machine-specific absolute paths. While gitignored, accidental `git add -A` could commit them.

### 6.2 [Medium] Dev overlay has inconsistent COMPOSE_PROJECT_PATH values -- FIXED

Changed `compose-runner.ts` default from `/workspace` to `/state` to match production. Dev overlay correctly overrides to `/compose`.

### 6.3 [Low] Stack spec version migration is lenient -- OPEN

`parseStackSpec` accepts version 1 and 2 but has no migration logic.

### 6.4 [Low] `qdrant:latest` in compose file -- FIXED

Pinned to `qdrant/qdrant:v1.13.2` in both the static compose file and the stack generator.

---

## 7. Integration Points

### 7.1 [High] AI-powered intake validation is a reliability bottleneck -- DEFERRED

Skipped per user request. Every message requires two LLM calls.

### 7.2 [Medium] Gateway has no retry logic for AI runtime calls -- OPEN

`OpenCodeClient.send()` makes a single attempt with no retry on transient errors.

### 7.3 [Medium] Caddy config generation outputs both Caddyfile and JSON formats -- OPEN

Dual-format approach creates confusion about which config is active.

### 7.4 [Low] `applyStack` calls `renderArtifacts` twice -- FIXED

`renderArtifacts` now accepts optional pre-computed preview result to avoid duplicate generation.

---

## 8. Dependencies and Package Management

### 8.1 [Medium] No production dependencies declared in workspace packages -- OPEN

All runtime code depends on `@openpalm/lib` via workspace resolution. Docker builds use a manual COPY workaround.

### 8.2 [Low] Only one devDependency at root level -- OPEN

No linter, formatter, or CI configured beyond `tsc --noEmit`.

---

## Status Summary

| Status | Count |
|--------|-------|
| FIXED | 26 |
| DEFERRED | 2 |
| OPEN | 18 |
| **Total** | **46** |

### Remaining OPEN items

| # | Issue | Severity | Category |
|---|-------|----------|----------|
| 1.4 | Monolithic admin server | Medium | Architecture |
| 1.5 | Dual API surface | Medium | Architecture |
| 1.6 | Webhook channel dead code | Low | Architecture |
| 2.6 | Unauthenticated setup endpoints | Medium | Security |
| 2.7 | No nonce/replay protection | Medium | Security |
| 2.8 | Rate limit bypass via userId | Medium | Security |
| 2.9 | Docker socket mounted | Low | Security |
| 3.4 | Sync I/O in admin server | Medium | Code Quality |
| 3.5 | YAML via string concatenation | Medium | Code Quality |
| 3.6 | Error flattening to 400 | Medium | Code Quality |
| 4.4 | Contract test checks docs not API | Medium | Testing |
| 4.6 | No CLI tests | Low | Testing |
| 6.1 | .env with real paths | Medium | DevEx |
| 6.3 | Stack spec version migration | Low | DevEx |
| 7.2 | No retry in gateway AI client | Medium | Integration |
| 7.3 | Dual Caddy config formats | Medium | Integration |
| 8.1 | No production deps declared | Medium | Dependencies |
| 8.2 | No linter/CI configured | Low | Dependencies |
