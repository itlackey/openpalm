# Implementation Gaps & Completeness Review

**Date:** 2026-03-24
**Branch:** release/0.10.0
**Reviewer:** Implementation Gap & Completeness Agent

---

## Executive Summary

The OpenPalm codebase is largely well-implemented and internally consistent. The core control-plane library (`packages/lib`), admin API, CLI, guardian, scheduler, channels SDK, and channel adapters are all functional with real tests. However, there are meaningful gaps between documentation claims and actual implementation, dead configuration variables, stale architecture diagrams, and several CLAUDE.md/MEMORY.md claims that are outdated. The most impactful findings are the stale docs/technical/environment-and-mounts.md (which describes a pre-capability-injection architecture), broken file-path references in CLAUDE.md, and dead env vars generated but never consumed.

---

## 1. Docs vs Implementation

### 1.1 CRITICAL: `docs/technical/environment-and-mounts.md` is stale

**Claim:** Memory service uses `OPENAI_API_KEY` and `OPENAI_BASE_URL` as environment variables (lines 85-87).

**Reality:** The compose file (`core.compose.yml`) now uses the `OP_CAP_*` capability injection pattern:
- `SYSTEM_LLM_PROVIDER: ${OP_CAP_LLM_PROVIDER:-}`
- `SYSTEM_LLM_MODEL: ${OP_CAP_LLM_MODEL:-}`
- `SYSTEM_LLM_BASE_URL: ${OP_CAP_LLM_BASE_URL:-}`
- `SYSTEM_LLM_API_KEY: ${OP_CAP_LLM_API_KEY:-}`
- `EMBEDDING_PROVIDER: ${OP_CAP_EMBEDDINGS_PROVIDER:-}`
- `EMBEDDING_MODEL: ${OP_CAP_EMBEDDINGS_MODEL:-}`
- `EMBEDDING_BASE_URL: ${OP_CAP_EMBEDDINGS_BASE_URL:-}`
- `EMBEDDING_API_KEY: ${OP_CAP_EMBEDDINGS_API_KEY:-}`
- `EMBEDDING_DIMS: ${OP_CAP_EMBEDDINGS_DIMS:-}`

The doc's env table for memory is entirely wrong. This is the v0.10.0 capability injection change but the doc was never updated.

**Severity:** HIGH -- Anyone following this doc will wire services incorrectly.

### 1.2 CRITICAL: `docs/technical/architecture.svg` still shows Caddy

**Claim:** Architecture SVG shows Caddy as the reverse proxy (7 references, container box, routing arrows).

**Reality:** Caddy has been retired from the project. No Caddy references exist in any compose file. MEMORY.md explicitly notes "Caddy retirement."

**Severity:** HIGH -- The primary architecture diagram is misleading.

### 1.3 `docs/technical/api-spec.md` is accurate

All 45 routes described in the api-spec.md have corresponding `+server.ts` files:
- All lifecycle routes exist (install, update, uninstall, upgrade)
- All container operations exist (list, pull, up, down, restart, stats, events)
- All connection, addon, registry, automation, memory, opencode, secret, artifact, audit, and log routes exist
- Guardian health and stats endpoints are implemented in `core/guardian/src/server.ts`

The `POST /admin/setup` mentioned in the policy section is not an endpoint -- it's referenced as an "allowed write path" for config changes. This wording is slightly ambiguous but not incorrect.

**Severity:** None -- api-spec is accurate.

### 1.4 `docs/technical/directory-structure.md` is accurate

The directory layout described matches the actual `.openpalm/` structure. All claimed directories exist.

**Severity:** None.

### 1.5 `docs/technical/memory-privacy.md` is accurate

The description of what is stored, where, and how to wipe data is correct.

**Severity:** None.

### 1.6 `docs/technical/testing-workflow.md` is accurate

All 6 test tiers are defined. The `test:t1` through `test:t6` scripts exist in `package.json` and delegate to `scripts/test-tier.sh`.

**Severity:** None.

---

## 2. TODO/FIXME/HACK Audit

### 2.1 Active TODOs in Source Code

