# OpenPalm Full E2E Critical Review -- Final Report

## Date: 2026-03-24
## Branch: release/0.10.0

---

## Executive Summary

OpenPalm is a self-hosted AI assistant platform with genuinely thoughtful security architecture -- the assistant isolation model, guardian trust boundary, HMAC signing pipeline, and vault/config/data directory separation demonstrate deep security thinking. The BaseChannel SDK is well-designed, the addon compose overlay pattern is extensible, and the `execFile`-with-argument-arrays discipline for Docker commands is commendable. The codebase has strong type safety (only ~7 `any` instances in production code), remarkably few TODOs (2 in active source), and a comprehensive test suite spanning unit, integration, and E2E tiers.

However, the project has a documentation crisis. The most critical document in the repository (`core-principles.md`) is referenced via a broken path in 44 files including CLAUDE.md and README.md. The root AGENTS.md describes an architecture that no longer exists. The architecture SVG still shows Caddy (retired). Environment variable documentation is stale -- the OP_CAP_* capability injection system that powers the current compose stack is undocumented. Cross-document contradictions exist for vault mounts, scheduler permissions, and memory environment variables. This documentation rot means that every new contributor and AI agent starts with incorrect information.

Security review identified 3 critical and 8 high-severity issues. The release workflow will fail on next execution (references removed `assets/` and `registry/` directories). The varlock redaction schema is missing Discord, Slack, and voice channel tokens -- these credentials will appear in plaintext in container logs. Token comparison in the guardian /stats endpoint and scheduler auth uses plain `===` instead of constant-time comparison, creating timing attack vectors. The scheduler has access to the entire `data/` directory and receives `OP_ADMIN_TOKEN` despite needing neither. The assistant Dockerfile runs as root with `chmod 777` on the home directory.

At an architectural level, the project exhibits a pattern of solving future problems at the expense of present simplicity. The rollback/snapshot system, orchestrator lock, `pass` secret backend, and registry sync are all well-implemented features for a mature product -- but OpenPalm has 19 stars, 0 forks, and effectively one contributor. These features impose a maintenance tax without current users to justify them. The shared library (`packages/lib/`) correctly prevents orchestrator divergence but has grown to 5,400 lines with 100+ exports, creating coupling that requires Vite shims for the admin to consume. The 15-package workspace count inflates structural complexity; a similar product could be built with 5 packages.

The positive news: the security invariants that matter most (assistant isolation, guardian ingress, vault boundaries) are genuine and verified. The core compose overlay pattern works well. The test infrastructure is comprehensive. The codebase is clean and well-typed. These are strong foundations -- the project needs documentation repair, security hardening of peripheral services, and honest complexity pruning more than it needs new features.

---

## Review Methodology

Seven specialist agents conducted independent reviews across the following domains:

| Agent | Domain | Findings |
|-------|--------|----------|
| Documentation & Info Architecture | Docs accuracy, broken links, stale content, cross-doc contradictions | 4 critical, 9 high, 10 medium, 6 low |
| Architecture & Design | Security model, design decisions, over-engineering assessment | 1 critical, 4 high, 7 medium, 5 low |
| Code Quality & Implementation | Code smells, dead code, type safety, patterns, redundancy | 0 critical, 4 high, 12 medium, 9 low |
| File Organization & Conventions | Repo structure, naming, consistency, dead files | 0 critical, 4 high, 5 medium, 3 low |
| Configuration & DevOps | Docker, env handling, CI/CD, scripts, security | 2 critical, 7 high, 11 medium, 9 low |
| Implementation Gaps | Claimed vs implemented, dead config, stale references | 0 critical, 3 high, 7 medium, 3 low |
| Contrarian / Devil's Advocate | Fundamental premise challenges, simplification proposals | N/A (verdicts, not severities) |

Each agent reviewed the codebase independently, then this synthesis agent cross-referenced, deduplicated, and scored all findings.

---

## Critical Issues (Fix Immediately)

### C1. Release Workflow Will Fail on Next Release
**Value: 5 | Effort: 5 | ROI: 5.0**
**Agents:** Config-DevOps
**File:** `.github/workflows/release.yml` lines 283-289

The release workflow's deploy bundle `tar` command references `assets/` and `registry/` directories that were removed during the v0.10.0 restructure. The `tar` command will fail with "No such file or directory", breaking the entire release pipeline. No releases can be cut until this is fixed.

**Fix:** Replace `assets` with `.openpalm` and remove `registry` from the tar command.

---

### C2. CLAUDE.md References Broken Paths to Authoritative Documents
**Value: 5 | Effort: 5 | ROI: 5.0**
**Agents:** Documentation, File-Organization, Implementation-Gaps
**Files:** `CLAUDE.md` (7 occurrences), `README.md` (2 occurrences), 44 files total

The project's primary instruction file references `docs/technical/core-principles.md` and `docs/technical/docker-dependency-resolution.md` -- neither file exists at those paths. The actual locations are under `docs/technical/`. This is the single most important document in the repository, described by CLAUDE.md itself as "the authoritative source of architectural rules." Every AI agent and contributor following CLAUDE.md is directed to nonexistent files.

**Fix:** Update all 44 broken references, or move the 4 files from `docs/technical/` up to `docs/technical/` (eliminating the path confusion entirely).

---

### C3. Varlock Redaction Schema Missing Channel Bot Tokens
**Value: 5 | Effort: 5 | ROI: 5.0**
**Agents:** Config-DevOps
**File:** `.openpalm/vault/redact.env.schema`

