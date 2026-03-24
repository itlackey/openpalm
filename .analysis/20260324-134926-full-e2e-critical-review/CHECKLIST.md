# OpenPalm Full E2E Critical Review -- Remediation Checklist

**Generated from:** `FINAL-REPORT.md` + 7 agent reviews (2026-03-24)
**Branch:** release/0.10.0
**Total findings:** 85 | **Strategic items:** 10

---

## Phase 1: Emergency Fixes (This Week)

These are actively broken or security-vulnerable. Each is a quick fix.

### Critical Severity

- [x] **C1. Fix release workflow tar paths** `[CRITICAL]` `[devops]`
  `.github/workflows/release.yml` lines 283-289: deploy bundle `tar` references removed `assets/` and `registry/` directories. Replace `assets` with `.openpalm` and remove `registry`. Release pipeline is broken until fixed.

- [x] **C2. Fix CLAUDE.md broken doc paths (44 files total)** `[CRITICAL]` `[docs]`
  `CLAUDE.md` references `docs/technical/core-principles.md` (4 occurrences) and `docs/technical/docker-dependency-resolution.md` (3 occurrences) -- neither exists at those paths. Actual location is `docs/technical/authoritative/`. 25 files fixed; remaining files addressed by flattening `authoritative/` in Phase 3.