| Location | TODO | Severity |
|----------|------|----------|
| `packages/admin/src/routes/admin/opencode/providers/[id]/auth/+server.ts:26` | "Add unit tests for api_key and oauth POST modes, and for GET poll session logic." | MEDIUM -- Missing test coverage for a security-critical route |
| `packages/admin/src/lib/components/opencode/ManageModelsSheet.svelte:63` | "N+1 optimization -- if the providers endpoint does not return inline models, this will require a separate fetch per provider." | LOW -- Performance optimization, not blocking |

### 2.2 Workarounds

| Location | Description | Severity |
|----------|-------------|----------|
| `core/assistant/entrypoint.sh:125` | socat proxy workaround for LMSTUDIO_BASE_URL pointing to remote host | LOW -- Working workaround for lmstudio hardcoded base URL |

**Total TODOs:** 2 in active source code. This is remarkably clean.

---

## 3. Dead Configuration

### 3.1 MEDIUM: `OP_INGRESS_PORT`, `OP_INGRESS_BIND_ADDRESS` -- generated but never consumed

**Generated in:** `packages/lib/src/control-plane/spec-to-env.ts` (lines for `OP_INGRESS_PORT`, `OP_INGRESS_BIND_ADDRESS`)
**Schema:** `.openpalm/vault/stack/stack.env.schema` (OP_INGRESS_PORT=3080, OP_INGRESS_BIND_ADDRESS=127.0.0.1)
**Consumed by compose:** Never. No compose file or addon references `OP_INGRESS_PORT` or `OP_INGRESS_BIND_ADDRESS`.

This is a Caddy retirement artifact. These vars were for the Caddy ingress proxy which has been removed.

**Severity:** MEDIUM -- Dead config polluting stack.env.

### 3.2 MEDIUM: `OP_GUARDIAN_PORT` -- generated but never consumed

**Generated in:** `spec-to-env.ts` and `stack.env.schema` (OP_GUARDIAN_PORT=3899)
**Consumed by compose:** Never. Guardian has no host port binding.

**Severity:** MEDIUM -- Dead config.

### 3.3 LOW: `OP_SCHEDULER_PORT` -- generated but never consumed by compose

**Generated in:** `spec-to-env.ts` (OP_SCHEDULER_PORT=3897)
**Consumed by compose:** Never. Scheduler is internal-only with no host port exposure.

Note: The scheduler itself reads PORT from the compose `environment:` block (hardcoded `"8090"`), not from this var.

**Severity:** LOW -- The scheduler may gain a host port in the future.

### 3.4 MEDIUM: `OP_OLLAMA_ENABLED` and `OP_ADMIN_ENABLED` feature flags

**Generated in:** `spec-to-env.ts` as derived boolean feature flags.
**Consumed by:** Nothing in compose or service code. These are written to stack.env but no compose `${VAR}` references them.

**Severity:** LOW -- May be intended for future conditional compose logic.

---

## 4. Half-Finished Features

### 4.1 MEMORY.md Claims vs Reality (Stale MEMORY.md Entries)

Several MEMORY.md entries describe patterns that no longer exist:

| MEMORY.md Claim | Reality |
|-----------------|---------|
| "Stack Spec v3 (openpalm.yaml)" | Stack spec is `stack.yaml` with `version: 2` |
| "ensureStackSpec() reads YAML only" | No function called `ensureStackSpec` exists; relevant functions are `readStackSpec`/`writeStackSpec` |
| "Built-in channel definitions in packages/lib/assets/channels/*.yaml, loaded via Bun text imports" | `packages/lib/assets/` directory does not exist. Channels are discovered from `.openpalm/stack/addons/` |
| "Templates embedded in packages/lib/assets/templates/" | Directory does not exist |
| "Core automations in packages/lib/assets/automations/core-automations.yaml" | Core automations live in `.openpalm/config/automations/` and are seeded by `ensureCoreAutomations()` from `core-assets.ts` (which downloads them from GitHub) |
| "Admin server supports snippet.import command" | No `snippet` or `snippet.import` references exist in the admin codebase |
| "writeOpenCodeProviderConfig() in connection-mapping.ts is BROKEN" | Both `writeOpenCodeProviderConfig` and `connection-mapping.ts` have been removed entirely |

