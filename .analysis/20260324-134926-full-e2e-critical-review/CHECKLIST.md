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

- [ ] **H2. Restrict scheduler volume mounts** `[HIGH]` `[security]`
  `.openpalm/stack/core.compose.yml` lines 164-167: scheduler mounts `${OP_HOME}/data:/openpalm/data` (entire data directory including admin, assistant, memory, guardian data). Replace with specific subdirectory mount (`data/scheduler` only). Scheduler also receives `OP_ADMIN_TOKEN` (line 158) -- remove or replace with a scheduler-scoped token.

- [ ] **H3. Remove OP_ADMIN_TOKEN from guardian environment** `[HIGH]` `[security]`
  `.openpalm/stack/core.compose.yml` line 131: guardian's job is HMAC verification and rate limiting -- it does not need admin API access. Receiving the admin token expands blast radius of a guardian compromise.

- [ ] **H4. Fix assistant Dockerfile security issues** `[HIGH]` `[security]` `[devops]`
  `core/assistant/Dockerfile`: (a) Runs as `USER root` with no final `USER` directive (line 85) -- add `USER opencode` or `USER node`; (b) Uses `chmod 777` on home directory (line 75) -- change to `755` or `700`; (c) Uses full `node:lts-trixie` (~1GB) instead of slim variant -- switch to `node:lts-trixie-slim`.

- [ ] **H5. Add varlock to scheduler Dockerfile** `[HIGH]` `[security]`
  `core/scheduler/Dockerfile`: only Dockerfile without varlock. Scheduler has `OP_ADMIN_TOKEN`, `OP_MEMORY_TOKEN`, and `OP_OPENCODE_PASSWORD` in its environment but none are redacted from logs. Add the varlock-fetch stage matching the other 5 Dockerfiles.

- [ ] **H8. Add admin unit tests to CI** `[HIGH]` `[devops]`
  `.github/workflows/ci.yml`: 592 admin unit tests exist but are not verified in CI. CI runs `bun run test` (SDK, guardian, channels, CLI) but does not run `bun run admin:test:unit`. Add it to the CI pipeline.

- [x] **H9. Remove dead Caddy env vars** `[HIGH]` `[cleanup]`
  5 Caddy-related env vars removed from 10 files.

- [x] **H10. Eliminate channel-chat duplication** `[HIGH]` `[code-quality]`
  `channel-chat` merged into `channel-api` via `CHANNEL_ID` env var.

- [x] **H11. Consolidate 3 secret-reading functions into readStackEnv()** `[HIGH]` `[code-quality]`
  `packages/lib/src/control-plane/secrets.ts`: `readSecretsEnvFile`, `readSystemSecretsEnvFile`, and `loadSecretsEnvFile` all read `vault/stack/stack.env` with confusing naming. Consolidated into single function.

- [x] **H12. Document scheduler/admin/token security design decisions** `[HIGH]` `[docs]` `[security]`
  Documented in core-principles, foundations, and design-intent.

### Medium Severity -- Security

- [ ] **M2. Fix assistant Dockerfile `pip --break-system-packages`** `[MEDIUM]` `[security]` `[devops]`
  `core/assistant/Dockerfile` line 67: modifies system-level Python packages with `--break-system-packages`. Use `uv` (already installed in same Dockerfile) or a venv instead.

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

- [ ] **M-DOC5. Fix wizard:dev command description** `[LOW]` `[docs]`
  `CLAUDE.md` line 56: says `wizard:dev` runs "install --no-start --force with OP_HOME=.dev". Actual: OP_HOME is `/tmp/openpalm/.dev`, no `--force` flag, and script cleans the directory first.

- [x] **M-DOC6. Fix CLAUDE.md duplicate Key Files tables** `[LOW]` `[docs]`
  Merged two Key Files sections into one comprehensive table.

- [ ] **M-DOC7. Fix assistant-tools AGENTS.md broken doc path** `[LOW]` `[docs]`
  `packages/assistant-tools/AGENTS.md` line 60: references `docs/technical/docker-dependency-resolution.md` (correct path is `docs/technical/authoritative/docker-dependency-resolution.md`).

