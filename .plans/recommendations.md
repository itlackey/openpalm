# Testing Recommendations

**Analyzed:** `dev/docs/testing-todos.md` against the actual codebase state.
**Goal:** Prune gold-plating. Keep only changes that are lightweight, directly address real breakage, and are grounded in what the code actually looks like today.

---

## Summary

The `testing-todos.md` document contains many sound ideas but several are based on stale assumptions about the codebase. Key findings from code inspection:

- **Several "fixes" are already done.** Bun versions are unified at 1.3.5, `opencode-ai` is already pinned via `ARG OPENCODE_VERSION`, all CI workflows already have `concurrency` blocks and `timeout-minutes`, and all `bun install` steps already use `--frozen-lockfile`. `bunfig.toml` exists.
- **Env-var mutation is already properly restored** in `automations.test.ts`, `openmemory-http.test.ts`, and `assistant-client.test.ts`. The `globalThis.fetch` mock is in a `finally` block.
- **The docker test file** is already correctly isolated as `.docker.ts` (not `.test.ts`), so it is not picked up by `bun test` — the filter problem is largely solved.
- **`admin-e2e.test.ts` does not exist** — hardcoded port and missing cleanup issues mentioned in the todos refer to a file that was never created.
- **Vitest browser mode is already configured** in `vite.config.ts` — the infrastructure for rendered component tests exists.
- **The `workspace:` CLI publish problem is already solved** — `publish-cli.yml` handles bundling externally.

What remains real and actionable falls into three categories: (1) the source-scan tests are genuinely weak and need replacing; (2) the Playwright E2E tests have no validation-error coverage; (3) the Docker happy-path E2E gate does not exist yet and is the highest-value gap.

The Phase 2 MSW layer, the visual regression CI workflow, the nightly multi-platform smoke, the full install harness with 8 separate modules, and Phase 4-D (CLI install + wizard + verify) are over-engineered for the current project size. They are dropped or collapsed below.

---

## Recommendations

### 1. Delete source-scan tests; add rendered component tests for the wizard

**Problem:** `packages/ui/src/lib/components/setup-wizard.test.ts` reads `SetupWizard.svelte` as a raw string and asserts that identifiers like `"finishInProgress"` are present in the source text. These tests pass even when the UI is broken at runtime and fail on any refactor. They give false confidence.

**Solution:** Delete `setup-wizard.test.ts`. Create `packages/ui/src/lib/components/SetupWizard.svelte.test.ts` (`.svelte.test.ts` extension for Svelte 5 rune support). Vitest browser mode and Chromium are already configured in `vite.config.ts:108–121`. Use `vitest-browser-svelte` to render and interact with the component. Minimum four tests: renders Welcome step, navigates to Profile on Next click, shows error for short password, shows error for mismatched passwords.

**References:**
- `packages/ui/src/lib/components/setup-wizard.test.ts` — entire file is source scans
- `packages/ui/vite.config.ts:108–121` — browser mode already configured with Chromium
- `dev/docs/testing-todos.md:95–103` (P2-A)

---

### 2. Add validation-error and API-failure tests to the existing Playwright suite

**Problem:** `packages/ui/e2e/10-setup-wizard-ui.pw.ts` has four happy-path tests (lines 32–98) but zero coverage of validation errors (short password, mismatched passwords, missing Anthropic key) and zero coverage of API failure paths (`setup.complete` returning an error). These are the most common user-facing failure modes.

**Solution:** Add tests directly to the existing `10-setup-wizard-ui.pw.ts` file using Playwright's built-in `page.route()` for API interception — no new dependencies. Add:
- Profile step rejects short password (<8 chars) — stays on step, error visible.
- Profile step rejects mismatched passwords — stays on step, error visible.
- Providers step rejects missing Anthropic key.
- `setup.complete` failure (route intercepted to return 500) → "Setup failed:" shown, Finish button re-enabled.

**References:**
- `packages/ui/e2e/10-setup-wizard-ui.pw.ts:32–98` — existing tests have no error coverage
- `packages/ui/playwright.config.ts` — single Chromium config, no changes needed
- `dev/docs/testing-todos.md:73–81` (P1-B)

---

### 3. Add the Docker-backed happy-path wizard E2E gate

**Problem:** `release.yml` passes CI green today without proving the full install→wizard→`setup.complete`→healthy runtime path works with real Docker Compose. `OPENPALM_TEST_MODE=1` is set in all Playwright tests, which bypasses the actual compose/apply path. There is no `test/install-e2e/` directory.

**Solution:** Create `test/install-e2e/happy-path.docker.ts` — a single Bun test file (no custom harness, no 8-module framework) that drives the setup API directly. Guard with `describe.skipIf(!Bun.env.OPENPALM_RUN_DOCKER_STACK_TESTS)`, mirroring the pattern already used in `test/docker/docker-stack.docker.ts:31–34`. The test calls setup API commands in sequence (profile, service instances, access scope, channels, complete), then asserts `completed: true` and that an unauthenticated request gets 401. Add this as a required `setup-wizard-e2e` job in `release.yml`, parallel to the existing `docker-build` job. Upload logs on failure.

