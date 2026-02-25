# Implementation Plan: Self-Healing Retry Affordances (P3)

## Goal

Add explicit, user-initiated retry affordances for setup core-start failures, with full diagnostics visibility, idempotent behavior, and no silent auto-retry loops.

This plan implements recommendation **"Self-healing retry affordances" (P3)** from `dev/docs/install-setup-simplification-reliability-report-consolidated.md:350`.

## Guardrails (Must Hold)

1. Retry is **user-initiated only** (button/API call), never background/silent.
2. Retry reuses the same core reconciliation path as setup completion (no parallel orchestration system).
3. Docker/compose stderr remains visible to users (expandable diagnostics).
4. Retry is idempotent and safe to click repeatedly.
5. Setup completion remains authoritative; no hidden state transitions outside `setup.complete` flow.

## Current Baseline (File:Line)

- Fire-and-forget startup still exists and can hide failures: `packages/ui/src/routes/command/+server.ts:205`.
- Wizard still calls background startup without checking result: `packages/ui/src/lib/components/SetupWizard.svelte:149`.
- `setup.complete` currently does apply + `compose up` + complete, with no typed diagnostics payload: `packages/ui/src/routes/command/+server.ts:348`.
- Parallel `/setup/complete` route duplicates completion/startup logic: `packages/ui/src/routes/setup/complete/+server.ts:15`.
- Existing readiness probe is one-shot and read-only: `packages/ui/src/routes/setup/health-check/+server.ts:13`.
- Complete step currently polls health and allows continue on timeout, but no backend retry contract: `packages/ui/src/lib/components/CompleteStep.svelte:16`.
- Canonical core service list already exists in lib: `packages/lib/src/admin/compose-runner.ts:4`.
- Structured logging exists and can carry retry telemetry fields: `packages/lib/src/shared/logger.ts:50`.

## UI/Backend Contract Changes

### 1) Extend `setup.complete` response contract with retry-safe diagnostics

Update command handler behavior at `packages/ui/src/routes/command/+server.ts:348` to return structured failure details when convergence fails (instead of plain thrown string).

Proposed response shape on failure:

```ts
{
  ok: false,
  code: 'setup_not_ready',
  error: 'Core services did not become ready before timeout',
  data: {
    runId: string,
    retryable: true,
    failedServices: Array<{ name: string; status: string; health?: string | null }>,
    logTails: Record<string, string>,
    composeStderr: string,
    suggestedCommands: string[]
  }
}
```

Notes:
- Keep `code` stable for UI branching.
- Keep Docker-originated stderr/logs intact; do not replace with generic "try again" text.
- `retryable` must be explicit; if non-retryable, still show diagnostics.

### 2) Add explicit retry command (user action only)

Add a new command type on `/command` (same route file):
- `type: 'setup.retry_core'`

Behavior:
- Allowed only during incomplete setup or authenticated session (same setup/auth boundary style as `setup.*`: `packages/ui/src/routes/command/+server.ts:108`).
- Calls the same shared reconciliation function used by `setup.complete` (from lib/admin layer), scoped to failed-or-core services.
- Returns the same structured result shape as `setup.complete` failure/success.
- Does **not** mutate setup completion unless convergence succeeds.

### 3) Keep one orchestration function in lib

In `packages/lib/src/admin/compose-runner.ts:4`, add/extend a shared function (for example `ensureCoreServicesReady`/`reconcileCoreRuntime`) and make both:
- `setup.complete`
- `setup.retry_core`

call that same function.

Idempotency requirements:
- `compose up -d` on already-running services is treated as success path.
- repeated retries do not append duplicate state markers or trigger alternate code paths.
- diagnostics are regenerated per attempt (new `runId`, fresh status/log tails).

## UI Changes (Retry + Diagnostics Visibility)

### 1) Final step failure UX in wizard

Update finalization UI path:
- `packages/ui/src/lib/components/SetupWizard.svelte:184`
- `packages/ui/src/lib/components/CompleteStep.svelte:65`

Add/adjust behavior:
- show a clear failure panel when `setup.complete` returns `code='setup_not_ready'`.
- render failing services + last status.
- keep raw compose stderr in expandable diagnostics.
- add `Retry failed core services` button wired to `setup.retry_core`.
- add `Copy diagnostics` action that copies: failed service table + compose stderr + per-service log tails + suggested commands.

### 2) No silent retries in UI state machine