These are MEMORY.md entries only (agent memory, not code), but they could mislead future agents.

**Severity:** MEDIUM -- Stale agent memory could cause incorrect implementation decisions.

### 4.2 CLAUDE.md Claims vs Reality

| CLAUDE.md Claim | Reality | Severity |
|-----------------|---------|----------|
| `docs/technical/core-principles.md` (referenced 4 times) | File is at `docs/technical/core-principles.md` | HIGH -- Broken reference in the project's primary instruction file |
| `docs/technical/docker-dependency-resolution.md` (referenced 3 times) | File is at `docs/technical/docker-dependency-resolution.md` | HIGH -- Broken reference |
| "Lazy init: `getSetupManager()` / `getStackManager()` are async" | Neither function exists. State management uses `getState()` from `$lib/server/state.ts` | MEDIUM -- Stale claim |
| "Both use the same `CoreAssetProvider` interface from `@openpalm/lib`" | `CoreAssetProvider` has been removed. Test file confirms: "After the CoreAssetProvider removal..." | MEDIUM -- Stale architecture description |
| "Stack files consumed via Vite's `$stack` alias (`ViteAssetProvider`)" | `ViteAssetProvider` does not exist. Stack files are consumed via standard imports. | MEDIUM -- Stale |
| "config format changed from stack-spec.json (v2, JSON) to openpalm.yaml (v3, YAML)" | Config is `stack.yaml` with version 2. No v3 or openpalm.yaml exists. | MEDIUM -- Stale claim |

### 4.3 No Half-Finished Functions Found

A search for `throw "not implemented"` or empty function bodies found no results. All exported functions have real implementations.

---

## 5. Test Coverage Gaps

### 5.1 Packages With Zero Test Files

| Directory | Test Files | Concern |
|-----------|-----------|---------|
| `core/admin/` | 0 | Build context only (Dockerfile, entrypoint); tests are in `packages/admin/` |
| `core/assistant/` | 0 | Build context only (Dockerfile, entrypoint); no unit-testable source |
| `core/channel/` | 0 | Build context only (Dockerfile, start.sh); no unit-testable source |
| `core/scheduler/` | 0 | Build context only (Dockerfile); tests are in `packages/scheduler/` |

These are all Docker build contexts without source code, so the zero test count is expected. The actual source packages all have tests.

### 5.2 OpenCode Auth Route Missing Tests

The `packages/admin/src/routes/admin/opencode/providers/[id]/auth/+server.ts` file has an explicit TODO noting the lack of unit tests for API key and OAuth flows. This is a security-sensitive endpoint handling credential storage.

**Severity:** MEDIUM.

### 5.3 Conditional Skips in E2E Tests

All E2E `test.skip` calls are gated on environment flags (`RUN_DOCKER_STACK_TESTS`, `RUN_LLM_TESTS`) or runtime conditions (secret seeding). This is the intended pattern, not a gap. T6 enforces `PW_ENFORCE_NO_SKIP=1` to catch any test that tries to skip.

### 5.4 Memory Benchmark Tests Require External Infra

All memory benchmark tests (`packages/memory/benchmark-tests/`) use `test.skipIf(SKIP)` gated on environment conditions. This is expected for infrastructure-dependent tests.

---

## 6. Migration Artifacts

### 6.1 LOW: `.dev-0.9.0/` directory

A leftover `.dev-0.9.0/` directory exists with a previous dev environment layout (containing `config/`, `data/`, `openpalm/`, `state/`, `test-logs/`, `work/`). It is gitignored and contains a `config/openpalm.yaml` file (the old v3 naming).

**Severity:** LOW -- Gitignored, won't affect builds.

### 6.2 Architecture SVG Shows Caddy (Addressed in 1.2)

The SVG at `docs/technical/architecture.svg` is a migration artifact showing the pre-retirement Caddy topology.

### 6.3 Cleanup Guardrail Tests