**References:**
- `test/docker/docker-stack.docker.ts:31–34` — guard pattern to mirror
- `.github/workflows/release.yml:100–165` — where to add the new job
- `dev/docs/testing-todos.md:141–158` (P3-A)

---

### 4. Fix `bunfig.toml` — enforce frozen installs globally

**Problem:** `bunfig.toml:6` sets `frozen = false`. The `--frozen-lockfile` flag is applied in each CI workflow step as a manual per-step override. This means any new workflow step or local developer who forgets the flag gets non-reproducible installs.

**Solution:** Set `frozen = true` in `bunfig.toml`. The CI workflows already pass `--frozen-lockfile` explicitly so there is no regression. This makes the default consistent with CI behavior for local development too.

**References:**
- `bunfig.toml:6` — `frozen = false` is the current setting
- `dev/docs/testing-todos.md` (CI-D)

---

### 5. Add SetupManager edge-case unit tests

**Problem:** `packages/lib/src/admin/setup-manager.test.ts` is well-written (251 lines) but is missing tests for `setEnabledChannels` (the method has no coverage at all), `completeSetup` idempotency, and forward-compatibility with unknown fields in the state file.

**Solution:** Add three test cases to the existing `setup-manager.test.ts` file: (a) `setEnabledChannels` with a duplicate list — deduplicates correctly; (b) calling `completeSetup` twice — second call does not clear state or throw; (c) state file contains unknown extra field — `getState` returns defaults for known fields and ignores the extra field. These are pure unit tests with no new dependencies, targeting a class that is core to the setup flow.

**References:**
- `packages/lib/src/admin/setup-manager.test.ts:1–251` — no `setEnabledChannels` tests exist
- `dev/docs/testing-todos.md:107–112` (P2-B)

---

### 6. Remove the integration test silent-skip problem

**Problem:** All files in `test/integration/` use `describe.skipIf(!stackAvailable)` where `stackAvailable` is determined by a `fetch` probe to `localhost:8100`. In CI, this means the entire integration test tier silently skips every run — there is no visible indication in CI output that zero integration tests ran. This creates false confidence in the release gate.

**Solution:** In `release.yml`, the `integration` job already runs `bun test --filter integration` (line 79). Change the skip guard from a runtime fetch probe to an explicit env var (`OPENPALM_INTEGRATION=1`) that is set only when the job intentionally provisions a stack. For the release workflow, either provision a real stack in the job or remove the job from `needs:` — a job that always skips everything is not a gate. Option B (simpler): move integration tests into the `test/docker/` tier with a `.docker.ts` extension so they are never included in the standard `bun test` run and are only run when explicitly opted in.

**References:**
- `test/integration/admin-auth.integration.test.ts` (and siblings) — all use the fetch probe guard
- `.github/workflows/release.yml:79` — integration job runs but silently passes
- `dev/docs/testing-todos.md` (CI-A, release gate policy)

---

## Dropped from testing-todos.md (over-engineered for current size)

The following items from `testing-todos.md` are **not recommended** at this time:

- **P1-B cross-browser (Firefox/WebKit):** Deferred until the core system is stable and useful. Chromium coverage is sufficient for now.
- **P2-C (MSW):** The Playwright route interception approach (Rec 2 above) achieves the same API failure coverage with zero new dependencies. MSW adds a significant dependency and setup burden for marginal benefit over `page.route()`.
- **P2-D (test-components.yml):** The existing `test-ui.yml` can run Vitest browser mode by adding a step. A separate workflow file is unnecessary overhead.
- **P3-E (visual regression workflow):** Screenshot tests are brittle by nature — they break on font rendering differences across OS and minor CSS tweaks. Not worth the maintenance cost at this stage.
- **P4-B (8-module install harness):** `happy-path.docker.ts` (Rec 3) using the existing docker test pattern is sufficient. A custom harness with runner, scenario-loader, reporter, artifacts, etc. is a framework, not a test.
- **P4-C (nightly multi-platform smoke):** Defer until the Docker happy-path gate (Rec 3) is stable for several releases.
- **P4-D (CLI install + wizard + verify full E2E):** The highest-confidence test, but requires significant infrastructure. Defer.
- **CI-B retry logic / manifest validation / CI-E composite actions:** The `publish-images.yml` already validates manifests (lines 191–242). Retry logic and composite actions are workflow maintenance improvements, not test improvements. Out of scope.
- **Several CI-C/CI-D items:** Bun versions are already unified. `opencode-ai` is already pinned. `--frozen-lockfile` is already applied in CI. `bunfig.toml` exists (only Rec 4 above makes a real change).
