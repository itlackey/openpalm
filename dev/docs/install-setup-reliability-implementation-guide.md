# Install/Setup Reliability Implementation Guide

This guide defines how to build and operate a local end-to-end reliability suite for OpenPalm install/setup.

The objective is simple: verify that realistic install/setup flows produce a usable Admin UI, and make failures easy to diagnose.

## 1) Scope, outcomes, and guardrails

### Primary outcome
A scenario is successful only when:
1. install/setup command flow succeeds (or fails with the expected actionable error),
2. core runtime is healthy,
3. Admin UI is reachable and setup-critical actions work.

### In scope (v1)
- Developer machine execution with Docker available.
- Real entrypoints (`dev:setup`, generated config/apply, stack start/health checks).
- Happy path + high-frequency failure modes users actually hit.
- Deterministic artifact capture for every failure.

### Out of scope (v1)
- Multi-host orchestration testing.
- Cloud provider-specific infrastructure validation.
- Performance benchmarking beyond basic timeout safety.

## 2) Preconditions for running the suite

Before starting any scenario:
- Bun and Docker are installed and available on `PATH`.
- The repo is clean or work is committed/stashed.
- No long-lived local stack uses the same reserved test port ranges.
- The runner can create and delete temporary folders under `.tmp/` and `.artifacts/`.

Recommended preflight checks in the runner:
- `docker version` and `docker compose version`.
- write/delete probe for `.tmp/install-e2e`.
- port allocator lock-file acquisition.

## 3) Reference architecture for the test harness

Create `test/install-e2e/` with these modules:
- `runner.ts` — scenario orchestration, retries, overall exit status.
- `scenario-types.ts` — typed scenario contract.
- `scenario-loader.ts` — loads and filters scenarios.
- `environment.ts` — temp directory and project-name provisioning.
- `command-runner.ts` — command execution, timeout, stdout/stderr capture.
- `assertions/` — reusable deterministic checks.
- `artifacts.ts` — logs/snapshots/compose outputs persistence.
- `reporter.ts` — concise terminal summary + JSON summary output.
- `scenarios/*.ts` — scenario definitions.

### Scenario contract (recommended)
Each scenario should declare:
- `id`, `title`, `tags`,
- `preconditions`,
- `steps`,
- `expected` assertions,
- `cleanupPolicy` (`always`, `on-success`, `never`),
- `timeouts`.

Keep scenario definitions declarative and short; put complex behavior in reusable step helpers.

## 4) Isolation model (must-have)

Every scenario run gets:
- isolated roots:
  - `.tmp/install-e2e/<run-id>/<scenario-id>/DATA`
  - `.tmp/install-e2e/<run-id>/<scenario-id>/STATE`
  - `.tmp/install-e2e/<run-id>/<scenario-id>/CONFIG`
  - `.tmp/install-e2e/<run-id>/<scenario-id>/workspace`
- unique compose project name: `openpalm_test_<scenario>_<shortid>`.
- unique host ports from a lock-backed allocator.

Rules:
- no directory reuse across scenarios,
- no shared mutable state between workers,
- cleanup targets only the scenario’s compose project and temp root.

## 5) Pass/fail contract and assertion layers

### Layer A — command contract
- command exits as expected,
- expected error code/message present for negative scenarios,
- no silent partial success.

### Layer B — generated artifact contract
Validate generated outputs before bringing up services:
- compose includes required core services,
- channel services are on `channel_net` and only routed through gateway,
- internal services are on `assistant_net` only,
- scoped `.env` files contain only referenced secrets,
- generated caddy config is syntactically valid.

### Layer C — runtime contract
After startup:
- `docker compose ps` status/health checks pass for required services,
- Admin endpoint becomes reachable within bounded timeout,
- minimal setup flow check succeeds (bootstrap route + one basic setup action).

## 6) Scenario matrix (minimum recommended)

### A. Happy-path smoke
- Fresh state, default config, no existing runtime data.
- Expected: full install/setup completes and Admin UI is usable.

### B. Common first-run failures
- Missing/invalid entries in `secrets.env`.
- Docker daemon unavailable.
- Required host port conflict.
- DATA/STATE permission errors.
- Expected: clear actionable errors and safe failure behavior.

### C. Config/generation edge cases
- Malformed channel/service config snippets.
- Unknown service names vs allowlist enforcement.
- Secret references not present in `secrets.env`.
- Expected: fail early with precise field/resource context.

### D. Recovery and idempotence
- Re-run setup on existing installation.
- Interrupted apply/start then rerun.
- Older state layout migration scenario (if supported).
- Expected: clean recovery path and stable post-recovery health.