The file `packages/lib/src/control-plane/cleanup-guardrails.test.ts` actively prevents regression of cleaned-up patterns:
- Guardrail 1: No `config/components` references in active code
- Guardrail 2: No hardcoded compose project names
- Guardrail 6: No deprecated `OP_CONFIG_HOME`/`OP_STATE_HOME`/`OP_DATA_HOME` vars

These guardrails are passing, confirming the migration is complete. The guardrail tests themselves are not artifacts -- they are the desired defense against re-introduction.

---

## 7. CLAUDE.md Claims Verification

### 7.1 File Paths

| Claimed Path | Status |
|--------------|--------|
| `docs/technical/core-principles.md` | MISSING -- Moved to `docs/technical/core-principles.md` |
| `docs/technical/docker-dependency-resolution.md` | MISSING -- Moved to `docs/technical/docker-dependency-resolution.md` |
| `packages/lib/src/index.ts` | EXISTS |
| `packages/lib/src/control-plane/lifecycle.ts` | EXISTS |
| `packages/lib/src/control-plane/config-persistence.ts` | EXISTS |
| `packages/lib/src/control-plane/types.ts` | EXISTS |
| `packages/admin/src/lib/server/docker.ts` | EXISTS |
| `packages/admin/src/lib/types.ts` | EXISTS |
| `packages/admin/src/lib/auth.ts` | EXISTS |
| `packages/admin/src/lib/api.ts` | EXISTS |
| `packages/admin/src/lib/opencode/client.server.ts` | EXISTS |
| `packages/cli/src/lib/cli-state.ts` | EXISTS |
| `packages/cli/src/commands/install.ts` | EXISTS |
| `packages/scheduler/src/server.ts` | EXISTS |
| `core/guardian/src/server.ts` | EXISTS |
| `packages/channels-sdk/src/logger.ts` | EXISTS |
| `.openpalm/stack/core.compose.yml` | EXISTS |
| `.openpalm/stack/README.md` | EXISTS |
| `packages/assistant-tools/AGENTS.md` | EXISTS |
| `packages/assistant-tools/src/index.ts` | EXISTS |
| `packages/admin-tools/src/index.ts` | EXISTS |
| `.opencode/opencode.json` | EXISTS |
| `docs/technical/package-management.md` | EXISTS |
| `docs/technical/bunjs-rules.md` | EXISTS |
| `docs/technical/sveltekit-rules.md` | EXISTS |
| `docs/technical/code-quality-principles.md` | EXISTS |
| `packages/admin/src/lib/server/helpers.ts` | EXISTS |

**2 of 27 file paths are broken.** Both are authoritative docs that were moved to the `authoritative/` subdirectory.

### 7.2 Commands

All listed commands in CLAUDE.md exist in `package.json`:
- `admin:dev`, `admin:build`, `admin:check`, `admin:test`, `admin:test:unit`, `admin:test:e2e`, `admin:test:e2e:mocked`, `admin:test:stack`, `admin:test:llm`
- `guardian:dev`, `guardian:test`
- `sdk:test`, `cli:test`, `scheduler:test`
- `channel:chat:dev`, `channel:api:dev`, `channel:discord:dev`, `channel:slack:dev`, `channel:voice:dev`
- `wizard:dev`, `dev:setup`, `dev:stack`, `dev:build`, `check`
- `test:t1` through `test:t6`

**All 30+ commands verified.**

### 7.3 Architecture Descriptions

The architecture description in CLAUDE.md is generally accurate:
- CLI orchestrates Docker Compose (correct)
- Admin is SvelteKit (correct)
- Guardian does HMAC/validate (correct)
- Assistant has no Docker socket (correct -- verified in compose)
- Scheduler reads automations (correct)
- Admin uses docker-socket-proxy (correct -- verified in admin addon compose)

**Stale claims:**
- "Both use the same `CoreAssetProvider` interface" -- removed
- "`$stack` alias (`ViteAssetProvider`)" -- removed
- "`getSetupManager()` / `getStackManager()` are async" -- these functions do not exist

### 7.4 Test Suite Descriptions

The test suite table is accurate:
- `bun test` (root) runs non-admin tests (verified: channels-sdk, guardian, cli, channel packages, lib, scheduler, assistant-tools, admin-tools)
- Vitest runs admin unit tests
- Playwright runs admin e2e
- Stack/LLM test tiers work as described