The varlock redaction schema covers HMAC secrets and LLM API keys but completely misses: `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `STT_API_KEY`, `TTS_API_KEY`, `VLM_API_KEY`. These credentials will appear in plaintext in container logs if ever logged.

**Fix:** Add all `@sensitive`-annotated variables from addon `.env.schema` files to `redact.env.schema`.

---

### C4. Root AGENTS.md is Severely Outdated and Actively Misleading
**Value: 5 | Effort: 4 | ROI: 4.0**
**Agents:** Documentation, File-Organization
**File:** `AGENTS.md`

References Caddy (retired), `channels/` directory (removed), `assets/` directory (removed), `control-plane.ts` (removed), claims "no test files exist yet" (hundreds exist), references stale Vite aliases, and describes architecture from a prior version. Any AI agent or contributor reading this file will be fundamentally misled.

**Fix:** Delete root AGENTS.md and let CLAUDE.md serve as the authoritative instruction file, or completely rewrite AGENTS.md to match current reality.

---

## High Priority Issues (Fix Soon)

### H1. Guardian /stats and Scheduler Auth Use Non-Constant-Time Token Comparison
**Value: 5 | Effort: 5 | ROI: 5.0**
**Agents:** Architecture
**Files:** `core/guardian/src/server.ts:84`, `packages/scheduler/src/server.ts:47`

Both the guardian's `/stats` endpoint and the scheduler's `requireAuth()` use plain `===` for token comparison. The admin server correctly uses `safeTokenCompare()` with SHA-256 + `timingSafeEqual`. This inconsistency creates timing attack vectors. If `ADMIN_TOKEN` is not set, the guardian stats endpoint is completely open.

**Fix:** Import or reimplement `safeTokenCompare()` in both services. Require `ADMIN_TOKEN` to be set (reject all requests if missing).

---

### H2. Scheduler Has Overly Broad Volume Mount and Unnecessary Admin Token
**Value: 5 | Effort: 5 | ROI: 5.0**
**Agents:** Architecture, Config-DevOps
**File:** `.openpalm/stack/core.compose.yml` lines 158, 164-167

The scheduler mounts `${OP_HOME}/data:/openpalm/data` (the entire data directory including admin, assistant, memory, and guardian data) and receives `OP_ADMIN_TOKEN` in its environment. A compromised scheduler has admin-level API access and read-write access to all service data. The scheduler only needs read access to automations config and write access to its own logs.

**Fix:** Replace `${OP_HOME}/data:/openpalm/data` with specific subdirectory mounts. Remove or replace `OP_ADMIN_TOKEN` with a scheduler-scoped token.

---

### H3. Guardian Receives OP_ADMIN_TOKEN Unnecessarily
**Value: 4 | Effort: 5 | ROI: 4.0**
**Agents:** Config-DevOps
**File:** `.openpalm/stack/core.compose.yml` line 131

The guardian's job is HMAC verification and rate limiting -- it should not need admin API access. Receiving the admin token expands the blast radius of a guardian compromise.

**Fix:** Remove `OP_ADMIN_TOKEN` from guardian environment unless there is a documented requirement.

---

### H4. Assistant Dockerfile Runs as Root with chmod 777
**Value: 4 | Effort: 3 | ROI: 2.4**
**Agents:** Config-DevOps
**File:** `core/assistant/Dockerfile` lines 75, 85

The assistant container runs as root (`USER root` with no final `USER` directive). The entrypoint uses `gosu` to drop privileges, but if gosu fails, the container runs as root. The home directory uses `chmod 777` (world-writable).

**Fix:** Add a final `USER` directive. Change `chmod 777` to `chmod 755` or `700`.

---

### H5. Scheduler Missing Varlock (No Secret Redaction in Logs)
**Value: 4 | Effort: 4 | ROI: 3.2**
**Agents:** Config-DevOps
**File:** `core/scheduler/Dockerfile`

The scheduler is the only Dockerfile without varlock. It has `OP_ADMIN_TOKEN`, `OP_MEMORY_TOKEN`, and `OP_OPENCODE_PASSWORD` in its environment, but none are redacted from logs. All other 5 Dockerfiles include varlock.

**Fix:** Add the varlock-fetch stage to the scheduler Dockerfile.

---

### H6. Admin Mounts Entire OP_HOME Directory
**Value: 4 | Effort: 3 | ROI: 2.4**
**Agents:** Architecture, Config-DevOps
**Files:** `.openpalm/stack/addons/admin/compose.yml` line 62

The admin container has `${OP_HOME}:/openpalm` mounted read-write, giving it access to the entire OpenPalm home including vault, config, data, logs, and stack files. While admin is a trusted service, this violates the stated vault boundary model and makes the filesystem contract meaningless for admin.

**Fix:** Mount only the specific subdirectories admin needs with appropriate read/write modes.

---

### H7. README.md Contains 4 Broken Links
**Value: 4 | Effort: 5 | ROI: 4.0**
**Agents:** Documentation
**File:** `README.md`

| Link | Status | Correct Path |
|------|--------|-------------|
| `docs/technical/core-principles.md` | BROKEN | `docs/technical/core-principles.md` |
| `docs/manual-setup.md` | BROKEN | `docs/technical/manual-setup.md` |
| `docs/community-channels.md` | BROKEN | `docs/channels/community-channels.md` |
| `registry/README.md` | BROKEN | Directory removed entirely |

---

### H8. Admin Unit Tests Not Running in CI
**Value: 4 | Effort: 5 | ROI: 4.0**
**Agents:** Config-DevOps
**File:** `.github/workflows/ci.yml`

592 admin unit tests exist but are not verified in CI. The CI runs `bun run test` (covering SDK, guardian, channels, CLI) but does not run `bun run admin:test:unit`.

**Fix:** Add `bun run admin:test:unit` to the CI pipeline.

---

### H9. Architecture SVG Still Shows Caddy
**Value: 4 | Effort: 4 | ROI: 3.2**
**Agents:** Implementation-Gaps
**File:** `docs/technical/architecture.svg`

The primary architecture diagram shows Caddy as the reverse proxy with container boxes and routing arrows. Caddy was retired and no Caddy references exist in any compose file.

**Fix:** Regenerate the architecture SVG reflecting the current guardian-based architecture.

---

### H10. `before-navigate.png` Tracked in Git at Repo Root
**Value: 3 | Effort: 5 | ROI: 3.0**
**Agents:** File-Organization
**File:** `before-navigate.png`

Git-tracked screenshot at repo root with zero references anywhere in the codebase.

**Fix:** `git rm before-navigate.png`

---

## Architectural Concerns (Strategic Discussion Needed)

The contrarian review and architecture review identified several fundamental questions about the project's approach. These are not bugs -- they are strategic decisions that warrant deliberate evaluation.

### A1. Over-Engineering vs Maturity (Contrarian Verdict: NEEDS RETHINKING)

The project has 15 workspace packages, 6 Docker images, a rollback/snapshot system, an orchestrator lock, a `pass` secret backend, a git-based registry sync, and a multi-file compose overlay architecture -- all for a project with 19 GitHub stars. Each feature is individually well-implemented, but the aggregate complexity imposes a maintenance tax that slows iteration. The contrarian agent's recommendation: explicitly separate "security invariants" (must have now) from "operational niceties" (add when users request them). Consider removing or feature-flagging the rollback system, `pass` backend, and registry sync.

### A2. Admin/CLI Duality (Contrarian Verdict: QUESTIONABLE)

Two independent orchestrators (CLI on host, admin inside Docker) manage the same compose stack, requiring a file-based lock, docker-socket-proxy, and dual code paths for setup/lifecycle operations. A single-orchestrator pattern (CLI as host daemon, admin as UI calling CLI's REST API) would eliminate the lock, the proxy, and the testing matrix explosion. However, the current approach is defensible given the "admin is optional" design goal.

### A3. Shared Library Scope (Architecture + Contrarian: NEEDS RETHINKING)

The shared `@openpalm/lib` (5,400 LOC, 100+ exports) correctly prevents orchestrator divergence but has grown beyond its justified scope. It should be lifecycle + Docker + config. Scheduling logic, memory configuration, registry sync, and provider constants should live in their respective packages, or at minimum, subpath exports (`@openpalm/lib/docker`, `@openpalm/lib/config`) should allow consumers to import only what they need and eliminate the need for Vite shims.

### A4. Guardian Session Management (Contrarian Verdict: SIMPLIFY)

The guardian maintains a session cache with TTL, locking, cleanup, and title tracking -- duplicating the assistant's own session management. A stateless guardian (HMAC verify, rate limit, forward with request ID) would eliminate ~200 lines of session management in `forward.ts` without meaningful capability loss.

### A5. Admin Token Security Model (Architecture: CRITICAL)

The admin token is a static bearer token with no rotation, stored in localStorage (XSS-exfiltrable), transmitted over HTTP (LAN-first means no HTTPS), and controls destructive Docker operations. For a LAN-first self-hosted tool, static token auth is standard practice, but the combination of no rotation, localStorage storage, and HTTP transmission creates a capture-and-full-control risk from any XSS vulnerability or network sniffer.

---

## Theme Analysis

### Theme 1: Documentation Rot

**Found by:** Documentation, File-Organization, Implementation-Gaps, Architecture

The documentation has not kept pace with architectural changes. The most damaging manifestation is the broken path to `core-principles.md` in 44 files. But the rot is systemic:
- `environment-and-mounts.md` describes pre-capability-injection env vars
- `architecture.svg` shows retired Caddy
- `AGENTS.md` describes architecture from a prior version
- Vault README contradicts core-principles on mount semantics
- Scheduler mounts are underdocumented in 2 files
- The OP_CAP_* capability system has no conceptual documentation

The root cause is **documentation duplication**: 5+ files describe the same mounts/env/directory layout. When one gets updated, the others do not. The `authoritative/` subdirectory was meant to solve this by designating canonical documents, but it instead created path confusion.

**Recommendation:** Consolidate `directory-structure.md` into `foundations.md`. Flatten the `authoritative/` subdirectory. Designate `foundations.md` and `core-principles.md` as the two canonical references and make other docs reference them rather than repeating their content.

---

### Theme 2: Security Boundary Leakage

**Found by:** Architecture, Config-DevOps

The security model has strong invariants (assistant isolation, guardian ingress) but weaker enforcement in peripheral areas:
- Guardian and scheduler receive `OP_ADMIN_TOKEN` despite not needing it
- Scheduler mounts all of `data/` read-write
- Admin mounts the entire `OP_HOME`
- Guardian /stats and scheduler auth use non-constant-time comparison
- Redaction schema misses bot tokens from channel addons
- Scheduler lacks varlock for log redaction
- Assistant container runs as root with world-writable home
- All provider API keys are in assistant's Docker inspect output

The pattern: core security was designed carefully, but secondary services received copy-paste env/volume configurations without least-privilege analysis.

---

### Theme 3: Stale Artifacts from Architecture Migrations

**Found by:** Documentation, Implementation-Gaps, Config-DevOps, File-Organization

Multiple artifacts from previous architectures persist:
- Caddy references: `AGENTS.md`, `architecture.svg`, `OP_INGRESS_PORT`/`OP_INGRESS_BIND_ADDRESS` dead env vars
- Pre-restructure references: release workflow `assets/`/`registry/` paths, `AGENTS.md` `channels/` and `assets/` paths
- Removed abstractions referenced in CLAUDE.md: `CoreAssetProvider`, `ViteAssetProvider`, `getSetupManager()`, `getStackManager()`
- MEMORY.md stale entries: Stack Spec v3, `packages/lib/assets/`, `snippet.import`, `writeOpenCodeProviderConfig()`
- Dead env vars: `OP_INGRESS_PORT`, `OP_INGRESS_BIND_ADDRESS`, `OP_GUARDIAN_PORT`, `OP_SCHEDULER_PORT`, `OP_OLLAMA_ENABLED`, `OP_ADMIN_ENABLED`

The project would benefit from a migration cleanup sweep.

---

### Theme 4: Inconsistency and Convention Drift

**Found by:** File-Organization, Code-Quality, Config-DevOps

- **packages/ vs core/ split**: Guardian and memory-server have source code in `core/` despite the convention that `core/` is for Docker contexts. Three name collisions (admin, memory, scheduler).
- **YAML extensions**: Config files use `.yaml`, compose/automations use `.yml`, dev compose uses `.yaml`.
- **Test placement**: 5 different patterns across packages (colocated, `tests/`, `__tests__/`, `e2e/`, specialized dirs).
- **tsconfig.json**: Present in 6 of 13 packages, absent in 7, with no clear rationale.
- **Token comparison**: Admin uses timing-safe comparison; guardian and scheduler use plain `===`.
- **Logging**: Most code uses structured `createLogger`; guardian audit and lib's `selfRecreateAdmin` use raw `console.error`.
- **Secret functions**: Three functions in `secrets.ts` read the same file (`vault/stack/stack.env`) with confusing naming.
- **sha256**: Identical function defined in two files (`config-persistence.ts` and `core-assets.ts`).

---

### Theme 5: Build and Release Pipeline Gaps

**Found by:** Config-DevOps

- Release workflow tar bundle references removed directories (CRITICAL blocker)
- 592 admin unit tests not in CI
- No Playwright tests in CI (69 mocked browser tests could run without stack)
- Varlock-fetch stage duplicated identically in 5 Dockerfiles
- Inconsistent Bun version pinning (memory uses `1-debian`, others `1.3-slim`)
- Base images use floating tags (no digest pinning except docker-socket-proxy)
- Setup script downloads CLI binary without checksum verification

---

## Top 15 Quick Wins (Ranked by ROI)

| # | Fix | Value | Effort | ROI | Files |
|---|-----|-------|--------|-----|-------|
| 1 | Fix release workflow tar paths | 5 | 5 | 5.0 | `.github/workflows/release.yml` |
| 2 | Fix CLAUDE.md broken doc paths (7 occurrences) | 5 | 5 | 5.0 | `CLAUDE.md` |
| 3 | Add missing tokens to redaction schema | 5 | 5 | 5.0 | `.openpalm/vault/redact.env.schema` |
| 4 | Fix guardian /stats timing-safe comparison | 5 | 5 | 5.0 | `core/guardian/src/server.ts` |
| 5 | Fix scheduler auth timing-safe comparison | 5 | 5 | 5.0 | `packages/scheduler/src/server.ts` |
| 6 | Delete root AGENTS.md (or rewrite) | 5 | 4 | 4.0 | `AGENTS.md` |
| 7 | Fix README.md broken links (4 links) | 4 | 5 | 4.0 | `README.md` |
| 8 | Add admin unit tests to CI | 4 | 5 | 4.0 | `.github/workflows/ci.yml` |
| 9 | Remove `OP_ADMIN_TOKEN` from guardian env | 4 | 5 | 4.0 | `.openpalm/stack/core.compose.yml` |
| 10 | `git rm before-navigate.png` | 3 | 5 | 3.0 | `before-navigate.png` |
| 11 | Fix vault/README.md mount claim | 3 | 5 | 3.0 | `.openpalm/vault/README.md` |
| 12 | Consolidate `readSecretsEnvFile` / `readSystemSecretsEnvFile` | 3 | 5 | 3.0 | `packages/lib/src/control-plane/secrets.ts` |
| 13 | Remove dead `OP_INGRESS_*` env vars | 3 | 5 | 3.0 | `packages/lib/src/control-plane/spec-to-env.ts`, `.openpalm/vault/stack/stack.env.schema` |
| 14 | Fix CLAUDE.md dev:build command (missing compose overlays) | 3 | 5 | 3.0 | `CLAUDE.md` |
| 15 | Remove dead `_state` parameter from `resolveCompose` | 2 | 5 | 2.0 | `packages/lib/src/control-plane/config-persistence.ts` |

---

## Long-Term Simplification Opportunities

From the contrarian review, these structural changes would reduce overall complexity. Each requires strategic discussion before action.

### S1. Single Orchestrator Pattern
Make the CLI a host daemon with a REST API. Admin becomes a pure UI calling that API. Eliminates: lock system, docker-socket-proxy, dual code paths, preflight duplication. **Estimated complexity reduction: ~800 LOC and the docker-socket-proxy dependency.**

### S2. Single Compose File with Profiles
Replace 9 compose overlay files with 1 compose file using Docker Compose `profiles`. Eliminates: multi-file merge validation, `discoverStackOverlays`, `buildComposeFileList` overlay logic, the compose preflight merge validation step. **Tradeoff: Loses the "drop a file" addon model, which is a genuine product differentiator for community channels.**

### S3. Stateless Guardian
Remove session management from guardian. Forward messages with request ID; let the assistant manage sessions. Eliminates: session cache, session locks, session TTL, session title cache, ~200 lines in `forward.ts`. **The guardian should only verify, rate-limit, and forward.**

### S4. Shared Lib Scoping
Split `packages/lib/` into focused subpath exports or separate packages. Core lifecycle/config stays shared (~2,000 LOC). Scheduling logic, memory configuration, registry sync, and provider constants move to their respective packages. **Eliminates the need for admin Vite shims for modules it never imports.**

### S5. Remove Premature Operational Features
Feature-flag or remove: rollback/snapshot system, `pass` secret backend, orchestrator lock (unnecessary with single orchestrator). Re-add when users request them. **Each removal is ~200-400 LOC and associated test maintenance.**

---

## What's Working Well

Genuine strengths that should be preserved and built upon:

1. **Guardian HMAC security pipeline** -- Constant-time XOR comparison, timing-safe unknown channel handling with dummy secrets, per-channel CSPRNG secrets, replay protection with nonce + timestamp. This is thoughtful, correct security engineering.

2. **Assistant isolation** -- No Docker socket, no vault/stack access, only memory and admin API through authenticated channels. Verified in compose, Dockerfile, and entrypoint. This is the most important security invariant and it is rock-solid.

3. **LAN-first defaults** -- Every port binding defaults to `127.0.0.1`. No accidental public exposure.

4. **BaseChannel SDK** -- Clean abstract class, `handleRequest()` as the single extension point, proper validation with field length bounds, testable via injectable `fetchFn`. Excellent developer experience for channel adapter authors.

5. **Addon compose overlay pattern** -- Self-contained compose files, automatic discovery, HMAC secret auto-generation. Adding a channel truly is "drop a compose file."

6. **Type safety** -- Only ~7 `any` instances in production code. All Svelte 5 components use runes correctly. Zero legacy Svelte 4 patterns. Guardian and channels-sdk have zero `any` in production code.

7. **Varlock secret redaction** -- Two-layer approach (process stdout and shell tool output) prevents the AI assistant from accidentally leaking API keys. Genuine innovation for AI assistant platforms.

8. **No shell interpolation** -- Docker commands use `execFile` with argument arrays consistently. Real security practice.

9. **SSRF protection** -- `validateExternalUrl()` blocks localhost, link-local IPs, and Docker service names while allowing LAN ranges. Well-calibrated for the threat model.

10. **Cleanup guardrail tests** -- `cleanup-guardrails.test.ts` actively prevents regression of cleaned-up patterns (no deprecated vars, no hardcoded compose names). Smart defensive testing.

11. **Test infrastructure** -- 6 tiers, comprehensive E2E scripts, proper environment gating, `PW_ENFORCE_NO_SKIP=1` for CI enforcement. 2 TODOs in active source is remarkable cleanliness.

12. **Docker socket proxy configuration** -- `EXEC: 0` prevents exec into containers, read-only socket mount, isolated network. Industry-standard pattern correctly applied.

---

## Detailed Findings by Domain

### Documentation & Information Architecture

The documentation has two structural problems: broken references and content duplication.

**Broken references** are the most urgent issue. 44 files reference `docs/technical/core-principles.md` instead of the actual `docs/technical/core-principles.md`. The `authoritative/` subdirectory was created to elevate important docs but instead created path confusion. The simplest fix is to flatten it -- move the 4 files up one level, which eliminates the broken paths without requiring 44 file edits.

**Content duplication** across `directory-structure.md`, `foundations.md`, `environment-and-mounts.md`, `core-principles.md`, and `stack/README.md` means mount/env/directory information diverges. The scheduler mount discrepancy (docs say config-only, compose mounts data + logs too) and vault mount contradiction (README says file read-only, compose mounts directory read-write) are symptoms. `directory-structure.md` should be deleted (it is a strict subset of `foundations.md`).

**Missing documentation**: The OP_CAP_* capability injection system is the primary configuration mechanism but has no conceptual documentation. The registry system has admin API endpoints but no user-facing documentation.

---

### Architecture & Design

The security architecture is genuine and verified:
- Assistant isolation: no Docker socket, no vault/stack -- confirmed in compose, Dockerfile, and entrypoint
- Guardian-only ingress: all channels on `channel_lan`, guardian bridges to `assistant_net` -- confirmed
- LAN-first: all bind addresses default to `127.0.0.1` -- confirmed
- Vault boundary: `0o600`/`0o700` permissions, CSPRNG secret generation -- confirmed

Areas where the architecture is weaker than documented:
- Admin mounts the entire `OP_HOME` (vault boundary is meaningless for admin)
- Scheduler and guardian receive admin tokens they should not need
- Network definitions lack `internal: true` on `assistant_net`
- Admin token is static with no rotation, stored in localStorage, over HTTP
- All provider API keys visible in assistant's Docker inspect before entrypoint runs

Over-engineering assessment (from both architecture and contrarian agents):
- **Justified:** Guardian trust boundary, assistant isolation, varlock, SSRF protection, orchestrator lock, addon overlays
- **Premature:** Rollback/snapshot system, `pass` secret backend, registry sync
- **Questionable:** Multi-file compose overlay complexity, 3-layer env precedence

---

### Code Quality & Implementation

The codebase is well-typed and clean. Key findings:

**Redundancies:**
- `readSecretsEnvFile` and `readSystemSecretsEnvFile` are identical functions reading the same file
- `sha256` defined identically in `config-persistence.ts` and `core-assets.ts`
- `forwardToGuardian` and thread tracking duplicated between Discord and Slack channels
- `channel-chat` appears to be a subset of `channel-api`

**Dead code:**
- `_state` parameter unused in `resolveCompose`
- Redundant `readStackSpec` fallback in `writeRuntimeFiles`
- `MAX_AUDIT_MEMORY` exported from types.ts but only used internally

**Silent error swallowing:** ~12 instances of `catch { }` across the codebase, concentrated in the CLI install flow (4 instances). Most are documented as non-critical, but the cumulative effect makes install failures invisible.

**Rate limiter memory leak:** The guardian rate limiter only prunes entries when the map exceeds 10,000. Under normal load, expired entries for unique keys accumulate indefinitely. The nonce cache has periodic pruning via `setInterval`, but the rate limiter does not.

---

### File Organization & Conventions

**`packages/` vs `core/` split** is the biggest organizational issue. The stated convention ("core/ is for Docker contexts") is violated by `core/guardian` and `core/memory`, which contain full TypeScript source as workspace members. Three name collisions exist (admin, memory, scheduler appear in both directories).

**Test placement** uses 5 different patterns (colocated, `tests/`, `__tests__/`, `e2e/`, specialized dirs). The memory package alone has 3 test directories.

**Dead files:** `before-navigate.png` (git-tracked, zero references), `assistant-tools/dist/` tracked in git, stale `.dev-*` directories on disk.

**YAML extension inconsistency:** `.yaml` for config, `.yml` for compose/automations, `.yaml` for dev compose override.

---

### Configuration & DevOps

**Docker security issues** are the primary DevOps concern: assistant running as root, `chmod 777`, missing varlock in scheduler, overly broad mounts. The varlock-fetch stage is duplicated identically in 5 Dockerfiles -- a version bump requires editing 5 files.

**CI gaps:** Admin unit tests (592) not in CI. Mocked Playwright tests (69, no stack needed) not in CI. Only SDK, guardian, channel, and CLI tests run.

**Dev experience:** 5 steps from clone to running stack, plus an undocumented Ollama prerequisite. Complex inline shell scripts in `package.json` for token extraction are repeated 3 times.

**Base image consistency:** Memory uses `oven/bun:1-debian` (major float), others use `oven/bun:1.3-slim` (minor float). No digest pinning except docker-socket-proxy.

---

### Implementation Gaps

**Documentation vs implementation gaps:**
- `environment-and-mounts.md` memory env section is entirely wrong (pre-capability-injection)
- CLAUDE.md references 3 removed abstractions (`CoreAssetProvider`, `ViteAssetProvider`, `getSetupManager`)
- MEMORY.md has 7 stale entries describing nonexistent directories, functions, and features

**Dead configuration:**
- `OP_INGRESS_PORT`, `OP_INGRESS_BIND_ADDRESS` (Caddy artifacts)
- `OP_GUARDIAN_PORT`, `OP_SCHEDULER_PORT` (generated but no compose consumer)
- `OP_OLLAMA_ENABLED`, `OP_ADMIN_ENABLED` (feature flags consumed by nothing)

**Positive:** All 45 API routes in api-spec.md are verified to exist. All 30+ commands in CLAUDE.md are verified. No half-finished functions found. Only 2 TODOs in active source.

---

### Fundamental Premise Challenges

The contrarian review evaluated 9 fundamental architectural assumptions:

| Decision | Verdict | Summary |
|----------|---------|---------|
| Docker Compose | Questionable | Justified for isolation, but multi-file overlay is premature |
| Guardian pattern | Justified | Centralized trust boundary is correct for plugin ecosystem |
| Shared lib | Justified / Needs rethinking | Right idea, too much scope |
| File assembly rule | Questionable | Good heuristic stated as absolute; already violated in spirit |
| LAN-first | Justified | Correct default; needs supported path to remote access |
| Overall complexity | Needs rethinking | Security is justified; operational features are premature |
| Bun choice | Questionable | Real DX benefits but creates Bun/Node compatibility tax |
| Admin/CLI duality | Questionable | Two orchestrators create lock/proxy/testing complexity |
| Message pipeline | Justified | 3-hop separation of trust domains is correct |

---

## Cross-Cutting Patterns

These issues were independently identified by multiple agents:

### P1. Broken CLAUDE.md doc paths (4 agents)
Documentation, File-Organization, Implementation-Gaps, and Architecture all flagged the `docs/technical/core-principles.md` broken path. This is the single most-identified issue.

### P2. Scheduler over-broad access (3 agents)
Architecture, Config-DevOps, and Documentation all identified the scheduler's excessive volume mounts and/or admin token access.

### P3. Admin OP_HOME mount (2 agents)
Architecture and Config-DevOps both flagged the admin mounting the entire `OP_HOME`.

### P4. Guardian/scheduler non-constant-time auth (2 agents)
Architecture and Code-Quality both identified the timing-unsafe token comparison.

### P5. Documentation duplication causing drift (2 agents)
Documentation and File-Organization both identified the 5+ files describing the same mounts/env/layout with inevitable divergence.

### P6. AGENTS.md staleness (2 agents)
Documentation and File-Organization both flagged root AGENTS.md as severely outdated.

### P7. Shared lib over-coupling (3 agents)
Architecture, Contrarian, and Code-Quality all identified the monolithic barrel export and compatibility friction.

---

## Recommended Action Plan

### Phase 1: Emergency Fixes (This Week)

These are actively broken or security-vulnerable. Each is a quick fix.

| # | Action | Effort | Files |
|---|--------|--------|-------|
| 1 | Fix release workflow tar paths (`assets`->``.openpalm``, remove `registry`) | 5 min | `.github/workflows/release.yml` |
| 2 | Fix CLAUDE.md doc paths (flatten `authoritative/` or update 44 refs) | 30 min | `CLAUDE.md`, `README.md`, 40+ files |
| 3 | Add missing tokens to `redact.env.schema` | 10 min | `.openpalm/vault/redact.env.schema` |
| 4 | Fix guardian /stats to use timing-safe comparison | 15 min | `core/guardian/src/server.ts` |
| 5 | Fix scheduler auth to use timing-safe comparison | 15 min | `packages/scheduler/src/server.ts` |
| 6 | Delete or rewrite root AGENTS.md | 30 min | `AGENTS.md` |
| 7 | Fix README.md broken links | 10 min | `README.md` |
| 8 | `git rm before-navigate.png` | 1 min | `before-navigate.png` |

### Phase 2: Quality Improvements (This Month)

These improve security posture, CI confidence, and developer experience.

| # | Action | Effort | Files |
|---|--------|--------|-------|
| 9 | Restrict scheduler volumes to specific subdirectories | 30 min | `core.compose.yml` |
| 10 | Remove `OP_ADMIN_TOKEN` from guardian env | 15 min | `core.compose.yml` |
| 11 | Add varlock to scheduler Dockerfile | 30 min | `core/scheduler/Dockerfile` |
| 12 | Add admin unit tests to CI | 30 min | `.github/workflows/ci.yml` |
| 13 | Fix assistant Dockerfile (slim base, USER directive, chmod) | 2 hrs | `core/assistant/Dockerfile` |
| 14 | Update `environment-and-mounts.md` for OP_CAP_* | 1 hr | `docs/technical/environment-and-mounts.md` |
| 15 | Regenerate architecture SVG (remove Caddy) | 1 hr | `docs/technical/architecture.svg` |
| 16 | Fix vault/README.md mount claim | 10 min | `.openpalm/vault/README.md` |
| 17 | Consolidate duplicate secrets functions | 30 min | `packages/lib/src/control-plane/secrets.ts` |
| 18 | Clean dead env vars (OP_INGRESS_*, OP_GUARDIAN_PORT) | 30 min | `spec-to-env.ts`, `stack.env.schema` |
| 19 | Fix CLAUDE.md dev:build command | 10 min | `CLAUDE.md` |
| 20 | Remove stale CLAUDE.md claims (CoreAssetProvider, etc.) | 15 min | `CLAUDE.md` |
| 21 | Clean MEMORY.md stale entries | 30 min | MEMORY.md (agent memory) |
| 22 | Set `internal: true` on `assistant_net` | 5 min | `core.compose.yml` |

### Phase 3: Strategic Simplification (This Quarter)

These require design discussion and potentially significant refactoring.

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 23 | Flatten `docs/technical/` to `docs/technical/` | 2 hrs | Eliminates 44 broken ref class permanently |
| 24 | Consolidate `directory-structure.md` into `foundations.md` | 1 hr | Reduces doc duplication |
| 25 | Document OP_CAP_* capability injection system | 2 hrs | Fills largest doc gap |
| 26 | Standardize `packages/` vs `core/` split | 4 hrs | Eliminates naming confusion |
| 27 | Standardize test placement convention | 3 hrs | Reduces cognitive overhead |
| 28 | Add subpath exports to `@openpalm/lib` | 4 hrs | Reduces coupling, eliminates shims |
| 29 | Evaluate single-orchestrator pattern | Design discussion | Largest complexity reduction opportunity |
| 30 | Evaluate removing rollback/pass/registry | Design discussion | Reduces maintenance burden |
| 31 | Extract varlock-fetch to shared Docker base | 2 hrs | 5 Dockerfiles share one stage |
| 32 | Standardize YAML extensions (pick `.yml` or `.yaml`) | 1 hr | Convention consistency |

---

## Appendix: All Findings Summary Table

| # | Finding | Severity | Domain(s) | Value | Effort | ROI |
|---|---------|----------|-----------|-------|--------|-----|
| 1 | Release workflow references removed directories | Critical | DevOps | 5 | 5 | 5.0 |
| 2 | CLAUDE.md broken path to core-principles.md (44 files) | Critical | Docs, Files, Gaps | 5 | 5 | 5.0 |
| 3 | Redaction schema missing Discord/Slack/Voice tokens | Critical | DevOps | 5 | 5 | 5.0 |
| 4 | Root AGENTS.md severely outdated | Critical | Docs, Files | 5 | 4 | 4.0 |
| 5 | Guardian /stats non-constant-time token comparison | High | Arch | 5 | 5 | 5.0 |
| 6 | Scheduler auth non-constant-time token comparison | High | Arch | 5 | 5 | 5.0 |
| 7 | Scheduler mounts all data/ rw + has admin token | High | Arch, DevOps | 5 | 5 | 5.0 |
| 8 | Guardian receives OP_ADMIN_TOKEN unnecessarily | High | DevOps | 4 | 5 | 4.0 |
| 9 | README.md 4 broken links | High | Docs | 4 | 5 | 4.0 |
| 10 | Admin unit tests (592) not in CI | High | DevOps | 4 | 5 | 4.0 |
| 11 | Assistant Dockerfile runs as root, chmod 777, full image | High | DevOps | 4 | 3 | 2.4 |
| 12 | Scheduler missing varlock log redaction | High | DevOps | 4 | 4 | 3.2 |
| 13 | Architecture SVG shows retired Caddy | High | Gaps | 4 | 4 | 3.2 |
| 14 | Admin mounts entire OP_HOME | High | Arch, DevOps | 4 | 3 | 2.4 |
| 15 | before-navigate.png tracked in git at root | High | Files | 3 | 5 | 3.0 |
| 16 | CLAUDE.md broken path to docker-dep-resolution.md | High | Docs | 4 | 5 | 4.0 |
| 17 | Admin token in localStorage, no rotation, over HTTP | Critical | Arch | 5 | 2 | 2.0 |
| 18 | environment-and-mounts.md memory env section stale | High | Gaps, Docs | 4 | 4 | 3.2 |
| 19 | Docker Compose manual command in CLAUDE.md wrong | High | Docs | 3 | 5 | 3.0 |
| 20 | Package descriptions missing (9 of 14) | High | Docs | 3 | 5 | 3.0 |
| 21 | Redundant secrets functions (3 read same file) | High | Code | 3 | 5 | 3.0 |
| 22 | Rate limiter no periodic eviction (memory leak) | High | Code | 4 | 4 | 3.2 |
| 23 | packages/ vs core/ split inconsistent | High | Files | 4 | 2 | 1.6 |
| 24 | Package structure inconsistent (tsconfig, tests, dist) | High | Files | 3 | 2 | 1.2 |
| 25 | Vault README contradicts core-principles on assistant mount | High | Docs | 3 | 5 | 3.0 |
| 26 | Network isolation not enforced (no internal: true) | Medium | DevOps | 4 | 5 | 4.0 |
| 27 | Dead env vars (OP_INGRESS_*, OP_GUARDIAN_PORT) | Medium | Gaps | 3 | 5 | 3.0 |
| 28 | CLAUDE.md stale claims (CoreAssetProvider, etc.) | Medium | Gaps | 3 | 5 | 3.0 |
| 29 | Shared lib barrel 100+ exports (coupling) | Medium | Arch, Code | 4 | 2 | 1.6 |
| 30 | 3-layer env file precedence fragility | Medium | Arch | 3 | 2 | 1.2 |
| 31 | Varlock-fetch stage duplicated in 5 Dockerfiles | Medium | DevOps | 3 | 3 | 1.8 |
| 32 | Inconsistent Bun version pinning (memory vs others) | Medium | DevOps | 3 | 4 | 2.4 |
| 33 | Silent error swallowing (~12 instances) | Medium | Code | 3 | 3 | 1.8 |
| 34 | user.env and stack.env key overlap confusion | Medium | DevOps | 3 | 3 | 1.8 |
| 35 | Repetitive capability-clearing boilerplate (spec-to-env) | Medium | Code | 2 | 4 | 1.6 |
| 36 | Code duplication between channel-chat and channel-api | Medium | Code | 3 | 3 | 1.8 |
| 37 | 5 different test placement patterns | Medium | Files | 3 | 2 | 1.2 |
| 38 | YAML extension inconsistency (.yml vs .yaml) | Medium | Files | 2 | 4 | 1.6 |
| 39 | docs/technical/ creates path confusion | Medium | Docs, Files | 3 | 3 | 1.8 |
| 40 | Scheduler mount docs omit data/ and logs/ | Medium | Docs | 3 | 5 | 3.0 |
| 41 | OP_CAP_* system undocumented | Medium | Docs | 4 | 2 | 1.6 |
| 42 | No documentation for registry system | Medium | Docs | 3 | 2 | 1.2 |
| 43 | Undocumented Ollama dev prerequisite | Medium | DevOps | 3 | 4 | 2.4 |
| 44 | release.sh pushes directly to main | Medium | DevOps | 3 | 3 | 1.8 |
| 45 | pip --break-system-packages in assistant Dockerfile | Medium | DevOps | 2 | 3 | 1.2 |
| 46 | chmod 777 on assistant home directory | Medium | DevOps | 3 | 5 | 3.0 |
| 47 | Docker socket proxy has POST access | Medium | DevOps | 2 | 2 | 0.8 |
| 48 | GPG socket bind mount creates host dir | Medium | DevOps | 2 | 3 | 1.2 |
| 49 | parseJsonBody returns null for both errors and size | Medium | Code | 2 | 3 | 1.2 |
| 50 | Admin route double-calls (ensureMemoryDir, etc.) | Medium | Code | 2 | 3 | 1.2 |
| 51 | any usage in voice-state.svelte.ts (4 instances) | Medium | Code | 2 | 3 | 1.2 |
| 52 | any usage in CLI install.ts (2 instances) | Medium | Code | 2 | 3 | 1.2 |
| 53 | Scheduler route parsing fragile (string slicing) | Medium | Code | 2 | 3 | 1.2 |
| 54 | OpenCode auth route missing unit tests | Medium | Gaps | 3 | 2 | 1.2 |
| 55 | MEMORY.md 7 stale entries | Medium | Gaps | 3 | 4 | 2.4 |
| 56 | .github/roadmap/ has 41 planning files | Medium | Files | 2 | 2 | 0.8 |
| 57 | Complex inline shell in package.json test scripts | Medium | DevOps | 2 | 3 | 1.2 |
| 58 | Overly broad admin re-export wrappers (5 files) | Medium | Code | 2 | 2 | 0.8 |
| 59 | assistant-tools/dist/ tracked in git | Medium | Files | 2 | 5 | 2.0 |
| 60 | sha256 function defined in two files | Low | Code | 2 | 5 | 2.0 |
| 61 | console.error in selfRecreateAdmin and guardian audit | Low | Code | 1 | 5 | 1.0 |
| 62 | Dual import from same package in scheduler | Low | Code | 1 | 5 | 1.0 |
| 63 | validatePayload double assertion in SDK | Low | Code | 1 | 4 | 0.8 |
| 64 | ensureValidState needlessly async | Low | Code | 1 | 5 | 1.0 |
| 65 | NONCE_CLOCK_SKEW naming misleading | Low | Code | 1 | 4 | 0.8 |
| 66 | forwardToGuardian duplicated in Discord/Slack | Low | Code | 2 | 3 | 1.2 |
| 67 | Thread tracking duplicated in Discord/Slack | Low | Code | 2 | 3 | 1.2 |
| 68 | MAX_AUDIT_MEMORY exported but only used internally | Low | Code | 1 | 5 | 1.0 |
| 69 | resetState test helper in production code | Low | Code | 1 | 4 | 0.8 |
| 70 | Ollama addon uses :latest tag | Low | DevOps | 2 | 5 | 2.0 |
| 71 | Setup script no checksum verification for CLI binary | Low | DevOps | 2 | 3 | 1.2 |
| 72 | BUN_INSTALL=/tmp in admin Dockerfile | Low | DevOps | 1 | 3 | 0.6 |
| 73 | channel-voice .env tracked in repo | Low | DevOps | 1 | 5 | 1.0 |
| 74 | No base image digest pinning | Low | DevOps | 2 | 2 | 0.8 |
| 75 | openviking listed in directory-structure docs | Low | Docs | 1 | 5 | 1.0 |
| 76 | Test count mismatch in MEMORY.md | Low | Docs | 1 | 4 | 0.8 |
| 77 | Scheduler not in api-spec allowed core services | Low | Docs | 1 | 5 | 1.0 |
| 78 | assistant-tools AGENTS.md references broken doc path | Low | Docs | 2 | 5 | 2.0 |
| 79 | Memory tools undocumented in core/assistant AGENTS.md | Low | Docs | 1 | 3 | 0.6 |
| 80 | wizard:dev command description inaccurate | Low | Docs | 2 | 5 | 2.0 |
| 81 | compose.dev.yaml voice binds to 0.0.0.0 | Low | Arch | 1 | 5 | 1.0 |
| 82 | Rollback system premature | Info | Arch | 1 | 1 | 0.2 |
| 83 | pass secret backend low user count | Info | Arch | 1 | 1 | 0.2 |
| 84 | channel-discord/docs/plan.md orphaned | Low | Files | 1 | 5 | 1.0 |
| 85 | Key Files table duplicated in CLAUDE.md | Low | Docs | 1 | 5 | 1.0 |

---

*Report generated by synthesis of 7 independent specialist agent reviews. Total unique findings: 85. Cross-cutting patterns identified: 7. Recommended immediate actions: 8. Strategic discussion items: 5.*