### E. Runtime/dependency edge cases
- Slow service readiness.
- transient pull/network issues (where reproducible locally).
- Channel enabled with bad dependency config.
- Expected: bounded retry behavior and actionable diagnostics.

## 7) Artifacts and observability standards

Store artifacts in `.artifacts/install-e2e/<run-id>/<scenario-id>/`.

Required files:
- `events.log` (timestamped runner events),
- `commands.log` (all command invocations + exits),
- `stdout.log` / `stderr.log` per step,
- generated compose/caddy/env snapshots,
- `docker-compose-ps.txt`,
- `docker-compose-logs.txt`,
- `summary.json` (assertion results, durations, failure reason).

Retention:
- keep all artifacts on failure,
- configurable cleanup on success,
- optional `--keep-all` for debugging.

## 8) Step-by-step implementation plan

### Step 0 — Confirm scope and acceptance criteria
- Define v1 guarantees and non-goals.
- Align on smoke suite ownership.
- Open tracking issues for each major workstream.

**Exit criteria:** documented v1 acceptance criteria and issue breakdown approved.

### Step 1 — Build harness skeleton
- Implement runner, scenario loader, and report output.
- Add scripts:
  - `bun run test:install:smoke`
  - `bun run test:install:all`
  - `bun run test:install:scenario <id>`
- Add CLI flags:
  - `--scenario`, `--tags`, `--parallel`, `--dry-run`, `--keep-on-fail`.

**Exit criteria:** dry-run prints resolved scenario plan and exits successfully.

### Step 2 — Implement environment provisioning
- Create temp roots and scenario-scoped directories.
- Generate unique compose project and port allocations.
- Add teardown that cannot cross scenario boundaries.

**Exit criteria:** two concurrent scenarios do not conflict in paths, ports, or compose resources.

### Step 3 — Implement command execution and timeout control
- Centralize command execution with strict timeout support.
- Capture stdout/stderr and command metadata.
- Normalize failure codes (`timeout`, `precondition_failed`, `assertion_failed`, etc.).

**Exit criteria:** failures point to exact step, command, and log file.

### Step 4 — Implement artifacts pipeline
- Persist all required logs/snapshots.
- Ensure failure paths also capture compose logs and final status.
- Emit machine-readable summary JSON.

**Exit criteria:** any failed scenario yields complete troubleshooting bundle.

### Step 5 — Implement reusable assertions
- Build compose/network/env assertion helpers.
- Build health pollers with bounded backoff.
- Build Admin reachability/setup-flow check helper.

**Exit criteria:** helpers are reusable across multiple scenarios without custom glue.

### Step 6 — Ship initial smoke suite
- Add `happy-path` scenario.
- Add at least one expected-failure scenario (missing secret).
- Tag as `smoke` and enforce deterministic runtime limits.

**Exit criteria:** smoke suite is stable on clean developer machines.

### Step 7 — Expand to high-value failure matrix
- Add docker unavailable, port conflict, permission failure scenarios.
- Add malformed config and interrupted-run recovery scenarios.
- Attach remediation hints to known failure signatures.

**Exit criteria:** common install issues are reproducible and diagnosable via suite output.

### Step 8 — Add safe parallelism (optional)
- Introduce worker-pool execution behind `--parallel`.
- Limit heavy scenarios to avoid host saturation.
- Validate parity between sequential and parallel outcomes.

**Exit criteria:** parallel mode is deterministic and not flakier than sequential mode.

### Step 9 — Integrate into CI and release flow
- Add Docker-capable job for relevant PR paths.
- Run smoke on PR; run full matrix nightly and pre-release.
- Upload artifacts on all failures.

**Exit criteria:** CI failure includes downloadable scenario artifacts and summary.

### Step 10 — Operationalize regression loop
- Policy: every real install/setup bug adds a scenario.
- Track flake separately from product bugs.
- Review suite runtime and signal quality monthly.

**Exit criteria:** suite remains actionable, trusted, and fast enough for routine use.

## 9) Suggested initial timeline (first 2 weeks)

- Days 1-2: Steps 0-1.
- Days 3-4: Steps 2-4.
- Days 5-6: Step 5.
- Days 7-8: Step 6.
- Days 9-10: Step 7 (first subset).

## 10) Definition of done (v1)

- `test:install:smoke` validates real install/setup in isolated temp environments.
- At least 1 success scenario + 2 failure scenarios are automated.
- Every failure produces sufficient artifacts for troubleshooting without immediate rerun.
- CI runs smoke on relevant PR changes in Docker-capable runners.