- [ ] **M-DOC8. Document undocumented memory tools in core/assistant AGENTS.md** `[LOW]` `[docs]`
  `core/assistant/opencode/AGENTS.md` line 20: references `memory-feedback`, `memory-exports_*`, and `memory-events_get` tools but provides no documentation on what these do or what arguments they take.

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

- [ ] **L-CQ1. Use structured logger in selfRecreateAdmin** `[LOW]` `[code-quality]`
  `packages/lib/src/control-plane/docker.ts:330,334`: uses raw `console.error` instead of structured `createLogger`.

- [ ] **L-CQ2. Use structured logger in guardian audit module** `[LOW]` `[code-quality]`
  `core/guardian/src/audit.ts:16,28`: uses `console.error` instead of `createLogger`. May be intentional (module-init timing) but breaks logging consistency.

- [ ] **L-CQ3. Consolidate dual imports in scheduler** `[LOW]` `[code-quality]`
  `packages/scheduler/src/server.ts:10-11`: two separate `import` statements from `@openpalm/lib`. Consolidate into single import.

- [ ] **L-CQ4. Fix validatePayload double assertion in SDK** `[LOW]` `[code-quality]`
  `packages/channels-sdk/src/channel.ts:92`: `as unknown as ChannelPayload` double assertion bypasses TypeScript checking. Replace with proper type guard function returning `o is ChannelPayload`.

- [ ] **L-CQ5. Remove needless `async` from ensureValidState** `[LOW]` `[code-quality]`
  `packages/cli/src/lib/cli-state.ts:22-26`: declared `async` but performs no async work.

- [ ] **L-CQ6. Rename NONCE_CLOCK_SKEW to NONCE_WINDOW_MS** `[LOW]` `[code-quality]`
  `core/guardian/src/replay.ts:9`: name implies network time drift tolerance but constant is actually the nonce TTL/replay detection window.

- [ ] **L-CQ7. Extract forwardToGuardian into BaseChannel/SDK** `[LOW]` `[code-quality]`
  `packages/channel-discord/src/index.ts:568-585` and `packages/channel-slack/src/index.ts:485-502`: identical `forwardToGuardian` methods. Only difference is userId prefix (`discord:` vs `slack:`). Extract into BaseChannel as `forwardAndExtractAnswer()`.

- [ ] **L-CQ9. Move MAX_AUDIT_MEMORY to audit.ts** `[LOW]` `[code-quality]`
  `packages/lib/src/control-plane/types.ts:73`: exported but only imported by `audit.ts` within same package. Not re-exported from `index.ts`. Make a non-exported constant in `audit.ts`.

- [ ] **L-CQ10. Move resetState test helper out of production code** `[LOW]` `[code-quality]`
  `packages/admin/src/lib/server/state.ts:19-22`: `resetState` is test-only but exported from production code. Move to test-utils module.

---

## Phase 2: DevOps & Build (This Month)

### Medium Severity

- [ ] **M-DO1. Extract varlock-fetch to shared Docker base or build arg** `[MEDIUM]` `[devops]`
  Identical 20-line varlock-fetch stage duplicated in 5 Dockerfiles (`core/admin`, `core/guardian`, `core/assistant`, `core/channel`, `core/memory`). Version bumps require editing 5 files. Extract to shared base image or `COPY --from=` single build stage.

- [ ] **M-DO2. Fix inconsistent Bun version pinning** `[MEDIUM]` `[devops]`
  Memory uses `oven/bun:1-debian` (major float -- could get Bun 2.x), while guardian/channel/scheduler use `oven/bun:1.3-slim` (minor float). Pin memory to `oven/bun:1.3-debian` or equivalent.

- [ ] **M-DO3. Add mocked Playwright tests to CI** `[MEDIUM]` `[devops]`
  69 mocked browser tests exist (`bun run admin:test:e2e:mocked`) and do not need a running stack. Should run in CI alongside unit tests.