---

## 8. Registry/Plugin System

### 8.1 Registry System -- Implemented

The registry system in `packages/lib/src/control-plane/registry.ts` (287 lines) is functional:
- `ensureRegistryClone()` -- sparse git clone of the repo's `.openpalm/` directory
- `pullRegistry()` -- git pull for updates
- `discoverRegistryComponents()` -- scans addons from cloned repo
- `discoverRegistryAutomations()` -- scans automations from cloned repo
- `buildMergedRegistry()` -- merges remote and local automations

Admin routes for the registry exist and work:
- `GET /admin/registry` -- lists automations with install status
- `POST /admin/registry/install` -- installs automations only (channels via `/admin/addons`)
- `POST /admin/registry/uninstall` -- removes automations
- `POST /admin/registry/refresh` -- pulls latest

**Limitation:** The registry is automation-only. Channel/addon management is handled by `/admin/addons` endpoints against on-disk overlays in `.openpalm/stack/addons/`. This is by design and documented.

### 8.2 "Add a Channel by Dropping an Addon Compose File" -- Verified

The claim works as described:
- Each addon in `.openpalm/stack/addons/<name>/compose.yml` is discovered by `discoverStackOverlays()` in config-persistence.ts
- Channel addons are identified by compose-derived truth (CHANNEL_NAME or GUARDIAN_URL env vars) via `isChannelAddon()`
- All 8 addons (admin, api, chat, discord, ollama, openviking, slack, voice) have compose.yml and .env.schema files
- The admin API at `POST /admin/addons/:name` can enable/disable addons and auto-generates HMAC secrets for channel addons

### 8.3 Plugin System (OpenCode Plugins)

The assistant tools (`packages/assistant-tools/`) and admin tools (`packages/admin-tools/`) are OpenCode plugins:
- `assistant-tools/src/index.ts` -- registers memory tools + session hooks
- `admin-tools/src/index.ts` -- registers admin API tools + skills
- Both have test coverage (6 test files for assistant-tools, 1 for admin-tools)

---

## Summary of Findings by Severity

### HIGH (3)

1. **CLAUDE.md references `docs/technical/core-principles.md` (4 times) and `docs/technical/docker-dependency-resolution.md` (3 times) -- both paths are broken.** Actual paths are under `docs/technical/`. This is the project's primary instruction file giving wrong paths to its most critical documents.

2. **`docs/technical/environment-and-mounts.md` memory environment section is stale.** Lists `OPENAI_API_KEY`/`OPENAI_BASE_URL` but compose uses `OP_CAP_*` capability variables.

3. **`docs/technical/architecture.svg` still shows Caddy** as the reverse proxy despite Caddy being retired.

### MEDIUM (7)

4. Dead env vars: `OP_INGRESS_PORT`, `OP_INGRESS_BIND_ADDRESS` generated in stack.env but consumed by nothing (Caddy artifacts).
5. Dead env var: `OP_GUARDIAN_PORT` generated but guardian has no host port binding.
6. CLAUDE.md claims `CoreAssetProvider`, `ViteAssetProvider`, `getSetupManager()`, `getStackManager()` -- all removed/nonexistent.
7. MEMORY.md contains multiple stale entries (Stack Spec v3, `packages/lib/assets/`, `snippet.import`, `writeOpenCodeProviderConfig`).
8. OpenCode auth route (`providers/[id]/auth/+server.ts`) has explicit TODO for missing unit tests on a security-critical endpoint.
9. `OP_OLLAMA_ENABLED` and `OP_ADMIN_ENABLED` feature flags written to stack.env but not consumed by any compose or runtime logic.
10. `docs/technical/environment-and-mounts.md` references a manual-compose-runbook.md path that exists but the doc's own service env tables are outdated.

### LOW (3)

11. Dead env var: `OP_SCHEDULER_PORT` generated but unused (scheduler is internal-only).
12. `.dev-0.9.0/` directory is a gitignored migration artifact.
13. ManageModelsSheet.svelte has a TODO for N+1 provider fetch optimization.
