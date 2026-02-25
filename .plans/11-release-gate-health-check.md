# Implementation Plan: Release Gate Health Check (P3)

## Objective

Add a release-blocking CI gate that verifies post-setup core runtime convergence: all core containers are running, healthchecked services are healthy, and setup completion is not treated as success until runtime is usable.

Primary recommendation source: `dev/docs/install-setup-simplification-reliability-report-consolidated.md:364`.

## Baseline (What Exists Today)

- A release gate job already runs setup wizard E2E for platform/admin releases: `.github/workflows/release.yml:161`.
- That E2E path currently uses busybox stubs for non-admin services, so it validates flow but not real service health: `test/install-e2e/happy-path.docker.ts:177` and `test/install-e2e/happy-path.docker.ts:216`.
- The command completes on `completed: true` but the test does not assert full-stack container health: `test/install-e2e/happy-path.docker.ts:379`.
- Install E2E tests are excluded from default `bun test`, so CI must explicitly invoke them: `bunfig.toml:7`.
- Canonical core service list for health assertions already exists in lib: `packages/lib/src/admin/compose-runner.ts:4`.

## Scope of This Plan

1. Add a new full-stack install/setup E2E test that uses real core images (not stubs) and asserts `compose ps` health/running status after `setup.complete`.
2. Wire that test into `release.yml` as a blocking job for platform/admin release paths.
3. Keep the existing stubbed wizard test as a faster functional guard (or merge both into one file with modes), but require full-stack health gate for release eligibility.

## CI Workflow Changes

### 1) Add a dedicated release gate job

Update `.github/workflows/release.yml`:

- Keep existing `setup-wizard-e2e` job at `.github/workflows/release.yml:161` for API/wizard flow integrity.
- Add `setup-core-health-e2e` job (new) with:
  - `if: inputs.component == 'platform' || inputs.component == 'admin'`
  - `runs-on: ubuntu-latest`
  - `timeout-minutes: 35` (higher than current 20 to account for first-time image pulls)
  - `env: OPENPALM_RUN_DOCKER_STACK_TESTS=1`
  - run command: `bun test ./test/install-e2e/core-health.docker.ts`
  - failure artifacts upload: compose logs, `docker compose ps --format json`, and temp state directory.
- Add new job to release `needs` list at `.github/workflows/release.yml:186` so release tagging is blocked on this gate.

### 2) Keep logs diagnosable on failure

- Mirror existing artifact pattern from `.github/workflows/release.yml:173` and add a second artifact bundle for the new full-stack test path.
- Require failure output to include failed service names and last known state/health from `compose ps` for quick triage.

## Test Changes

### 1) Add full-stack setup E2E

Create `test/install-e2e/core-health.docker.ts` modeled after `test/install-e2e/happy-path.docker.ts:105`, but with these differences:

- Do not replace core services with busybox stubs (remove stub overlay behavior currently seen at `test/install-e2e/happy-path.docker.ts:177`).
- Use actual compose stack services matching core list from `packages/lib/src/admin/compose-runner.ts:4`.
- Drive the same setup sequence through `setup.complete`.
- After completion, assert:
  - `docker compose ps --format json` returns entries for all expected core services.
  - service states are `running`.
  - if a service exposes health status, health is `healthy`.
  - HTTP health endpoints return OK for `admin`, `gateway`, `assistant`, `openmemory` (aligned with report contract at `dev/docs/install-setup-simplification-reliability-report-consolidated.md:222`).

### 2) Shared assertion helper

Add helper module (proposed: `test/install-e2e/helpers/core-health.ts`) to:

- parse `compose ps --format json` output consistently,
- normalize state/health values,
- compute missing/unhealthy services,
- emit deterministic failure diagnostics consumed by CI logs and artifacts.

### 3) Script entrypoint

Add package script in `package.json:20`:

- `test:install:core-health`: `OPENPALM_RUN_DOCKER_STACK_TESTS=1 bun test ./test/install-e2e/core-health.docker.ts`

Then use this script from workflow for readability and local parity.

## Environment Constraints and Runtime/Cost Tradeoffs

### Practical constraints

- GitHub hosted runners are ephemeral; image layers may not be cached between runs, making first-run pulls expensive.
- Full-stack boot requires more services than current stub test (8 core services), increasing startup and flake surface.
- Default test discovery excludes install E2E (`bunfig.toml:7`), so explicit invocation must remain.
- Docker availability alone is insufficient; the test must create isolated temp project dirs and `.env` like existing docker tests (`test/install-e2e/happy-path.docker.ts:109` and `test/install-e2e/happy-path.docker.ts:156`).

### Runtime/cost tradeoffs

- **Option chosen:** keep two tiers
  - fast stubbed wizard flow gate (functional/API coverage),
  - slower full-stack health gate (runtime convergence coverage).
- This avoids overloading every PR run while still blocking releases on real runtime readiness.
- Estimated added release runtime: +8 to +20 minutes depending on image pull/cache state.
- Cost control: scope full-stack gate to `platform` and `admin` release inputs (same scope as existing setup gate), not all component releases.

## Fallback Strategy

When `setup-core-health-e2e` fails, classify before rerun:

1. **Deterministic product failure** (service unhealthy/crash-loop, missing required container): block release; fix code/config and rerun workflow.
2. **Likely infra/transient failure** (registry pull timeout, GitHub runner network instability): allow one workflow rerun.
3. **Second transient failure:** do not bypass gate automatically; run a maintainer-triggered diagnostic rerun with extended timeout and attached logs, then decide fix vs postpone.

Guardrail: no silent downgrade to stub-only success for release tagging.

## Acceptance Gate Definition

Gate name: `setup-core-health-e2e` (release-blocking).

Pass criteria:

1. Setup wizard flow reaches `setup.complete` successfully.
2. `compose ps --format json` includes all core services:
   - `caddy`, `admin`, `assistant`, `gateway`, `openmemory`, `openmemory-ui`, `postgres`, `qdrant`.
3. Every listed core service is `running`.
4. Services with healthchecks report `healthy` within timeout.
5. HTTP probes succeed for `admin`, `gateway`, `assistant`, `openmemory`.
6. Workflow job exits 0; release job remains blocked otherwise via `needs` linkage.

Failure contract:

- Emit failed/missing service list, latest `compose ps` snapshot, and tail logs for failing services.
- Upload artifacts for offline debugging.
- Do not create or push release tag when this gate fails.

## File:Line Reference Map

- Recommendation and gap statement: `dev/docs/install-setup-simplification-reliability-report-consolidated.md:364`.
- Existing release setup E2E gate: `.github/workflows/release.yml:161`.
- Release gating dependency wiring: `.github/workflows/release.yml:186`.
- Current stub-based behavior that must be complemented: `test/install-e2e/happy-path.docker.ts:177`.
- Current completion assertion without full health verification: `test/install-e2e/happy-path.docker.ts:379`.
- Canonical core services source: `packages/lib/src/admin/compose-runner.ts:4`.
- Install E2E default exclusion requiring explicit workflow call: `bunfig.toml:7`.

## Rollout Sequence

1. Add helper + `core-health.docker.ts` test and local script.
2. Run locally with Docker and collect baseline timing/flakiness notes.
3. Add `setup-core-health-e2e` workflow job + artifacts + `needs` linkage.
4. Validate against one platform dry-run release workflow.
5. Mark recommendation status from PARTIAL to COMPLETE in follow-up docs update once gate is green in release workflow.
