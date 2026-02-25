# Testing Todos

Consolidated action items from all testing documents. This replaces:
- `dev/docs/testing-plan.md`
- `dev/docs/setup-wizard-e2e-test-strategy.md`
- `dev/docs/install-setup-reliability-implementation-guide.md`
- `dev/docs/ci-brittleness-report.md`
- `docs/ui-testing-improvement-report.md`

---

## Reference: Test Tiers

| Tier | Docker | Runs In CI | What It Catches |
|---|:---:|:---:|---|
| 1: Unit + CLI | No | Every PR | State logic bugs, data validation, persistence, CLI regressions |
| 2: Component + MSW | No | Every PR | Rendering bugs, API error handling, polling logic, state management |
| 3: Playwright E2E | No | Every PR | Full user flows, validation UX, cross-browser, visual regression |
| 4: Docker stack | Yes | Pre-release gate | Container build, networking, volumes, real compose apply, artifact correctness |

**Commands:**
```bash
bun run typecheck && bun test   # Required before any merge
bun run test:ci                 # Tier 1: hermetic unit/contract
bun run test:ui                 # Tier 2+3: Playwright E2E
bun run test:docker             # Tier 4: Docker stack (opt-in)
bun run test:install:smoke      # Tier 4: install/setup smoke (local pre-PR)
```

**Environment flags:** `OPENPALM_TEST_MODE=1` disables compose/apply side effects in UI routes.

---

## Release Gate Policy

A release is not eligible unless:

1. All Tier 1-3 tests pass (unit, component, Playwright E2E) — enforced on every PR.
2. Docker-backed happy-path wizard E2E passes — required job in `release.yml`.
3. Top 5 failure-matrix scenarios pass in at least Tier 3.
4. No unresolved P0/P1 setup bug without a replay test.
5. Failure artifacts are available for any failed Docker E2E scenario.

**Flake policy:** Label failures `product_regression` vs `test_flake`. Max 1 retry per test. Track rates separately.

**Pre-release human checklist:**
1. All changes merged via PR. No direct pushes to `main`.
2. PR CI passed (`test` and `test-ui` workflows).
3. Run locally if in doubt: `bun run typecheck && bun test`
4. Check for skipped tests — verify skips are intentional environment guards, not hidden failures.

---

## Phase 1: Quick Wins — Immediate

### P1-A: Stop Tests From Failing in CI

- [ ] **Gate environment-dependent tests properly.** Replace filename filter patterns with explicit `skipIf` guards at the top of test files. Use `openpalmInstalled` (not just `dockerAvailable`) for any test that runs `docker compose` with file arguments referencing the OpenPalm state directory.
  - Files: `test/docker/docker-stack.test.ts`, `.github/workflows/test.yml`

- [ ] **Fix test isolation — env var mutation leaks.** Any test that mutates `Bun.env`/`process.env` must save and restore in `beforeEach`/`afterEach`.
  - Files: `packages/lib/src/admin/automations.test.ts`, `core/assistant/extensions/plugins/openmemory-http.test.ts`

- [ ] **Report skipped test suites as CI warnings.** Add a step to `test.yml` that counts and surface-warns on skipped suites so coverage gaps are visible.

- [ ] **Separate CI jobs by environment requirement:**
  - `unit` — no external deps, hermetic (`bun run test:ci`)
  - `ui` — Bun-based Playwright (`bun run test:ui`)
  - `docker` — Docker daemon required (`bun run test:docker`)

### P1-B: Add Validation Error Tests (Playwright, no new deps)

- [ ] **Add password validation tests to `10-setup-wizard-ui.pw.ts`:**
  - Short password (<8 chars) — error visible, stays on Profile step.
  - Mismatched passwords — error visible, stays on Profile step.
  - Missing Anthropic API key — error visible, stays on Providers step.

- [ ] **Add Playwright route interception tests for API failures:**
  - Profile save returns 500 → "Could not save your profile" shown, retry possible.
  - `setup.complete` fails (Docker unavailable) → "Setup failed:" with actionable message, Finish button re-enabled.