- [ ] **M-DO4. Clean dead env vars from spec-to-env and stack.env.schema** `[MEDIUM]` `[devops]`
  Dead Caddy artifacts: `OP_INGRESS_PORT`, `OP_INGRESS_BIND_ADDRESS` generated in `packages/lib/src/control-plane/spec-to-env.ts` and `.openpalm/vault/stack/stack.env.schema` but consumed by nothing. Also dead: `OP_GUARDIAN_PORT` (guardian has no host port binding).

- [ ] **M-DO5. Fix user.env and stack.env key overlap** `[MEDIUM]` `[devops]`
  Both `user.env.schema` and `stack.env.schema` declare the same API key variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.). Docker Compose uses the LAST `--env-file` value. Different scripts use different `--env-file` orderings, causing inconsistent variable resolution.

- [ ] **M-DO6. Extract token-loading logic from inline package.json scripts** `[MEDIUM]` `[devops]`
  `admin:test:e2e`, `admin:test:stack`, `admin:test:llm` in `package.json` all contain complex inline shell with token extraction via grep/cut. Duplicated 3 times. Extract to small shell script or use `test-tier.sh` consistently.

- [ ] **M-DO7. Fix release.sh direct push to main** `[MEDIUM]` `[devops]`
  `scripts/release.sh:55`: pushes directly to `main` without branch protection checks. Create a release branch, push that, then tag from there, or document that branch protection must allow direct pushes.

- [ ] **M-DO8. Fix GPG socket bind mount creating host directory** `[MEDIUM]` `[devops]`
  `.openpalm/stack/addons/admin/compose.yml` lines 68-71: `create_host_path: true` for GPG socket creates `~/.gnupg` on the host (owned by Docker daemon) if it does not exist.

- [ ] **M-DO9. Remove OP_OLLAMA_ENABLED and OP_ADMIN_ENABLED dead feature flags** `[MEDIUM]` `[devops]`
  Generated in `spec-to-env.ts` and written to `stack.env` but not consumed by any compose or runtime logic.

- [ ] **M-DO10. Add Ollama prerequisite check to dev-setup.sh** `[MEDIUM]` `[devops]`
  Dev setup defaults to Ollama for LLM and embeddings, but `dev-setup.sh` has no check that Ollama is running or required models are pulled. Add a warning (not hard failure).

### Low Severity

- [ ] **L-DO2. Add CLI binary checksum verification to setup script** `[LOW]` `[devops]`
  `scripts/setup.sh`: downloads CLI binary but does not verify SHA-256 checksum. Release workflow generates `checksums-sha256.txt` but setup script does not use it.

- [ ] **L-DO3. Fix admin Dockerfile BUN_INSTALL path** `[LOW]` `[devops]`
  `core/admin/Dockerfile` lines 85-87: `BUN_INSTALL=/tmp/.bun` uses world-writable tmp. Use a user-writable directory under `/home/node` instead.

- [ ] **L-DO4. Remove channel-voice .env from git tracking** `[LOW]` `[devops]`
  `packages/channel-voice/.env` tracked in repo. Contains no actual secrets but `.env` files should generally not be tracked. `.env.example` convention already followed.

- [ ] **L-DO6. Pin Node.js base image version** `[LOW]` `[devops]`
  `node:lts-trixie` and `node:lts-trixie-slim` are floating tags. Pin to specific version (e.g., `node:24-trixie`).

- [ ] **L-DO7. Remove OP_SCHEDULER_PORT dead env var** `[LOW]` `[devops]`
  Generated in `spec-to-env.ts` but scheduler is internal-only with no host port. Scheduler reads hardcoded `"8090"` from compose.

- [ ] **L-DO8. Fix compose.dev.yaml voice channel binding** `[LOW]` `[devops]`
  `compose.dev.yaml:80`: voice channel port binds to `0.0.0.0:8186` (all interfaces). Use bind address variable like other services.