Explicitly remove any automatic retry timer/backoff behavior in setup UI:
- keep polling/status display if needed, but retries only happen after button click.
- keep retry button disabled only while in-flight request is active, then re-enable.

## Telemetry Plan (Structured Logs, Not Hidden Recovery)

Use existing logger (`packages/ui/src/lib/server/init.ts:18`, `packages/lib/src/shared/logger.ts:50`) to emit structured events for observability and release tracking.

### Event set

1. `setup_complete_failed_not_ready`
   - fields: `runId`, `failedServices`, `retryable`, `durationMs`, `composeErrorCode?`
2. `setup_retry_requested`
   - fields: `runId`, `source` (`wizard`), `failedServicesRequested`
3. `setup_retry_result`
   - fields: `runId`, `ok`, `failedServices`, `durationMs`, `composeErrorCode?`
4. `setup_diagnostics_copied`
   - fields: `runId`, `failedServiceCount`

Telemetry constraints:
- no PII/secrets in logs (never log env values or full credentials).
- include service names/status and code paths only.
- no client-side analytics dependency; server-side structured logs are source of truth.

## Tests

### API/behavior tests

1. Replace brittle string tests with behavioral setup-flow assertions in `packages/ui/src/routes/command/command-setup-flow.test.ts:1`:
   - `setup.complete` returns structured `setup_not_ready` payload when mock runner fails convergence.
   - `setup.retry_core` exists and returns structured result.
   - completion flag remains false after failed retry.

2. Extend command API integration coverage in `packages/ui/test/api/08-command-api.test.ts:40`:
   - retry endpoint happy path.
   - retry endpoint repeated-call idempotency.
   - non-local unauthenticated request rejection behavior.

3. Extend setup API flow in `packages/ui/test/api/03-setup-api.test.ts:170`:
   - failed completion -> retry -> success scenario.
   - assert `state.completed` only flips on success.

### UI tests

4. Extend `packages/ui/src/lib/components/complete-step.test.ts:12`:
   - diagnostics panel visibility.
   - retry button in failed state.
   - copy diagnostics payload includes compose stderr/log snippets.
   - no automatic retry side effect in component lifecycle.

### E2E + release gate

5. Extend `test/install-e2e/happy-path.docker.ts:379` with retry-oriented scenario (inject one transient failure, require user-driven retry path).
6. Keep/extend release workflow gate in `.github/workflows/release.yml:161` so retry-affordance regressions fail CI.

## Docs Updates

1. Update setup command flow docs to include `setup.retry_core` and remove stale fire-and-forget semantics:
   - `docs/cli.md:147`
   - `docs/cli.md:151`
   - `docs/cli.md:155`

2. Document retry diagnostics contract for developers:
   - `dev/docs/api-reference.md:33` (add command contract section for `setup.complete`/`setup.retry_core` failure payloads).

3. Add troubleshooting runbook for "setup not ready" with copy-diagnostics usage and manual commands:
   - `docs/troubleshooting.md:15`.

4. After implementation, mark recommendation status in reliability report:
   - `dev/docs/install-setup-simplification-reliability-report-consolidated.md:30` from OPEN to COMPLETE.

## Explicit Non-Goals (Prevent Hidden Orchestration Complexity)

1. No background job queue for setup retries.
2. No silent/automatic retry loops (client or server).
3. No separate "recovery orchestrator" outside shared compose reconciliation path.
4. No heuristic suppression/masking of Docker errors.
5. No persistence of retry internals in `setup-state.json` beyond normal completion semantics.
6. No new long-lived daemon/service for setup progress tracking.

## Rollout Order

1. Land backend typed failure + `setup.retry_core` command using shared reconcile function.
2. Wire UI retry + diagnostics panel + copy action.
3. Add structured telemetry logs.
4. Expand API/UI/E2E tests.
5. Update docs and report status.

## Acceptance Criteria

1. When completion fails readiness, user sees failed services, compose stderr, and log tails in UI.
2. Retry occurs only when user clicks retry; no silent retry attempts happen.
3. Repeated retry clicks are idempotent and safe.
4. `setup.completed` remains false across failed attempts and becomes true only on successful convergence.
5. `setup.complete` and `setup.retry_core` share one reconciliation implementation.
6. Structured telemetry events are emitted for fail/request/result/copy-diagnostics.
7. Updated docs accurately describe retry behavior and diagnostics visibility.