- [ ] **Add cross-browser projects to `playwright.config.ts`:** Add Firefox and WebKit alongside Chromium.

### P1-C: Install CLI Regression Tests

- [ ] **`install --help` exits 0 without triggering install.** Regression: previously ran the install flow.
- [ ] **`install --runtime docker` with daemon down shows explicit error** with issue link, not a vague message.

---

## Phase 2: Component Testing Layer (3–5 days)

### P2-A: Replace Source-Text Scanning with Rendered Component Tests

- [ ] **Create `packages/ui/src/lib/components/SetupWizard.svelte.test.ts`** (`.svelte.test.ts` extension for Svelte 5 rune support). Use Vitest Browser Mode + `vitest-browser-svelte` to render and interact with the real component. Minimum coverage:
  - Renders Welcome step on initial load.
  - Navigates to Profile step on Next click.
  - Shows password validation error for short passwords.
  - Shows mismatch error when passwords differ.

- [ ] **Add component tests for each step** (`WelcomeStep`, `ProfileStep`, `ProvidersStep`, `SecurityStep`, `ChannelsStep`, `AccessStep`, `HealthStep`, `CompleteStep`). Key behaviors: props, rendering, form behavior, error display.

- [ ] **Delete `setup-wizard.test.ts` source-scan tests** once behavior tests are in place.

### P2-B: SetupManager Edge Cases

- [ ] **Add to `setup-manager.test.ts`:**
  - `setProfile` with empty strings.
  - `setEnabledChannels` deduplication.
  - `completeSetup` idempotency (calling twice).
  - State file with extra/unknown fields (forward compatibility).
  - Concurrent `save()` calls (race condition simulation).

### P2-C: Add MSW for API Layer Testing

- [ ] **Install `msw`.** Create `packages/ui/src/mocks/handlers.ts` and `server.ts`. Wire into `vitest.setup.ts` with `beforeAll`/`afterEach`/`afterAll` lifecycle. Use MSW v2 `http`/`HttpResponse` API.

- [ ] **Add error scenario tests using MSW handler overrides:**
  - Profile API returns 500 → error shown, retry possible.
  - Network unreachable (`HttpResponse.error()`) → "Server unreachable" shown.
  - `setup.complete` fails → "Setup failed:" with retry button re-enabled.

- [ ] **Test `CompleteStep` polling with MSW + fake timers:**
  - All services healthy → "Everything is ready!" shown.
  - Services never become ready (advance 121s) → timeout state shown.
  - Partial readiness → correct per-service status shown.

### P2-D: Add CI Workflow for Component Tests

- [ ] **Create `.github/workflows/test-components.yml`** — Vitest browser-mode job on PRs and `main` push. Install Chromium via `bunx playwright install --with-deps chromium`. Run with `bun run --filter @openpalm/ui vitest run --project client`.

### P2-E: Migrate Regression Tests from Source Scan to Behavior

- [ ] **Migrate ISSUE-2 (password validation in ProfileStep)** from `setup-wizard.test.ts` string match to rendered component assertion.
- [ ] **Migrate ISSUE-9 (finishSetup error handling and retry guard)** from `setup-wizard.test.ts` string match to behavior test: click Finish Setup, verify button shows "Finishing..." and is disabled, verify re-enables after failure.

---

## Phase 3: Docker & Visual (1–2 weeks)

### P3-A: Docker-Backed Happy-Path Wizard E2E (highest-value item)

- [ ] **Create `test/install-e2e/happy-path.docker.ts`** — runs against real Docker Compose with `OPENPALM_TEST_MODE` **off**. Steps:
  1. Verify first-boot state (`firstBoot: true`).
  2. Save profile (name, email, password).
  3. Configure service instances (incl. Anthropic key).
  4. Set access scope.
  5. Enable channels.
  6. Mark all steps complete.
  7. Call `setup.complete` — real compose apply, not test mode.
  8. Verify `completed: true`, `firstBoot: false`.
  9. Verify auth is now required (unauthenticated request → 401).