- [ ] **L-DO9. Clean stale dev directories from disk** `[LOW]` `[devops]`
  `.dev-0.9.0/` and `.dev-tmp3/` are old dev environment snapshots sitting on disk. Remove them.

---

## Phase 2: File Organization (This Month)

### Medium Severity

- [ ] **M-FO1. Remove assistant-tools/dist/ from git tracking** `[MEDIUM]` `[files]`
  `packages/assistant-tools/dist/`: build artifact tracked in git. Build artifacts should never be committed.

- [ ] **M-FO2. Move or remove orphaned channel-discord/docs/plan.md** `[LOW]` `[files]`
  `packages/channel-discord/docs/plan.md`: only channel with its own docs directory. Orphaned planning material. Move to `.github/roadmap/` or delete.


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

- [ ] **S-ARCH1. Standardize packages/ vs core/ split** `[HIGH]` `[architecture]`
  `core/guardian` and `core/memory` have full TypeScript source as workspace members despite convention that `core/` is for Docker contexts. Three name collisions (admin, memory, scheduler) between directories. Move `core/guardian/src/` to `packages/guardian/src/` and `core/memory/src/` to `packages/memory-server/src/`. Keep `core/` as pure Docker build contexts.

- [ ] **S-ARCH2. Add subpath exports to @openpalm/lib** `[MEDIUM]` `[architecture]`
  `packages/lib/src/index.ts`: 327-line barrel with 100+ exports from 21 modules. Consumers import everything even if they only need a fraction. Add subpath exports (`@openpalm/lib/docker`, `@openpalm/lib/config`) so consumers can tree-shake and admin Vite build does not need Bun shims for unused modules.

- [ ] **S-ARCH3. Standardize YAML extensions** `[LOW]` `[architecture]`
  Config files use `.yaml` (stack.yaml, host.yaml), compose/automations use `.yml`, dev compose uses `.yaml`. Pick one convention (recommend `.yml` for Docker Compose convention) and enforce it.

- [ ] **S-ARCH4. Standardize test placement convention** `[MEDIUM]` `[architecture]`
  5 different patterns across packages: colocated `src/*.test.ts`, `tests/`, `__tests__/` (Jest convention), `e2e/`, specialized dirs. Memory alone has 3 test directories. Adopt colocated `*.test.ts` for unit tests, `e2e/` for integration tests.

- [ ] **S-ARCH5. Standardize tsconfig.json presence** `[LOW]` `[architecture]`
  Present in 6 of 13 packages, absent in 7, with no clear rationale. Either all Bun-based packages need one or none do.

- [ ] **S-ARCH6. Standardize package structure (dist tracking)** `[LOW]` `[architecture]`
  Some packages track `dist/` in git, most do not. Build artifacts should never be committed.

---

## Strategic/Architectural Discussion Items

These are from the contrarian review and architecture review. Not bugs -- they are strategic decisions that warrant deliberate evaluation.

### Complexity Reduction Opportunities

- [ ] **STRAT-1. Evaluate single orchestrator pattern** `[DISCUSSION]` `[architecture]`
  Currently two independent orchestrators (CLI on host, admin inside Docker) manage the same compose stack, requiring file-based lock, docker-socket-proxy, and dual code paths. A single-orchestrator pattern (CLI as host daemon, admin as UI calling CLI REST API) would eliminate: lock system, docker-socket-proxy, dual code paths, preflight duplication. Estimated reduction: ~800 LOC + docker-socket-proxy dependency. **Tradeoff:** Changes deployment model (CLI must be always-running).

- [ ] **STRAT-2. Evaluate single compose file with profiles** `[DISCUSSION]` `[architecture]`
  Replace 9 compose overlay files with 1 compose file using Docker Compose `profiles`. Eliminates: multi-file merge validation, `discoverStackOverlays`, `buildComposeFileList`, compose preflight merge validation step. **Tradeoff:** Loses the "drop a file" addon model, which is a genuine product differentiator for community channels.