- [x] **C3. Add missing tokens to varlock redaction schema** `[CRITICAL]` `[security]`
  `.openpalm/vault/redact.env.schema` missing: `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `STT_API_KEY`, `TTS_API_KEY`, `VLM_API_KEY`, and others. These credentials appear in plaintext in container logs if logged. 16 entries added.

- [x] **C4. Rewrite stale root AGENTS.md** `[CRITICAL]` `[docs]`
  `AGENTS.md` references Caddy (retired), `channels/` directory (removed), `assets/` directory (removed), `control-plane.ts` (removed), claims "no test files exist yet" (hundreds exist). Actively misleads any AI agent or contributor.

### High Severity

- [x] **H1. Fix guardian /stats timing-safe token comparison** `[HIGH]` `[security]`
  `core/guardian/src/server.ts:84`: `/stats` endpoint uses plain `===` for token comparison instead of constant-time `timingSafeEqual`. Also open if `ADMIN_TOKEN` is unset.

- [x] **H2. Fix scheduler auth timing-safe token comparison** `[HIGH]` `[security]`
  `packages/scheduler/src/server.ts:47`: `requireAuth()` uses plain `===` for token comparison. Import or reimplement `safeTokenCompare()` with SHA-256 + `timingSafeEqual`.

- [x] **H3. Add timingSafeEqual to memory service auth** `[HIGH]` `[security]`
  `core/memory/src/server.ts`: Verify memory service validates `MEMORY_AUTH_TOKEN` on every request using constant-time comparison. Memory is exposed on host port.

- [x] **H5. Delete dead before-navigate.png** `[HIGH]` `[cleanup]`
  `before-navigate.png` at repo root: git-tracked screenshot with zero references anywhere in the codebase. `git rm before-navigate.png`.

- [x] **H7. Fix root README broken links** `[HIGH]` `[docs]`
  `README.md` has 4 broken links: `docs/technical/core-principles.md` (should be `authoritative/`), `docs/manual-setup.md` (should be `docs/technical/manual-setup.md`), `docs/community-channels.md` (should be `docs/channels/community-channels.md`), `registry/README.md` (directory removed entirely).

---

## Phase 2: Security Hardening (This Month)

### High Severity

- [x] **H2. Restrict scheduler volume mounts** `[HIGH]` `[security]` `[BY DESIGN]`
  Documented as intentional in core-principles.md security invariant #5. Scheduler needs broad access for automation execution.

- [x] **H3. Remove OP_ADMIN_TOKEN from guardian environment** `[HIGH]` `[security]`
  Removed from compose env and guardian code. Stats endpoint now unauthenticated (internal networks only, no secrets). Found existing auth was broken (admin-tools sent wrong token).

- [x] **H4. Fix assistant Dockerfile security issues** `[HIGH]` `[security]` `[devops]`
  Switched to node:lts-trixie-slim (~500-700MB savings), chmod 777→755, documented why root is intentional (gosu pattern).

- [x] **H5. Add varlock to scheduler Dockerfile** `[HIGH]` `[security]`
  Added varlock-fetch stage, COPY, and CMD wrapper matching guardian pattern.

- [x] **H8. Add admin unit tests to CI** `[HIGH]` `[devops]`
  Added 2 new parallel CI jobs: admin-unit-tests (592 Vitest) and admin-e2e-mocked (69 Playwright).

- [x] **H9. Remove dead Caddy env vars** `[HIGH]` `[cleanup]`
  5 Caddy-related env vars removed from 10 files.

- [x] **H10. Eliminate channel-chat duplication** `[HIGH]` `[code-quality]`
  `channel-chat` merged into `channel-api` via `CHANNEL_ID` env var.

- [x] **H11. Consolidate 3 secret-reading functions into readStackEnv()** `[HIGH]` `[code-quality]`
  `packages/lib/src/control-plane/secrets.ts`: `readSecretsEnvFile`, `readSystemSecretsEnvFile`, and `loadSecretsEnvFile` all read `vault/stack/stack.env` with confusing naming. Consolidated into single function.

- [x] **H12. Document scheduler/admin/token security design decisions** `[HIGH]` `[docs]` `[security]`
  Documented in core-principles, foundations, and design-intent.

### Medium Severity -- Security

- [x] **M2. Fix assistant Dockerfile `pip --break-system-packages`** `[MEDIUM]` `[security]` `[devops]`
  Replaced pip with uv venv at /opt/assistant-tools/. Python CLI tools now isolated.

---

## Phase 2: Documentation Repair (This Month)

### High Severity

- [x] **H-DOC1. Update environment-and-mounts.md for OP_CAP_* capability vars** `[HIGH]` `[docs]`
  `docs/technical/environment-and-mounts.md` lines 80-88: lists `OPENAI_API_KEY` and `OPENAI_BASE_URL` as memory env vars, but compose now uses `OP_CAP_*` capability variables (`OP_CAP_LLM_PROVIDER`, `OP_CAP_LLM_MODEL`, etc.) as the primary configuration mechanism.

- [X] **H-DOC2. Regenerate architecture SVG to remove Caddy** `[HIGH]` `[docs]`
  `docs/technical/architecture.svg`: still shows Caddy as reverse proxy with container boxes and routing arrows. Caddy was retired. Regenerate reflecting current guardian-based architecture.

- [x] **H-DOC3. Fix vault/README.md assistant mount claim** `[HIGH]` `[docs]`
  `.openpalm/vault/README.md` line 37: states "Assistant mounts only `vault/user/user.env` (read-only)." Wrong on two counts: compose mounts entire `vault/user/` directory (not just user.env), and no `:ro` flag (rw, not read-only). Contradicts core-principles.md.

- [x] **H-DOC4. Fix CLAUDE.md Docker Compose dev command** `[HIGH]` `[docs]`
  `CLAUDE.md` lines 61-68: manual compose command missing admin overlay (`-f .openpalm/stack/addons/admin/compose.yml`) and memory managed env file (`--env-file .dev/vault/stack/services/memory/managed.env`). Running the CLAUDE.md version produces stack without admin.

- [x] **H-DOC5. Add package.json descriptions to 8 packages** `[HIGH]` `[docs]`
  Added descriptions to 8 packages (channel-chat was already deleted). All descriptions derived from actual source code.

- [x] **H-DOC6. Update scheduler mount documentation** `[HIGH]` `[docs]`
  `docs/technical/directory-structure.md` and `docs/technical/authoritative/foundations.md`: both claim scheduler mounts only `config:ro`. Actual compose shows scheduler also mounts `logs/` and `data/` rw. Significant underdocumentation of scheduler filesystem access.

### Medium Severity -- Documentation

- [x] **M-DOC1. Remove stale CLAUDE.md architecture claims** `[MEDIUM]` `[docs]`
  Removed references to `CoreAssetProvider`, `ViteAssetProvider`, `getSetupManager()`, `getStackManager()`, `$stack` alias. Replaced with accurate descriptions.

- [x] **M-DOC2. Clean MEMORY.md stale entries** `[MEDIUM]` `[docs]`
  Fixed 7 stale entries plus 8 additional (Caddy refs, old paths, wrong ports, removed env vars).

- [x] **M-DOC3. Document the OP_CAP_* capability injection system** `[MEDIUM]` `[docs]`
  Created `docs/technical/capability-injection.md` covering all 6 capability slots, resolution pipeline, and service consumption matrix.

- [x] **M-DOC4. Document the registry system** `[MEDIUM]` `[docs]`
  Created `docs/technical/registry.md` covering all 6 API endpoints, addon structure, sync flow, and configuration.

- [x] **M-DOC5. Fix wizard:dev command description** `[LOW]` `[docs]`
  Fixed to reflect actual behavior: OP_HOME=/tmp/openpalm/.dev, no --force, cleans directory first.

- [x] **M-DOC6. Fix CLAUDE.md duplicate Key Files tables** `[LOW]` `[docs]`
  Merged two Key Files sections into one comprehensive table.

- [x] **M-DOC7. Fix assistant-tools AGENTS.md broken doc path** `[LOW]` `[docs]`
  Already correct — no change needed.

- [x] **M-DOC8. Document undocumented memory tools in core/assistant AGENTS.md** `[LOW]` `[docs]`
  Added descriptions for memory-feedback, memory-exports_*, and memory-events_get based on actual tool implementations.

- [x] **M-DOC9. Update docs for services/ subdirectory** `[MEDIUM]` `[docs]`
  Added clarifying note in core-principles.md that `vault/stack/services/` is runtime-created, not shipped.

- [x] **M-DOC10. Note guardian.env creation in manual setup docs** `[MEDIUM]` `[docs]`
  Clarified across 4 files that guardian.env is runtime-created by CLI installer, not shipped. Compose marks it `required: false`.

---

## Phase 2: Code Quality (This Month)

### Medium Severity

- [x] **M-CQ1. Fix guardian rate limiter memory leak** `[HIGH]` `[code-quality]`
  Added `setInterval` pruning every 60s matching nonce cache pattern. Extracted `pruneRateLimitBuckets()` and `MAX_BUCKETS` constant.

- [x] **M-CQ2. Remove pure passthrough re-exports in admin** `[MEDIUM]` `[code-quality]`
  Deleted 5 wrapper files, updated 9 importers to use `@openpalm/lib` directly.

- [x] **M-CQ3. Remove dead `_state` parameter from resolveCompose** `[MEDIUM]` `[code-quality]`
  Removed `resolveCompose` wrapper entirely; `resolveRuntimeFiles()` now calls `readCoreCompose()` directly. Updated 6 callers.

- [x] **M-CQ4. Remove redundant readStackSpec call in writeRuntimeFiles** `[MEDIUM]` `[code-quality]`
  Replaced dead `spec ?? readStackSpec()` fallback with direct `if (spec)` check.

- [x] **M-CQ5. Extract capability-clearing boilerplate in spec-to-env.ts** `[MEDIUM]` `[code-quality]`
  Added `clearCapVars` helper; 21 repetitive lines reduced to 4 one-liner calls.

- [x] **M-CQ6. Deduplicate sha256 function** `[LOW]` `[code-quality]`
  Extracted shared `sha256` and `randomHex` to `crypto.ts`; both files import from there (avoids circular dep).

- [x] **M-CQ7. Make parseJsonBody return discriminated error types** `[MEDIUM]` `[code-quality]`
  Returns `ParseJsonBodyResult` discriminated union; added `jsonBodyError()` helper. Updated all 16 callers.

- [x] **M-CQ8. Add debug logging for silent error catches in CLI install** `[MEDIUM]` `[code-quality]`
  Added structured debug-level logging to all 4 silent catch blocks using `createLogger('cli:install')`.

- [x] **M-CQ9. Fix admin route double-calls** `[MEDIUM]` `[code-quality]`
  Removed redundant `ensureMemoryDir()` and `ensureSecrets()` calls from update route (already called by `reconcileCore`/`createState`).

- [x] **M-CQ10. Fix scheduler route parsing fragility** `[MEDIUM]` `[code-quality]`
  Replaced brittle `path.endsWith`/`slice` with segment-based routing. Correctly handles names containing "log" or "run".

- [x] **M-CQ11. Add proper TypeScript types for Web Speech API** `[MEDIUM]` `[code-quality]`
  Created local `speech-recognition.d.ts` type declarations. Eliminated all 4 `any` usages.

- [x] **M-CQ12. Type YAML parsing in CLI install** `[MEDIUM]` `[code-quality]`
  Replaced `any` with `Record<string, unknown>` and proper type guards for YAML parsing.

### Low Severity

- [x] **L-CQ1. Use structured logger in selfRecreateAdmin** `[LOW]` `[code-quality]`
  Replaced `console.error` with `createLogger("lib:docker")`.

- [x] **L-CQ2. Use structured logger in guardian audit module** `[LOW]` `[code-quality]`
  Replaced `console.error` with `createLogger("guardian:audit")`.

- [x] **L-CQ3. Consolidate dual imports in scheduler** `[LOW]` `[code-quality]`
  Consolidated two `@openpalm/lib` imports into one.

- [x] **L-CQ4. Fix validatePayload double assertion in SDK** `[LOW]` `[code-quality]`
  Replaced double assertion with explicit object construction from validated fields.

- [x] **L-CQ5. Remove needless `async` from ensureValidState** `[LOW]` `[code-quality]`
  Removed async; function performs no async work.

- [x] **L-CQ6. Rename NONCE_CLOCK_SKEW to NONCE_WINDOW_MS** `[LOW]` `[code-quality]`
  Renamed constant and updated import in server.ts.

- [x] **L-CQ7. Extract forwardToGuardian into BaseChannel/SDK** `[LOW]` `[code-quality]`
  Added `forwardToGuardian` to BaseChannel; removed duplicate methods from discord and slack adapters.

- [x] **L-CQ9. Move MAX_AUDIT_MEMORY to audit.ts** `[LOW]` `[code-quality]`
  Moved from types.ts to audit.ts as non-exported const.

- [x] **L-CQ10. Move resetState test helper out of production code** `[LOW]` `[code-quality]`
  Created test-helpers.ts; updated 12 test files.

---

## Phase 2: DevOps & Build (This Month)

### Medium Severity

- [x] **M-DO1. Extract varlock-fetch to shared Docker base or build arg** `[MEDIUM]` `[devops]`
  Created `.docker/varlock.Dockerfile`; removed duplicated stages from 6 Dockerfiles; uses compose `additional_contexts`.

- [x] **M-DO2. Fix inconsistent Bun version pinning** `[MEDIUM]` `[devops]`
  Pinned memory from `oven/bun:1-debian` to `oven/bun:1.3-debian`. All Bun services now on 1.3.

- [x] **M-DO3. Add mocked Playwright tests to CI** `[MEDIUM]` `[devops]`
  Added as parallel CI job alongside admin-unit-tests (see H8).

- [x] **M-DO4. Clean dead env vars from spec-to-env and stack.env.schema** `[MEDIUM]` `[devops]`
  Already completed in quick win #7. `OP_INGRESS_PORT`, `OP_INGRESS_BIND_ADDRESS`, `OP_SCHEDULER_PORT` removed. `OP_GUARDIAN_PORT` kept (still consumed by compose.dev.yaml).

- [x] **M-DO5. Fix user.env and stack.env key overlap** `[MEDIUM]` `[devops]`
  Removed OWNER_NAME/OWNER_EMAIL from stack.env.schema (already in user.env.schema).

- [x] **M-DO6. Extract token-loading logic from inline package.json scripts** `[MEDIUM]` `[devops]`
  Created `scripts/load-test-env.sh`; 3 package.json scripts now source it.

- [x] **M-DO7. Fix release.sh direct push to main** `[MEDIUM]` `[devops]`
  Added interactive safety check with branch protection warnings before push.

- [x] **M-DO8. Fix GPG socket bind mount creating host directory** `[MEDIUM]` `[devops]`
  Changed `create_host_path` to false.

- [x] **M-DO9. Remove OP_OLLAMA_ENABLED and OP_ADMIN_ENABLED dead feature flags** `[MEDIUM]` `[devops]`
  Already completed in quick win #7.

- [x] **M-DO10. Add Ollama prerequisite check to dev-setup.sh** `[MEDIUM]` `[devops]`
  Added non-blocking warnings for: ollama command, server running, required models pulled.

### Low Severity

- [x] **L-DO2. Add CLI binary checksum verification to setup script** `[LOW]` `[devops]`
  Downloads checksums-sha256.txt and verifies binary hash after download.

- [x] **L-DO3. Fix admin Dockerfile BUN_INSTALL path** `[LOW]` `[devops]`
  Changed from /tmp/.bun to /home/node/.bun.

- [x] **L-DO4. Remove channel-voice .env from git tracking** `[LOW]` `[devops]`
  Already not tracked (root .gitignore covers it). Added local .gitignore for clarity.

- [x] **L-DO6. Pin Node.js base image version** `[LOW]` `[devops]`
  Pinned admin Dockerfile to node:22-trixie-slim.

- [x] **L-DO7. Remove OP_SCHEDULER_PORT dead env var** `[LOW]` `[devops]`
  Already completed in quick win #7.

- [x] **L-DO8. Fix compose.dev.yaml voice channel binding** `[LOW]` `[devops]`
  Changed to `${OP_VOICE_BIND_ADDRESS:-127.0.0.1}:${OP_VOICE_PORT:-8186}:8186`.

- [x] **L-DO9. Clean stale dev directories from disk** `[LOW]` `[devops]`
  Already gitignored. Disk-only artifacts for user to clean.

---

## Phase 2: File Organization (This Month)

### Medium Severity

- [x] **M-FO1. Remove assistant-tools/dist/ from git tracking** `[MEDIUM]` `[files]`
  Added to .gitignore, `git rm -r --cached`.

- [x] **M-FO2. Move or remove orphaned channel-discord/docs/plan.md** `[LOW]` `[files]`
  Deleted — features already implemented.

---

## Phase 3: Strategic Simplification (This Quarter)

These require design discussion and potentially significant refactoring.

### Documentation Consolidation

- [ ] **S-DOC1. Flatten `docs/technical/authoritative/` to `docs/technical/`** `[MEDIUM]` `[docs]`
  Move 4 files (`core-principles.md`, `docker-dependency-resolution.md`, `design-intent.md`, `foundations.md`) up one level. Eliminates the class of 44 broken references permanently. The "authoritative" header note in each file is sufficient designation.

- [ ] **S-DOC2. Consolidate directory-structure.md into foundations.md** `[MEDIUM]` `[docs]`
  `docs/technical/directory-structure.md` is almost entirely a subset of `foundations.md` and `environment-and-mounts.md`. Delete or reduce to a cross-reference. Reduces maintenance burden and prevents divergence (e.g., scheduler mount discrepancy).

- [ ] **S-DOC3. Consolidate two manual setup docs** `[LOW]` `[docs]`
  `docs/technical/manual-setup.md` (174 lines) and `docs/operations/manual-compose-runbook.md` (410 lines) overlap significantly. Consider merging.

### Architecture & Code Structure

- [ ] **S-ARCH2. Add subpath exports to @openpalm/lib** `[MEDIUM]` `[architecture]`
  `packages/lib/src/index.ts`: 327-line barrel with 100+ exports from 21 modules. Consumers import everything even if they only need a fraction. Add subpath exports (`@openpalm/lib/docker`, `@openpalm/lib/config`) so consumers can tree-shake and admin Vite build does not need Bun shims for unused modules. Remove exports that is not currently used.

- [ ] **S-ARCH3. Standardize YAML extensions** `[LOW]` `[architecture]`
  Config files use `.yaml` (stack.yaml, host.yaml), compose/automations use `.yml`, dev compose uses `.yaml`. Pick one convention (recommend `.yml` for Docker Compose convention) and enforce it.

- [ ] **S-ARCH4. Standardize test placement convention** `[MEDIUM]` `[architecture]`
  5 different patterns across packages: colocated `src/*.test.ts`, `tests/`, `__tests__/` (Jest convention), `e2e/`, specialized dirs. Memory alone has 3 test directories. Adopt colocated `*.test.ts` for unit tests, `e2e/` for integration tests.

- [ ] **S-ARCH5. Standardize tsconfig.json presence** `[LOW]` `[architecture]`
  Present in 6 of 13 packages, absent in 7, with no clear rationale. Either all Bun-based packages need one or none do. tsconfig should only be present if it is truly needed.

- [ ] **S-ARCH6. Standardize package structure (dist tracking)** `[LOW]` `[architecture]`
  Some packages track `dist/` in git, most do not. Build artifacts should never be committed.

---


## Miscellaneous Low-Priority Items

- [ ] **LOW-1. Fix `docs/technical/api-spec.md` missing scheduler in allowed services** `[LOW]` `[docs]`
  Lists allowed core services as: assistant, guardian, memory, admin. Does not list scheduler. Omission may be intentional but is not explained.

- [ ] **LOW-2. Fix openviking listed in directory-structure.md** `[LOW]` `[docs]`
  `docs/technical/directory-structure.md` line 57: shows `openviking` in tree. Recent commit removed OpenViking config but addon directory still exists. May become stale.

- [ ] **LOW-3. Remove fta.json from root** `[LOW]` `[files]`
  FTA file complexity analysis config at repo root. Niche tool, adds clutter. Move to `.config/` or remove.

- [ ] **LOW-4. Remove root devDependency `@vitest/coverage-v8`** `[LOW]` `[devops]`
  Root `package.json` has single `devDependency`. Should be in admin package, not root.

- [ ] **LOW-5. Fix dev-admin-token hardcoded warning** `[LOW]` `[devops]`
  `dev-setup.sh`: string "dev-admin-token" appears in multiple test scripts. Add a print warning when seeding this value in case a developer accidentally uses it in production.

- [ ] **LOW-6. Add OpenCode auth route unit tests** `[MEDIUM]` `[testing]`
  `packages/admin/src/routes/admin/opencode/providers/[id]/auth/+server.ts:26`: explicit TODO for missing unit tests on API key and OAuth POST modes, and GET poll session logic. Security-sensitive endpoint.

- [ ] **LOW-7. Fix voice channel dev compose env_files** `[LOW]` `[devops]`
  `compose.dev.yaml` voice channel service mounts all three env files (stack.env, user.env, guardian.env). Voice channels should only receive their own HMAC secret, not the full stack env.

---

## Summary

| Status | Count |
|--------|-------|
| Completed [x] | 68 |
| Pending [ ] | 17 |
| **Total** | **85** |

| Phase | Completed | Remaining |
|-------|-----------|-----------|
| Phase 1: Emergency Fixes | 9/9 | 0 |
| Phase 2: Security Hardening | 10/10 | 0 |
| Phase 2: Documentation Repair | 16/16 | 0 |
| Phase 2: Code Quality | 22/22 | 0 |
| Phase 2: DevOps & Build | 17/19 | 2 (M-FO3 skipped) |
| Phase 2: File Organization | 2/2 | 0 |
| Phase 3: Strategic Simplification | 0/8 | 8 |
| Miscellaneous | 0/7 | 7 |
