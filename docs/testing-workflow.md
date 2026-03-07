# Complete OpenPalm Testing Workflow

Testing is organized into 6 tiers, from fastest/simplest to most thorough. Run them in order — each builds on the confidence established by the previous tier.

---

## Tier 1: Type Checking & Linting

**Time:** ~10s | **Prerequisites:** None

```bash
bun run check    # svelte-check + TypeScript + sdk tests
```

Validates type correctness across all SvelteKit admin code and channels-sdk.

---

## Tier 2: Unit Tests

**Time:** ~30s | **Prerequisites:** None

```bash
# All non-admin packages (channels-sdk, guardian, channel-*, cli)
bun run test

# Admin unit tests (Vitest — server + browser)
bun run admin:test:unit

# Or run individually:
bun run sdk:test          # packages/channels-sdk (3 test files)
bun run guardian:test     # core/guardian security tests (1 file)
bun run cli:test          # core/cli (1 file)
```

**What it validates:** SDK contracts, guardian HMAC/replay/rate-limiting, channel adapters, CLI parsing, admin server logic (docker wrapper, helpers, secrets, env management), admin client components.

**Test count:** ~451 admin unit tests + guardian/sdk/channel/cli tests.

---

## Tier 3: E2E Tests — No Stack

**Time:** ~2min | **Prerequisites:** Admin build (`bun run admin:build`)

```bash
bun run admin:test:e2e
```

Runs Playwright against a built admin app with mocked API endpoints. Tests the setup wizard flow (10 tests: navigation, validation, wizard steps).

Use `bun run admin:test` to run both unit + e2e together (builds automatically).

---

## Tier 4: Stack Integration Tests

**Time:** ~15min | **Prerequisites:** Running compose stack

```bash
# 1. Start the dev stack
bun run dev:build          # to rebuild images

# 2. Run stack-dependent Playwright tests
cd core/admin && RUN_DOCKER_STACK_TESTS=1 ADMIN_TOKEN=dev-admin-token npx playwright test
```

**What it validates:**
- OpenCode web UI accessible on `:4096`
- OpenMemory CRUD operations via `:8765`
- OpenCode API session management
- Memory user provisioning

**Tests gated by:** `RUN_DOCKER_STACK_TESTS=1` env var (skipped otherwise).

**Files:** `e2e/opencode-ui.test.ts`, `e2e/memory-config.test.ts`, `e2e/assistant-pipeline.test.ts` (groups 1-4)

---

## Tier 5: LLM Pipeline Tests

**Time:** ~30min | **Prerequisites:** Running stack + Docker Model Runner with GGUF models

```bash
cd core/admin && \
  RUN_DOCKER_STACK_TESTS=1 \
  RUN_LLM_TESTS=1 \
  ADMIN_TOKEN=dev-admin-token \
  npx playwright test
```

**What it validates:**
- Full assistant message pipeline (send message → LLM inference → response)
- Memory integration end-to-end (assistant adds memory via `memory-add` tool, recalls via `memory-search`)
- Embedding pipeline

**Model prerequisites:** Docker Model Runner with packaged GGUF models:
- Qwen3.5-4B (system LLM, ~2.8GB)
- bge-base-en-v1.5 (embeddings, 768 dims)

**Files:** `e2e/assistant-pipeline.test.ts` (groups 5-6)

---

## Tier 6: Full Dev E2E Script

**Time:** 20-60min | **Prerequisites:** Docker, internet (for GGUF downloads on first run)

```bash
./scripts/dev-e2e-test.sh            # Full build + fresh environment
./scripts/dev-e2e-test.sh --skip-build  # Reuse existing admin image
```

This is the "nuclear option" — tests everything from a completely clean slate. It runs 30 verification steps:

1. Stops all containers, cleans `.dev/` state completely
2. Seeds fresh config via `dev-setup.sh --seed-env --force`
3. Downloads & packages GGUF models into Docker Model Runner
4. Builds admin image from source
5. Starts compose stack
6. Verifies fresh state (setup NOT complete)
7. Runs setup wizard via API (POST `/admin/setup`)
8. Waits for all 6 services to become healthy
9. Validates `secrets.env` values, container env vars, file ownership
10. Verifies OpenMemory user provisioned
11. Tests assistant memory tools end-to-end (add + search)
12. Reports pass/fail summary

---

## Quick Reference

| Speed | Command | Coverage |
|-------|---------|----------|
| Fastest (~30s) | `bun run check && bun run test && bun run admin:test:unit` | Types + all unit tests |
| Medium (~5min) | Above + `bun run admin:test` | + E2E wizard flow |
| Thorough (~15min) | Above + stack tests (Tier 4) | + live service integration |
| Full (~30min) | Above + LLM tests (Tier 5) | + real LLM inference |
| Nuclear (~60min) | `./scripts/dev-e2e-test.sh` | Everything from clean slate |

## Recommended Local Workflow

```bash
# 1. Quick validation (always run before committing)
bun run check && bun run test && bun run admin:test:unit

# 2. Full offline tests (run before pushing)
bun run admin:test    # includes build + unit + e2e

# 3. Integration validation (run for stack-touching changes)
bun run dev:build
cd core/admin && RUN_DOCKER_STACK_TESTS=1 ADMIN_TOKEN=dev-admin-token npx playwright test

# 4. Full pipeline validation (run for LLM/memory changes)
cd core/admin && RUN_DOCKER_STACK_TESTS=1 RUN_LLM_TESTS=1 ADMIN_TOKEN=dev-admin-token npx playwright test

# 5. Clean-slate validation (run before releases)
./scripts/dev-e2e-test.sh
```
