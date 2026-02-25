# Setup Wizard Release-Critical Test Strategy (Top 5)

Goal: catch setup-wizard breakage **before release** with tests that prove install and setup really work end-to-end.

## Why this needs to change now

Current setup coverage is weighted toward unit/string checks and test-mode flows, which do not reliably validate the full install→wizard→apply→healthy-runtime path. The release workflow currently runs unit/integration/contract/security/UI and Docker image build, but does **not** run a Docker-backed setup wizard completion gate. That leaves a gap where setup can still fail in real environments even when CI is green.


## Current implementation gap analysis (strategy vs reality)

The strategy is directionally correct, but a few concrete gaps remain when compared to the current repo:

| Area | Current implementation | Gap to close | Recommendation |
|---|---|---|---|
| Setup wizard tests | `packages/ui/src/lib/components/setup-wizard.test.ts` is mostly source-string assertions. | Low confidence that real wizard completion works against runtime + compose. | Add behavior-first e2e tests that drive real setup steps and validate side effects (`setup.complete` + healthy services). |
| Setup completion path | `setup.complete` performs real apply/startup only when `OPENPALM_TEST_MODE !== 1`. | Test-mode can mask runtime/apply failures that only happen with real Docker compose. | Ensure release-gating tests run with real compose path (test mode off) in Docker-capable runners. |
| Existing docker integration | `test/docker/docker-stack.docker.ts` is opt-in (`OPENPALM_RUN_DOCKER_STACK_TESTS=1`) and validates mostly admin/gateway bring-up. | Does not prove full install + wizard completion end-to-end. | Introduce dedicated install/setup wizard docker scenarios (happy path + negatives), separate from generic stack bring-up tests. |
| Contract gate for wizard | `test/contracts/setup-wizard-gate.contract.test.ts` is skipped unless stack is already available. | Gate validates auth behavior, but not install/setup orchestration on clean CI hosts. | Keep contract test, but add independent scenario runner that provisions its own isolated environment and never relies on pre-existing stack state. |
| Release workflow gates | `release.yml` runs unit/integration/contracts/security/ui/docker-build, but no wizard completion e2e gate. | Releases can still pass without proving setup completion works in real runtime conditions. | Add a dedicated `setup-wizard-e2e` required job to release workflow and path-filtered PR workflow. |

## Distribution of highest-value ideas (chance to catch real setup failures)

The percentages below are the recommended confidence distribution for expected detection impact in aggregate. They are not mathematically exact probabilities; they are planning weights to prioritize engineering effort where bug catch-rate is highest.

| Priority | Idea | Detection weight |
|---|---|---:|
| 1 | Docker-backed full wizard happy-path e2e gate in CI | 35% |
| 2 | Deterministic failure-matrix scenarios for common first-run blockers | 25% |
| 3 | Install artifact + compose contract validation before `setup.complete` | 15% |
| 4 | Replay tests from production setup failure signatures | 15% |
| 5 | Nightly multi-platform installer smoke (Linux/macOS, clean host) | 10% |

Total: **100%**

---

## 1) Docker-backed full wizard happy-path e2e gate in CI (35%)

### What to build
- Add a new test suite (`test/install-e2e/happy-path.docker.ts`) that runs against real Docker Compose.
- Run real install entrypoint (`openpalm install --no-open --port <allocated>`), then complete the setup wizard through UI/API steps, ending in `setup.complete`.
- Assert hard outcomes:
  1. setup commands succeed in order,
  2. generated artifacts exist and are valid,
  3. required core services are running/healthy,
  4. Admin and setup-complete state are reachable.

### Why this catches real breakage
This is the closest automated equivalent of a first user install. It catches regressions in wiring between CLI, Admin API commands, stack generation, compose bring-up, and setup state transitions.

### Release policy
- Make this a **required release gate** (block release on failure).
- Run on PRs that touch setup/install/admin/compose paths; always run for release workflow.

---

## 2) Deterministic failure-matrix scenarios for common first-run blockers (25%)

### What to build
Add scenario tests that intentionally trigger high-frequency setup failures and assert actionable failures (correct error and safe stop):
- missing required secret/API key,
- ingress port conflict,
- docker daemon unavailable,
- invalid channel config in wizard payload,
- partial/interrupted setup then retry.