- [ ] **STRAT-3. Simplify guardian to stateless forwarding** `[DISCUSSION]` `[architecture]`
  Guardian maintains session cache with TTL, locking, cleanup, and title tracking -- duplicating the assistant's own session management. A stateless guardian (HMAC verify, rate limit, forward with request ID) would eliminate ~200 lines in `forward.ts`. **Assessment:** Session proxy is the weakest part of the guardian. Let the assistant own sessions.

- [ ] **STRAT-4. Scope shared lib reduction** `[DISCUSSION]` `[architecture]`
  `@openpalm/lib` (5,400 LOC, 100+ exports) correctly prevents orchestrator divergence but has grown beyond justified scope. Should be lifecycle + Docker + config. Move scheduling logic, memory config, registry sync, and provider constants to their respective packages. Or add subpath exports to allow tree-shaking.

- [ ] **STRAT-5. Evaluate removing premature operational features** `[DISCUSSION]` `[architecture]`
  Feature-flag or remove: rollback/snapshot system (~200-400 LOC), `pass` secret backend (~200-400 LOC), orchestrator lock (unnecessary with single orchestrator). Re-add when users request them. Each removal reduces maintenance burden and test surface.

- [ ] **STRAT-6. Simplify guardian replay detection** `[DISCUSSION]` `[security]`
  Nonce cache + timestamp checking is over-engineered for the LAN-first threat model. A timestamp-only check (reject messages older than 5 minutes) would provide 95% of the protection at 10% of the complexity. The nonce cache (50K entries, periodic pruning) could be removed.

### Security Model Enhancements

- [ ] **STRAT-7. Evaluate session-based admin auth** `[DISCUSSION]` `[security]`
  Admin token is static with no rotation, stored in `localStorage` (XSS-exfiltrable), transmitted over HTTP (LAN-first = no HTTPS), controls destructive Docker operations. Combination of no rotation + localStorage + HTTP creates capture-and-full-control risk. Consider: session-based auth with expiry, token rotation, httpOnly cookies instead of localStorage, HTTPS-only mode or at least warn when over HTTP.

- [ ] **STRAT-8. Evaluate assistant direct host exposure auth** `[DISCUSSION]` `[security]`
  `.openpalm/stack/core.compose.yml` lines 93-94: assistant (OpenCode web UI) directly reachable on port 3800 from host, bypassing guardian entirely. SSH also exposed. Defaults to `127.0.0.1` but nothing prevents changing to `0.0.0.0` creating unauthenticated entry point. Compose has `OPENCODE_AUTH: "false"`. Consider enabling auth by default.

- [ ] **STRAT-9. Evaluate remote access addon (Tailscale/Cloudflare Tunnel)** `[DISCUSSION]` `[product]`
  LAN-first is correct default, but no supported path from LAN to remote access exists. A Tailscale/WireGuard addon or Cloudflare Tunnel addon would address the most common user request without changing the safe default.

- [ ] **STRAT-10. Document "file assembly, not rendering" scope** `[DISCUSSION]` `[architecture]`
  The rule is stated as absolute but the project already violates it in spirit through: Compose `${VAR}` substitution (50+ variable refs in core.compose.yml), `mergeEnvContent()` key-value patching, `generateFallbackSystemEnv()` string interpolation, `writeCapabilityVars()` config-to-env serialization. Clarify the rule applies to compose files only; env file generation is necessarily dynamic.

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
| Completed [x] | 10 |
| In Progress | 4 |
| Pending [ ] | 71 |
| **Total** | **85** |

| Phase | Items |
|-------|-------|
| Phase 1: Emergency Fixes | 9 (5 done, 1 in progress, 3 pending) |
| Phase 2: Security Hardening | 9 |
| Phase 2: Documentation Repair | 16 |
| Phase 2: Code Quality | 22 |
| Phase 2: DevOps & Build | 19 |
| Phase 2: File Organization | 3 |
| Phase 3: Strategic Simplification | 12 |
| Strategic Discussion | 10 |
| Miscellaneous | 7 |