- [ ] **Guard with `describe.skipIf(!runDockerStackTests)`** using `OPENPALM_RUN_DOCKER_STACK_TESTS=1` env var.

- [ ] **Add `setup-wizard-e2e` as a required job in `release.yml`** — block releases on wizard completion. Upload logs on failure via `actions/upload-artifact`.

- [ ] **Add `bun run test:install:smoke` script** for local developer pre-PR validation. Target: under 10 minutes.

### P3-B: Scenario Isolation Requirements

- [ ] **Every Docker test run gets isolated roots:**
  - `.tmp/install-e2e/<run-id>/<scenario-id>/DATA|STATE|CONFIG|workspace`
  - Unique compose project name: `openpalm_test_<scenario>_<shortid>`
  - Dynamic port allocation (never hardcode) — use `port: 0` or a lock-backed allocator

- [ ] **Explicitly block tests from using existing `.dev` state** to avoid false positives.

### P3-C: Failure-Matrix Docker Scenarios

- [ ] **Add scenario tests for common first-run blockers (Tier 4):**
  - Missing/invalid secret in `secrets.env`.
  - Docker daemon unavailable.
  - Required host port conflict.
  - DATA/STATE permission errors.
  - Invalid channel config in wizard payload.
  - Partial/interrupted setup then retry.
  - Docker daemon stops mid-setup.

  Each must assert: actionable error message, safe state (no corrupted setup), no orphaned containers.

- [ ] **Release policy: at least 3 highest-frequency negative scenarios run in release gate.**

### P3-D: Artifact & Compose Contract Validation

- [ ] **Add assertion helpers run before and after `setup.complete`:**
  - `docker compose config` passes.
  - Generated compose includes required core services.
  - Network placement: channels on `channel_net`, internal services on `assistant_net` only.
  - Scoped `.env` files contain only referenced secrets.
  - Generated `caddy.json` is valid JSON and includes required base routes.

- [ ] **Upload diagnostic bundle on any Docker E2E failure:** command transcript, `compose config` output, `compose ps`, `compose logs`, `setup-state.json`, generated env/caddy/compose files.

### P3-E: Visual Regression Tests

- [ ] **Add Playwright screenshot assertions** (`toHaveScreenshot()`) for each wizard step and error state. Scope to `.wizard` element. Use `maxDiffPixelRatio: 0.01`. Mask dynamic content. Run only on Linux CI for consistency.

- [ ] **Create `.github/workflows/test-visual.yml`** — screenshot regression job on PRs. Upload `test-results/` on failure.

---

## Phase 4: Full Confidence (Ongoing)

### P4-A: Regression Replay Test Pack

- [ ] **Create `test/regressions/README.md`** codifying the policy: any setup bug fix must include a replay test in the same PR. Each test maps `issue-id -> scenario-id`.

- [ ] **Add replay tests for recent incidents** (start with issues that have been fixed but only covered by source-scan tests).

- [ ] **Add PR template checklist item:** "If this fixes a setup bug, a replay test is included."

### P4-B: Install Harness Skeleton (`test/install-e2e/`)

- [ ] Create `runner.ts` — scenario orchestration, retries, overall exit status.
- [ ] Create `scenario-types.ts` — typed scenario contract (id, title, tags, preconditions, steps, expected, cleanupPolicy, timeouts).
- [ ] Create `environment.ts` — temp directory and project-name provisioning.
- [ ] Create `command-runner.ts` — command execution, timeout, stdout/stderr capture, normalized failure codes.
- [ ] Create `assertions/` — reusable contract helpers (compose, network, env, health).
- [ ] Create `artifacts.ts` — logs/snapshots/compose outputs persistence.
- [ ] Create `reporter.ts` — terminal summary + JSON summary output.
- [ ] Add CLI flags: `--scenario`, `--tags`, `--parallel`, `--dry-run`, `--keep-on-fail`.

  **Exit criteria:** dry-run prints resolved scenario plan and exits 0.