### Why this catches real breakage
Many setup incidents are not happy-path bugs; they are failure-handling bugs where users get stuck. These tests verify that failures are explicit, recoverable, and do not corrupt setup state.

### Release policy
- At least 3 highest-frequency negative scenarios run in release gate.
- Full failure matrix runs nightly.

---

## 3) Install artifact + compose contract validation before `setup.complete` (15%)

### What to build
Create assertion helpers run in e2e tests before and after `setup.complete`:
- `docker compose config` passes,
- generated compose includes required core services,
- network placement is correct (`channel_net` vs `assistant_net`),
- scoped env files include only referenced secrets,
- generated `caddy.json` is valid JSON and includes required base routes.

### Why this catches real breakage
Wizard failures often originate from generated artifacts being subtly wrong. This catches those issues earlier with precise failure context, instead of only seeing “setup failed.”

### Release policy
- Required in happy-path and negative scenarios.
- Artifact snapshots uploaded on failure.

---

## 4) Replay tests from production setup failure signatures (15%)

### What to build
Create a `setup-regressions` scenario pack where each historical setup incident becomes a permanent reproducible test:
- convert issue/support reports into minimal fixtures,
- codify expected behavior and error message,
- keep a mapping: `issue-id -> scenario-id`.

### Why this catches real breakage
This prevents the exact class of regressions that already escaped once. It steadily increases confidence with real-world coverage instead of hypothetical-only tests.

### Release policy
- Any setup bug fixed must include a replay test in the same PR.
- Release checklist includes “no open P0/P1 setup regressions without replay coverage.”

---

## 5) Nightly multi-platform installer smoke (Linux/macOS, clean host) (10%)

### What to build
Run nightly smoke jobs on clean runners:
- Linux and macOS install wrappers (`install.sh`) + CLI install path,
- verify bootstrap services come up,
- verify setup wizard reaches completion checkpoint,
- archive logs/artifacts.

### Why this catches real breakage
Some setup breakages are platform/shell/runtime-specific and won’t show in a single Linux CI path. Nightly smoke broadens environment realism without slowing every PR.

### Release policy
- Nightly is non-blocking for PRs but blocking for release week cut.

---

## Minimal acceptance bar for next release

A release is not eligible unless all are true:
1. Required happy-path e2e setup gate passes in Docker-backed CI.
2. Required negative scenario subset passes.
3. Failure artifacts are available for any failed scenario.
4. No unresolved P0/P1 setup bug without replay test coverage.

## Implementation order (fastest path to confidence)

1. Ship Idea #1 first (single happy path, blocking gate).
2. Add top 3 failure scenarios from Idea #2.
3. Add artifact/contract assertions from Idea #3.
4. Backfill replay pack from recent incidents (Idea #4).
5. Add nightly multi-platform smoke (Idea #5).


## Additional recommendations to strengthen the strategy

1. **Define explicit SLOs for the install/setup funnel**
   - Track: install start -> admin healthy -> wizard complete -> core healthy.
   - Require percentile bounds (example: p95 completion under X minutes in CI).

2. **Add strict artifact standards to every failed e2e run**
   - Minimum bundle: command transcript, compose config output, `compose ps`, `compose logs`, setup-state snapshot, generated env/caddy/compose files.
   - Fail tests if artifact bundle cannot be produced (debuggability is part of quality).

3. **Introduce flake accounting separate from product failures**
   - Label failures as `product_regression` vs `test_flake` in summary JSON.
   - Put a retry cap (max 1 retry) and report both first-fail + final status.

4. **Codify a “bug -> scenario” policy in CONTRIBUTING/release docs**
   - Any setup bug fix requires a matching scenario in the replay pack.
   - Enforce via PR template checklist item.

5. **Add a lightweight local developer command for fast confidence**
   - `bun run test:install:smoke` should be the one-command pre-PR setup validation.
   - Keep runtime under ~10 minutes so engineers actually run it before merge.

6. **Protect against hidden environment coupling**
   - Require scenario isolation (unique project name, ports, DATA/STATE/CONFIG roots).
   - Explicitly block tests from using existing `.dev` state to avoid false positives.

