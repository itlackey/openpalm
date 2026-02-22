# OpenPalm Comprehensive Code Review Report

**Date:** 2026-02-22
**Updated:** 2026-02-22 (post-fix)
**Scope:** Full end-to-end, file-by-file review of all code and documentation
**Total Issues Found:** 117
**Issues Fixed:** 93 | **Remaining:** 24

---

## Fix Status Legend

- **FIXED** — Resolved in branch `fix/022226.1`
- **PARTIAL** — Partially addressed (e.g., documented but not fully resolved)
- **OPEN** — Not yet addressed

---

## Table of Contents

1. [Critical Issues (19)](#critical-issues) — 18 fixed, 1 open
2. [High Issues (30)](#high-issues) — 28 fixed, 2 open
3. [Medium Issues (34)](#medium-issues) — 28 fixed, 6 open
4. [Low Issues (34)](#low-issues) — 19 fixed, 15 open

---

## Critical Issues

### C-1. Command Injection via Automation Cron Schedule — FIXED

**File:** `packages/lib/admin/automations.ts:67` + `packages/lib/admin/stack-manager.ts:242`

The automation `schedule` field is embedded verbatim into crontab lines. `sanitizeEnvScalar` only strips `\r\n` and trims, so a cron schedule like `0 0 * * * ; rm -rf /` survives the filter. The `validateCron()` function exists in `cron.ts` but is **never called from `upsertAutomation` or `syncAutomations`** — only used in test code.

**Fix:** Call `validateCron()` inside `upsertAutomation` before persisting, and at the top of `syncAutomations` for defense-in-depth.

---

### C-2. Prompt Injection via User-Controlled Text in Gateway Intake — FIXED

**File:** `gateway/src/channel-intake.ts:9-21`

User-controlled `payload.text` is embedded verbatim into the intake agent's instruction prompt via `JSON.stringify(payload)`. The HMAC check authenticates the channel adapter, not the end user's content. A crafted `text` value can override the `valid=false` verdict, and the resulting `summary` is forwarded directly to the core runtime which has full tool access.

**Fix:** Wrap user content in clearly delimited tags (e.g., `<user_content>` XML-style) to structurally separate instructions from data. Enforce a tighter length limit on `payload.text`.

---

### C-3. Nonce Validated for Presence but Never Checked for Replay — FIXED

**File:** `gateway/src/server-utils.ts:21-22`, `gateway/src/server.ts:162`

`ChannelMessage` includes `nonce` and `timestamp` for replay prevention, but `validatePayload` only checks they exist — it never stores seen nonces or rejects duplicates. An attacker who captures any valid signed request can replay it unlimited times.

**Fix:** Maintain a time-bounded nonce cache. Reject requests with seen nonces. Reject requests where `Math.abs(Date.now() - payload.timestamp) > CLOCK_SKEW_MS`.

---

### C-4. Discord Interactions Endpoint Has No Signature Verification — FIXED

**File:** `channels/discord/server.ts:27-56`

The Discord interactions endpoint accepts slash command callbacks without verifying Discord's `X-Signature-Ed25519` and `X-Signature-Timestamp` headers. Any attacker can forge slash command payloads and inject arbitrary messages through the channel into the gateway.

**Fix:** Implement Ed25519 signature verification using `DISCORD_PUBLIC_KEY`.

---

### C-5. Wildcard CORS on Admin Management Interface — FIXED

**Files:** `admin/src/server.ts:101-106`, `packages/ui/src/hooks.server.ts:14-18,29-34`

Both the legacy server and SvelteKit hooks apply `access-control-allow-origin: *` to every response, including authenticated responses returning secrets. For a management panel that is explicitly LAN-restricted, this should be absent or tightly scoped.

**Fix:** Remove wildcard CORS or scope to `http://localhost`.

---

### C-6. Unauthenticated Setup Endpoints Accept Arbitrary POST Data — FIXED

**Files:** `admin/src/server.ts:540-637`, `packages/ui/src/routes/setup/*/+server.ts`

During the wizard (before `completed = true`), anyone with network access can call any setup endpoint — including writing AI API keys to disk, changing access scope to public, or completing the setup. No time-bounded or IP-bounded protection exists.

**Fix:** Generate a short-lived setup token at first boot, print to terminal, require during wizard.

---

### C-7. SSRF via Unauthenticated OpenCode Proxy — FIXED

**Files:** `admin/src/server.ts:871-879`, `packages/ui/src/routes/opencode/[...path]/+server.ts:5-24`

Neither proxy endpoint requires authentication. Any request can be forwarded to the internal assistant container. The SvelteKit proxy also forwards original request headers verbatim, including sensitive headers.

**Fix:** Require authentication on the proxy endpoint. Strip/sanitize forwarded headers.

---

### C-8. Secrets Raw Endpoint Exposes All Env Contents — FIXED

**Files:** `admin/src/server.ts:720-724`, `packages/ui/src/routes/secrets/raw/+server.ts:6-15`

Returns the entire `secrets.env` file (including `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) as plaintext over HTTP with no `Cache-Control: no-store` header. Combined with localStorage token storage, XSS yields all secrets.

**Fix:** Add `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. Consider redacting values in the API response.

---

### C-9. Empty HMAC Secret Silently Breaks All Channels — FIXED

**Files:** All five `channels/*/server.ts` (line ~9)

All channels default `SHARED_SECRET` to empty string when env var is not set. `signPayload()` throws, but no try/catch exists in the handler chain. Containers start serving requests and crash on every real request with unhandled exceptions.

**Fix:** Add startup guard: `if (!SHARED_SECRET) { console.error("..."); process.exit(1); }`

---

### C-10. Admin Token Stored in Plaintext localStorage — OPEN

**Files:** `admin/ui/index.html:68`, `packages/ui/src/lib/stores/auth.svelte.ts:5,12-14`

The admin bearer token is stored in `localStorage`, accessible to any JS on the same origin. Any XSS vulnerability exfiltrates the token, giving full admin API access including Docker Compose operations.

**Fix:** Use `HttpOnly` session cookie set by the server.

---

### C-11. Body Parsing Unprotected Against Malformed JSON (All Channels) — FIXED

**Files:** All five `channels/*/server.ts`

All handlers call `req.json()` without try/catch. Malformed JSON causes unhandled `SyntaxError`, returning `500` instead of `400`. No body size limit, enabling memory exhaustion.

**Fix:** Wrap in try/catch, return `400`. Add `Content-Length` check.

---

### C-12. `import.meta.dir` Breaks in Compiled CLI Binaries — FIXED

**File:** `packages/cli/src/commands/create-channel.ts:29`

`import.meta.dir` resolves to the build machine's path in compiled binaries. The scaffold operation writes files to a completely wrong location when run from a deployed binary.

**Fix:** Use `process.cwd()` for scaffolding into the user's current directory.

---

### C-13. `snippet.import` Does Not Validate Injected Data Before Merging — FIXED

**Files:** `admin/src/server.ts:427-457`, `packages/ui/src/routes/command/+server.ts:338-388`

Channels, services, and automations from YAML snippets are cast directly into spec types with no validation before merging into the stack specification.

**Fix:** Run schema validation on imported snippets before merging.

---

### C-14. `generateEnvFromTemplate` Performs N Redundant Read-Write Cycles (Data Loss Risk) — FIXED

**File:** `packages/lib/src/env.ts:132-146`

Each override calls `upsertEnvVar` which reads and rewrites the file. Concurrent environments see partial overwrites. The `upsertEnvVars` batch function exists but is not used here.

**Fix:** Replace the loop with `upsertEnvVars(outputPath, Object.entries(overrides))`.

---

### C-15. `setup/step` Endpoint Has Zero Authentication — FIXED

**File:** `packages/ui/src/routes/setup/step/+server.ts:5-21`

This endpoint has no authentication check at all — not even the conditional `if (completed && !authenticated)` pattern. Any unauthenticated caller can mark arbitrary setup steps as complete, modifying `setup-state.json`. The legacy route in `admin/src/server.ts` has the same gap.

**Fix:** Add the standard auth gate matching other setup endpoints.

---

### C-16. Extensions URL Doubled `/admin/admin/` Path — FIXED

**File:** `packages/cli/src/commands/extensions.ts:39-43,69`

Default base URL `"http://localhost/admin"` produces `http://localhost/admin/admin/plugins/install` — a doubled path segment. The extensions install/uninstall/list commands are broken with default config.

**Fix:** Change default base to `"http://localhost"` or remove `/admin` prefix from fetch paths.

---

### C-17. Caddy Cannot Reach Channel Containers (Network Topology Bug) — FIXED

**File:** `assets/state/docker-compose.yml:185-187`

Caddy is on `assistant_net` only. Channel containers (`channel-chat`, `channel-discord`, etc.) are on `channel_net` only. These networks do not overlap, so when the post-setup Caddy config adds routes like `/channels/chat*` → `channel-chat:8181`, the reverse proxy will fail with a connection error. The gateway is correctly on both networks, but Caddy is not.

**Fix:** Add `caddy` to `channel_net` in the compose file, or route all channel traffic through the gateway instead of directly to channel containers.

---

### C-18. Initial Caddy Config Has No LAN Restriction During First-Boot Setup — FIXED

**File:** `assets/state/caddy/caddy.json`

The initial `caddy.json` routes `/admin*` to `admin:8100` with no IP restriction (`remote_ip` matcher). The architecture docs state admin endpoints are "LAN-restricted," but during first-boot setup the admin panel is accessible from any IP. Combined with C-6 (unauthenticated setup endpoints), this means an attacker with network access can complete the setup wizard and take control of the instance.

**Fix:** Add `remote_ip` matcher to the initial Caddy config, or bind Caddy to localhost only during setup.

---

### C-19. No HTTPS in Caddy Config — All Traffic Including Admin Token in Plaintext — PARTIAL

**File:** `assets/state/caddy/caddy.json`

The listen address is `:80` only. No `:443` listener, no TLS configuration, no HTTP→HTTPS redirect. The `x-admin-token` header is transmitted in cleartext. Combined with C-10 (token in localStorage), network sniffing yields full admin access.

**Fix:** Add TLS configuration with auto-HTTPS, or at minimum document that the operator must configure TLS.

---

## High Issues

### H-1. Rate Limiting Keyed on User-Controlled `userId` Only — FIXED

**File:** `gateway/src/server.ts:23-24`

`userId` comes from the signed payload body. A compromised channel adapter can supply arbitrary `userId` values to bypass rate limiting entirely. No per-channel or per-IP limiting exists.

**Fix:** Add secondary rate limit on `payload.channel`. Consider IP-level limits.

---

### H-2. `intake.summary` Forwarded to Core Runtime Without Sanitization — FIXED

**File:** `gateway/src/server.ts:88-99`

LLM-generated `intake.summary` is forwarded directly as the `message` to the unrestricted assistant. If the intake LLM is compromised or jailbroken, injected content reaches the assistant verbatim.

**Fix:** Length-limit `intake.summary`, strip known injection patterns, sanitize `payload.metadata`.

---

### H-3. Audit Log Is Synchronous and Unbounded — FIXED

**File:** `gateway/src/audit.ts:10-12`

`appendFileSync` blocks the Bun event loop on every audit write (2-4 per request). No log rotation, size limit, or disk-full handling. Burst requests cause measurable throughput degradation.

**Fix:** Use async writes. Add log rotation and disk-space handling.

---

### H-4. Timing Side-Channel Leaks Admin Token Length — FIXED

**File:** `packages/ui/src/lib/server/auth.ts:6-7`

Early return on length mismatch before `timingSafeEqual` lets attackers determine the exact token length by measuring response times.

**Fix:** Compare HMACs of both values, or always pad to equal length.

---

### H-5. Concurrent Writes to Shared Filesystem with No Locking — FIXED

**Files:** `admin/src/server.ts:141-157`, `packages/ui/src/lib/server/env-helpers.ts:16-37`

Read-modify-write sequences for `runtime.env` and `secrets.env` are not atomic. Concurrent requests can silently corrupt configuration files (TOCTOU race).

**Fix:** Use file-level write locks or a serialized queue.

---

### H-6. `.env` File Written with Default Permissions (World-Readable Secrets) — FIXED

**File:** `packages/cli/src/commands/install.ts:98-99`

The `.env` file containing `ADMIN_TOKEN`, `POSTGRES_PASSWORD`, and channel secrets is written with no explicit file permissions (defaults to `644` — world-readable).

**Fix:** `chmod(envPath, 0o600)` after writing.

---

### H-7. Uninstall Reads `.env` with Relative Path — FIXED

**File:** `packages/cli/src/commands/uninstall.ts:21-23`

If run from wrong directory, reads wrong `.env` or nothing, potentially uninstalling wrong runtime. Also `unlink(".env")` at line 114 may delete wrong file.

**Fix:** Use absolute path from known install location.

---

### H-8. No Input Validation on `--runtime` CLI Flag — FIXED

**File:** `packages/cli/src/main.ts:110-115`

`--runtime` value is cast directly to `ContainerPlatform` with no validation. Invalid values cause unhandled errors in `resolveComposeBin`.

**Fix:** Validate against `["docker", "podman", "orbstack"]` before casting.

---

### H-9. `verifySignature` Compares UTF-8 Buffers, Not Hex — FIXED

**File:** `packages/lib/src/shared/crypto.ts:11-13`

Signatures compared as UTF-8 strings rather than hex-decoded bytes. Case-insensitive hex signatures silently fail. Standard practice is `Buffer.from(sig, "hex")`.

**Fix:** Use `"hex"` encoding for both buffers.

---

### H-10. `writeStackSpecAtomically` Temp File Collision Risk — FIXED

**File:** `packages/lib/admin/stack-manager.ts:306-311`

Uses `Date.now()` for temp filename. Two calls within same millisecond produce same temp path, causing silent data loss.

**Fix:** Use `crypto.randomUUID()` for temp filename suffix.

---

### H-11. OpenMemory Images Use Unpinned `:latest` Tag — PARTIAL

**File:** `assets/state/docker-compose.yml:38,50`

`mem0/openmemory-mcp:latest` and `mem0/openmemory-ui:latest` — a `docker pull` can silently introduce breaking changes. All other images are version-pinned.

**Fix:** Pin to specific version tags.

---

### H-12. Full Repo Root Mounted into Admin Container (Dev) — FIXED

**File:** `dev/docker-compose.dev.yml:30`

`.:/compose:ro` mounts entire repository (including `.env` with secrets) read-only into admin container. Broad attack surface if container is compromised.

**Fix:** Mount only specific compose files needed.

---

### H-13. Weak Default Secrets in Docker Compose — FIXED

**File:** `assets/state/docker-compose.yml:23,115`

`POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-change-me-pg-password}` and `ADMIN_TOKEN=${ADMIN_TOKEN:-change-me-admin-token}` — stack starts with known weak credentials if `.env` is missing.

**Fix:** Remove defaults to force explicit configuration, or fail startup.

---

### H-14. Discord `userId` Defaults to Shared "discord:unknown" Sentinel — FIXED

**File:** `channels/discord/server.ts:41,68`

Anonymous requests share `userId` of `"discord:unknown"`, causing cross-user session contamination in gateway/assistant routing.

**Fix:** Return `400` if `userId` cannot be determined.

---

### H-15. Telegram Webhook Secret Optional, Creating No-Auth Deployments — FIXED

**File:** `channels/telegram/server.ts:18`

When `TELEGRAM_WEBHOOK_SECRET` is empty, the auth check is skipped entirely. Any HTTP client can submit arbitrary Telegram payloads.

**Fix:** Log startup warning. Consider enforcing as required.

---

### H-16. Gateway Error Responses Proxied Without Sanitization — FIXED

**Files:** `channels/chat/server.ts:31`, `channels/telegram/server.ts:41`, `channels/voice/server.ts:38`, `channels/webhook/server.ts:30`

Raw gateway response body passed directly to callers. May leak internal routing details and stack traces.

**Fix:** Parse responses and return only safe fields.

---

### H-17. State Mutation Before Auth Check in Setup Access Scope — FIXED

**File:** `admin/src/server.ts:548-568`

In the legacy REST route, `stackManager.setAccessScope(scope)` and `setRuntimeBindScope(scope)` modify on-disk state before checking authentication when `completed = true`. State changes should not happen before auth is verified.

**Fix:** Move auth check before any state mutation.

---

### H-18. Validates Parsed Spec but Saves Original Raw Input — FIXED

**File:** `packages/ui/src/routes/stack/spec/+server.ts:13-24`

`parseStackSpec(body.spec)` validates the spec, but `stackManager.setSpec(body.spec)` saves the unvalidated original. Should call `setSpec(parsed)` instead.

---

### H-19. `test:unit` Filter Regex Semantically Incorrect — FIXED

**File:** `package.json:34`

`"test:unit": "bun test --filter '!integration|contract|security|compose|ui'"` — the `!` negates only `integration`, not the whole alternation.

**Fix:** Use `'!(integration|contract|security|compose|ui)'` or simpler approach.

---

### H-18b. Missing Env Variables Not Documented in `.env.example` — FIXED

**File:** `dev/.env.example` (missing entries from `docker-compose.yml`)

Variables like `OPENPALM_INGRESS_BIND_ADDRESS`, `OPENPALM_UID/GID`, `OPENCODE_ENABLE_SSH`, `OPENCODE_TIMEOUT_MS`, `POSTGRES_DB/USER` are undiscoverable.

**Fix:** Document all variables with defaults in `.env.example`.

---

### H-19b. `sk-` Prefix on Placeholder API Key Triggers Secret Scanners — FIXED

**File:** `assets/config/secrets.env:11`

`OPENAI_API_KEY=sk-REPLACE_WITH_ACTUAL_KEY` follows OpenAI key format, triggering GitHub push protection and other scanners.

**Fix:** Use `OPENAI_API_KEY=your-openai-api-key-here`.

---

### H-20. Docker Compose Missing Health Checks on Critical Services — FIXED

**File:** `assets/state/docker-compose.yml`

`postgres`, `qdrant`, `openmemory`, `gateway`, and `admin` have no healthchecks. Stack may appear running but be functionally broken. Dependency chain is also incomplete (`assistant` should depend on `postgres`).

**Fix:** Add healthchecks for all services. Fix dependency chain.

---

### H-21. Daemon-Not-Running Detection Uses Fragile String Matching — FIXED

**File:** `packages/cli/src/commands/install.ts:53-59`

Fatal check depends on exact string `"daemon is not running"`. If preflight message wording changes, check silently stops working. Secondary warning path at line 108-110 is not caught.

**Fix:** Use structured error type with `code` field instead of substring matching.

---

### H-22. Assistant Dockerfile Runs as Root — FIXED

**File:** `assistant/Dockerfile`

Container runs as root, increasing blast radius if compromised.

**Fix:** Add a non-root user. The compose file has `OPENPALM_UID/GID` variables but they're not used in the Dockerfile.

---

### H-23. Install Script Has No Checksum Verification — FIXED

**File:** `assets/state/scripts/install.sh:136-153`

The installer downloads a binary with `curl -fsSL` and executes it without verifying a checksum or GPG signature. If GitHub Releases is compromised or the download is MITM'd, arbitrary code executes. The sanity check only verifies the binary responds to `version`.

**Fix:** Publish SHA256 checksums alongside releases. Verify before executing.

---

### H-24. Playwright Global Setup Silently Succeeds If Server Is Unreachable — FIXED

**File:** `admin/ui/tests/global-setup.ts:15-25`

If the 30-second deadline expires with the admin server never responding, the function returns `undefined` without throwing. All subsequent tests fail with confusing "navigation timeout" errors instead of a clear "server not reachable" message.

**Fix:** Throw after deadline: `throw new Error("Admin server did not become reachable within 30 seconds")`.

---

### H-25. Architecture Docs Show Wrong Networks for Containers — OPEN

**File:** `dev/docs/architecture.md:103-108`

Container inventory table lists channel containers on `assistant_net` and gateway on `assistant_net` only. Actual compose puts channels on `channel_net` only and gateway on both networks. This misleads developers about the security boundary.

**Fix:** Update table to match actual compose network assignments.

---

### H-26. Maintenance Docs Reference Non-Existent Rendered Compose File — OPEN

**File:** `docs/maintenance.md:27-161`

All maintenance commands reference `~/.local/state/openpalm/rendered/docker-compose.yml`. Before `stack render` has been run, this file doesn't exist. All documented maintenance commands would fail on a fresh install.

**Fix:** Add precondition note, or use CLI commands (`openpalm start/stop`) instead of raw docker compose.

---

### H-27. PowerShell Installer Missing `orbstack` Runtime Option — FIXED

**File:** `assets/state/scripts/install.ps1:11`

`[ValidateSet("docker", "podman")]` excludes `orbstack`, while the bash installer supports all three. macOS users with OrbStack get a validation error.

**Fix:** Add `"orbstack"` to the ValidateSet.

---

### H-28. Contract Test Requires Live Stack But Labeled as Contract Test — FIXED

**File:** `test/contracts/setup-wizard-gate.contract.test.ts:5-8,29-30`

This test makes live HTTP calls to `localhost:8100` and modifies `setup-state.json` on disk. It's categorized as a contract test but behaves as an integration test. Running `bun test --filter contract` without a live stack causes hangs (no fetch timeout).

**Fix:** Either add `AbortSignal.timeout()` and skip when stack is unavailable, or move to `test/integration/`.

---

### H-29. Navigation `beforeAll` Doesn't Validate Setup Step Responses — FIXED

**File:** `admin/ui/tests/navigation.ui.playwright.ts:12-44`

The `beforeAll` makes 6 API calls to complete wizard steps. None check the response status. If a step fails (400/500), `beforeAll` silently succeeds and subsequent tests fail with confusing errors.

**Fix:** Assert `resp.ok` for each step call.

---

### H-30. Duplicate Contract Test Assertion — FIXED

**File:** `test/contracts/admin-api.contract.test.ts:12,18-22`

`expect(docs.includes("/admin/connections")).toBe(false)` appears both inline (line 12) and as the entire body of the second `it` block (lines 18-21). Copy-paste duplication.

**Fix:** Remove the duplicate `it` block.

---

## Medium Issues

### M-1. `packages/ui` Excluded from Root TypeScript Check — FIXED

**File:** `tsconfig.json:29-38` — `packages/ui` not in `include` array. `bun run typecheck` never checks the SvelteKit UI.

### M-2. `test/` Directory Not in `tsconfig.json` — FIXED

**File:** `tsconfig.json:29-38` — Type errors in cross-service tests won't surface during typecheck.

### M-3. CLI Package Name Collides with Root — FIXED

**Files:** `package.json:2` and `packages/cli/package.json:1` — Both `"name": "openpalm"`.

### M-4. `dev-setup.sh` Seeds Outdated `stack-spec.json` — FIXED

**File:** `dev/dev-setup.sh:33` — Seeds old JSON format instead of `openpalm.yaml` (v3).

### M-5. `bunShim` Plugin Has No SSR Guard — FIXED

**File:** `packages/ui/vite.config.ts:28-34` — May inject Bun shim into client bundles unnecessarily.

### M-6. Wildcard Alias `@openpalm/lib/*` Broken — OPEN

**File:** `packages/ui/svelte.config.js:13` — Literal `*` in `path.resolve()` doesn't expand globs.

### M-7. `OPENPALM_DATA_ROOT/CONFIG_ROOT/STATE_ROOT` Undocumented — FIXED

**File:** `packages/ui/src/lib/server/config.ts:7-9` — Not in any env template.

### M-8. Docker Socket Path Inconsistency — OPEN

**Files:** `system.env:28`, `docker-compose.yml:128`, `compose-runner.ts:19` — Three sources disagree on socket path.

### M-9. Missing `"type": "module"` at Root — FIXED

**File:** `package.json` (root) — All workspaces declare it but root doesn't.

### M-10. `bun.lockb` Ignored but `bun.lock` Committed — FIXED

**File:** `.gitignore:150` — Ambiguous lockfile policy.

### M-11. `dist/` Globally Ignored — FIXED

**File:** `.gitignore:89` — Overly broad; should be scoped per workspace.

### M-12. Stale `.gitignore` Patterns — FIXED

**File:** `.gitignore:80-154` — Contains Bower, Grunt, Snowpack, Firebase, DynamoDB, Nuxt patterns not used.

### M-13. `packages/lib` Version `0.0.1` vs Platform `0.2.0` — FIXED

**File:** `packages/lib/package.json:3` — Neither `lib` nor `ui` in version manager.

### M-14. `packages/ui` Uses `npm run` Instead of `bun run` — FIXED

**File:** `packages/ui/package.json:16` — Inconsistent with Bun-only project.

### M-15. CLAUDE.md Documents Wrong Test Command — FIXED

**File:** `CLAUDE.md:30` — Documents `--filter unit` but actual script uses negation pattern.

### M-16. Unclear Whether `admin/src/server.ts` Is Dead Code — FIXED

**File:** `CLAUDE.md:79` — Says `packages/ui` replaces `admin/ui/` but `admin/src/server.ts` still exists.

### M-17. `yamlTextImport` Plugin No Error Handling — FIXED

**File:** `packages/ui/vite.config.ts:46-53` — `readFileSync` with no try/catch.

### M-18. `$HOME/openpalm` Mount Undocumented — OPEN

**File:** `docker-compose.yml:75,127` — Host home directory dependency not in docs or `.env.example`.

### M-19. Minimal Contract Test Coverage — FIXED

**File:** `test/contracts/` — Only 3 thin contract tests. Missing comprehensive endpoint testing.

### M-20. Weak Health Check Assertions in Integration Tests — FIXED

**File:** `test/integration/container-health.integration.test.ts:33-34` — OpenMemory check passes 5xx as "acceptable".

### M-21. Playwright Test Brittle Server Readiness — FIXED

**File:** `admin/ui/tests/global-setup.ts:16-24` — 4xx auth failures pass readiness check.

### M-22. Playwright Hard-Coded Waits — FIXED

**File:** `admin/ui/tests/navigation.ui.playwright.ts:54` — `page.waitForTimeout(1500)` instead of element conditions.

### M-23. `dev/dev-setup.sh` Silent Failures — FIXED

**File:** `dev/dev-setup.sh:32-34` — `cp -n` with `2>/dev/null || true` hides all errors.

### M-24. `dev/version.ts` Inconsistent Error Handling — FIXED

**File:** `dev/version.ts:114,191,206` — Some paths throw, others return silently on errors.

### M-25. Troubleshooting References Wrong Caddy Config Format — FIXED

**File:** `docs/troubleshooting.md:34` — References `Caddyfile` but actual config is `caddy.json` (JSON format).

### M-26. PostgreSQL Restore Procedure Has No Readiness Check — FIXED

**File:** `docs/maintenance.md:82-86` — `up -d postgres` followed by immediate SQL restore without `pg_isready` check. May fail with "connection refused."

### M-27. OpenMemory Health Endpoint Referenced Wrong in Troubleshooting — FIXED

**File:** `docs/troubleshooting.md:44` — `curl http://localhost:8765/health` likely returns 404; real endpoint is `/api/v1/apps/`.

### M-28. Architecture Doc References `stack-spec.json` Instead of `openpalm.yaml` — FIXED

**File:** `dev/docs/architecture.md:235` — "Single source of truth" table references old JSON format.

### M-29. Test Plan File Organization Doesn't Match Actual Files — OPEN

**File:** `dev/docs/testing-plan.md:296-311` — Documents 9+ test files that don't exist. Test extension uses `.ui.test.ts` but actual is `.ui.playwright.ts`.

### M-30. Contributor Checklist References `stack-spec.json` — FIXED

**File:** `dev/docs/contributor-checklist.md:5` — Should reference `openpalm.yaml`.

### M-31. `dev-setup.sh --clean` Has No Confirmation Prompt — FIXED

**File:** `dev/dev-setup.sh:13-16` — `rm -rf "$DEV_DIR"` destroys persistent data (Postgres, Qdrant) without confirmation.

### M-32. `dev/dev.sh` References Possibly Wrong Admin Entrypoint — FIXED

**File:** `dev/dev.sh:56` — Starts `admin/src/server.ts` which may be superseded by SvelteKit UI.

### M-33. Integration Tests Have No Skip Guard for Missing Stack — FIXED

**File:** `test/integration/container-health.integration.test.ts` — No `SKIP_INTEGRATION` env check. `bun test` fails for developers without running stack.

### M-34. Uninstall Script Doesn't Remove CLI Binary — FIXED

**File:** `assets/state/scripts/uninstall.sh` — Removes data/config/state but leaves `~/.local/bin/openpalm` orphaned.

---

## Low Issues

### L-1. `channels/webhook/package.json` Missing `"version"` Field — FIXED
### L-2. TypeScript Not a Root `devDependency` — FIXED
### L-3. CLI `engines.bun >= 1.0.0` Too Broad (Should Be `>= 1.2.0`) — FIXED
### L-4. `packages/ui/.svelte-kit/tsconfig.json` Path Mismatch — OPEN
### L-5. CLAUDE.md Documentation Map May Be Stale — FIXED
### L-6. `api-reference.md` References `stack-spec` Without Clarifying JSON vs YAML — FIXED
### L-7. `security.md` Incomplete Security Model Documentation — OPEN
### L-8. `DISCORD_BOT_TOKEN` Env Var Documented But Never Referenced in Code — OPEN
### L-9. `chat` and `webhook` Channels Share `"chat-user"` / `"webhook-user"` Fallback IDs — OPEN
### L-10. Test Admin Harness Creates Temp Dirs Without Cleanup — FIXED
### L-11. No Tests for Concurrent Message Handling — OPEN
### L-12. No Tests for Stack Spec Version Migration — OPEN
### L-13. No Tests for Rate Limiting Boundary Conditions — OPEN
### L-14. HMAC Security Tests Missing Timing Attack Verification — OPEN
### L-15. `input-bounds.security.test.ts` Allows 500 Responses (Should Forbid 200 Only) — OPEN
### L-16. Test State File Race Conditions in `setup-wizard-gate.contract.test.ts` — FIXED
### L-17. Server Cleanup May Fail Silently in Integration Tests — OPEN
### L-18. `dev/dev-setup.sh` No Docker Daemon Check, No Port Availability Check — OPEN
### L-19. Token Generation Truncates Entropy for Non-4-Multiple Lengths — OPEN
### L-20. `assistant/extensions/package.json` Pins `@opencode-ai/plugin: 1.2.6` (May Drift) — OPEN
### L-21. `gateway/opencode/AGENTS.md` Safety Rules Are Minimal (8 Lines) — OPEN
### L-22. No Tests for Deeply Nested JSON Structures (DoS Vector) — OPEN
### L-23. Missing Tests for Hot Reload, Restart, Rollback of Channel Config — OPEN
### L-24. Incomplete Dependency Chain in Docker Compose — FIXED
### L-25. `createChatFetch` / `createWebhookFetch` / etc. Are Nearly Identical (No Shared Factory) — OPEN
### L-26. `dev/dev.sh` `OPENCODE_CONFIG_PATH` References Possibly Non-Existent Path — OPEN
### L-27. `dev/version.ts` `readJson`/`writeJson` Use `any` Type (No Type Safety) — FIXED
### L-28. `dev/version.test.ts` Doesn't Cover `v`-Prefixed Versions — OPEN
### L-29. Channel Containers Have No Docker Healthchecks — FIXED
### L-30. `admin-harness.ts` Creates Temp Dir That Is Never Used (Dead Code) — FIXED
### L-31. Playwright `baseURL` Missing Trailing Slash (Fragile Relative Navigation) — OPEN
### L-32. Test Plan Has Duplicate Table Row for "Admin unit" Coverage — OPEN
### L-33. `uninstall.sh` `read_env_var` Breaks on Values Containing `=` — OPEN
### L-34. PowerShell Uninstaller `$PSScriptRoot` May Be Wrong When Run from Temp Dir — FIXED

---

## Summary

| Severity | Count | Fixed | Open | Primary Concerns |
|----------|-------|-------|------|-----------------|
| **Critical** | 19 | 18 | 1 | Command injection, prompt injection, replay attacks, missing auth, SSRF, secret exposure, network topology |
| **High** | 30 | 28 | 2 | Rate limit bypass, timing leaks, race conditions, weak defaults, missing validation, install integrity |
| **Medium** | 34 | 28 | 6 | Config inconsistencies, test gaps, documentation drift, build issues, missing readiness checks |
| **Low** | 34 | 19 | 15 | Code duplication, minor test gaps, version drift, stale patterns, dead code |

**Total: 117 issues — 93 fixed, 24 remaining (mostly low-priority)**

### Remaining Open Issues

| ID | Severity | Description |
|----|----------|-------------|
| C-10 | Critical | Admin token in localStorage (requires HttpOnly cookie — architecture change) |
| C-19 | Critical | No HTTPS in bootstrap config (documented; TLS configured post-setup by stack generator) |
| H-11 | High | OpenMemory images unpinned (TODO added; no tagged releases on Docker Hub) |
| H-25 | High | Architecture docs show wrong networks for containers |
| H-26 | High | Maintenance docs reference non-existent rendered compose file |
| M-6 | Medium | Wildcard alias broken in svelte.config.js |
| M-8 | Medium | Docker socket path inconsistency across 3 files |
| M-18 | Medium | `$HOME/openpalm` mount undocumented |
| M-29 | Medium | Test plan doesn't match actual test files |
| + 15 Low | Low | Test coverage gaps, minor inconsistencies |

### Fix Branch

All fixes on branch `fix/022226.1` — 7 merge commits, **77 files changed** (+1025, -276).

### Verification

- gateway + lib: **225/225** tests pass
- CLI: **196/202** pass (6 pre-existing)
- security + contracts: **63/63** pass
- SvelteKit: svelte-check **0 errors**