### P4-C: Nightly Multi-Platform Installer Smoke

- [ ] **Add nightly workflow** (non-blocking for PRs, blocking for release-week cut): Linux + macOS clean-host runs of `install.sh` + CLI install path. Verify bootstrap services come up and wizard reaches completion checkpoint. Archive logs/artifacts.

### P4-D: Install → Wizard → Running System Full E2E

- [ ] **Add CLI install + wizard UI + verify health E2E** — the ultimate confidence test. Runs `openpalm install`, completes wizard through browser, asserts all core services healthy.

---

## CI Infrastructure Fixes (From Brittleness Report)

### CI-A: Fix Port Allocation and Timing (This Sprint)

- [ ] **Replace all hardcoded/random port assignments with `port: 0`** (OS auto-assign). Files: `core/admin/src/admin-e2e.test.ts`.
- [ ] **Use exponential backoff for health check polling.** Replace fixed-wait loops with bounded backoff (start 100ms, double, cap at 5s, max 30s).
- [ ] **Always await async cleanup** — `proc?.kill()` then `await proc?.exited` before `rmSync`. Files: `core/admin/src/admin-e2e.test.ts`, gateway/channel tests.
- [ ] **Fix `globalThis.fetch` mock leak** in `core/gateway/src/assistant-client.test.ts` — use try/finally guarantee.

### CI-B: Add Workflow Safeguards (This Sprint)

- [ ] **Add `concurrency` blocks to all workflows** — `cancel-in-progress: true` for test workflows, `false` for publish workflows.
- [ ] **Add `timeout-minutes` to all jobs** — unit: 10, integration: 15, ui: 20, publish: 45.
- [ ] **Add retry logic for network operations** (Docker Hub push, npm publish, git push) — 3 attempts with backoff.
- [ ] **Validate multi-arch manifests after creation** — assert both `linux/amd64` and `linux/arm64` present before declaring success.

### CI-C: Dockerfile Stability (This Week)

- [ ] **Add Docker build validation step to `test.yml`** — matrix build for all services (`gateway`, `admin`, `assistant`, `chat`, `discord`, `telegram`, `voice`, `webhook`) on every PR. Catches `COPY` path errors before a release tag.
- [ ] **Pin `opencode-ai` to a specific version** in the assistant Dockerfile (e.g. `ARG OPENCODE_VERSION=0.5.2`).
- [ ] **Unify Bun version** across all services — assistant currently uses 1.1.42, all others use 1.3.5.

### CI-D: Dependency Hygiene (This Week)

- [ ] **Regenerate `bun.lock`** (`rm bun.lock && bun install`) and add `--frozen-lockfile` to all CI install steps.
- [ ] **Create `bunfig.toml`** with `[install] frozen = true` and `[test] timeout = 10000`.
- [ ] **Solve `workspace:` protocol problem for CLI publish** — add `prepublish` build step that bundles to `dist/` with no workspace deps, and add a smoke test (`node dist/openpalm.js --version`) before npm publish.

### CI-E: Deduplicate Workflow Configuration (Next Sprint)

- [ ] **Create `.github/components.json`** — single source of truth for component/image list. All workflows (version bump, publish-images, release) read from it instead of maintaining separate hardcoded lists.
- [ ] **Extract common workflow patterns** into composite GitHub Actions (retry-push, setup-bun-install, etc.).

---

## Metrics to Track

After implementing CI fixes, track monthly:

| Metric | Target |
|---|---|
| Fix-to-feature commit ratio | < 1:3 (currently 9.5:1) |
| Clean release rate | > 90% (currently 0%) |
| CI pass rate on first push | > 80% (currently ~50%) |
| Skipped test count in CI | Trending toward 0 |
| Time from push to green CI (p50/p95) | Establish baseline, improve |
