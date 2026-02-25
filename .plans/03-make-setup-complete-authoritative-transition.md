# Implementation Plan: Make `setup.complete` the Only Authoritative Transition (P1)

## Objective

Make setup completion authoritative and reliable: `completed=true` is written only after stack apply succeeds and core runtime converges to healthy/running.

## Current State and Duplication Points

1. `setup.complete` in the command endpoint marks setup complete after `compose up` success, without health convergence.
   - `packages/ui/src/routes/command/+server.ts:348`
   - `packages/ui/src/routes/command/+server.ts:359`
   - `packages/ui/src/routes/command/+server.ts:362`
2. A parallel `/setup/complete` route duplicates finalization logic and keeps its own core service list.
   - `packages/ui/src/routes/setup/complete/+server.ts:15`
   - `packages/ui/src/routes/setup/complete/+server.ts:38`
   - `packages/ui/src/routes/setup/complete/+server.ts:42`
3. Core startup is fragmented across non-terminal setup commands.
   - Fire-and-forget startup command: `packages/ui/src/routes/command/+server.ts:205`
   - Scope mutation also starts services: `packages/ui/src/routes/command/+server.ts:236`
   - Profile mutation can trigger service up: `packages/ui/src/routes/command/+server.ts:267`
   - Parallel access-scope route does startup too: `packages/ui/src/routes/setup/access-scope/+server.ts:25`
4. Service lists are duplicated and can drift.
   - Canonical shared list includes admin: `packages/lib/src/admin/compose-runner.ts:4`
   - Setup-specific list in command route: `packages/ui/src/routes/command/+server.ts:49`
   - Setup route local list: `packages/ui/src/routes/setup/complete/+server.ts:15`
5. Wizard still triggers background startup before finalization.
   - `packages/ui/src/lib/components/SetupWizard.svelte:149`
6. Existing health endpoint is point-in-time only (not convergence/authoritative).
   - `packages/ui/src/routes/setup/health-check/+server.ts:13`

## Target Contract

`setup.complete` becomes the single authoritative transition:

1. Apply stack artifacts (`applyStack`).
2. Start target core services once (`compose up -d ...`).
3. Run bounded readiness convergence (`ensureCoreServicesReady`).
4. Only then call `setupManager.completeSetup()`.

If readiness fails or times out, setup remains incomplete and returns structured diagnostics.

## State-Transition Invariants (Must Hold)

1. `completed=true` can only be written from the setup completion path after readiness success.
   - Guard point currently at `packages/lib/src/admin/setup-manager.ts:151`.
2. Any failure in `applyStack`, compose startup, or readiness check must keep `completed=false`.
3. Non-terminal setup commands (`setup.profile`, `setup.service_instances`, `setup.access_scope`, `setup.channels`, `setup.step`) mutate state/config only; no runtime orchestration side effects.
4. Core service set for startup/readiness is sourced from one shared constant, with explicit derivation for any sublists.
5. Failure payloads are typed and stable for UI/CLI handling.

## Exact Refactor Steps

### A) Introduce shared completion orchestrator in lib/admin

1. Add a new orchestrator module in `packages/lib/src/admin/` (recommended: `setup-completion.ts`) with a single exported API:
   - `finalizeSetup({ stackManager, setupManager, timeoutMs, pollIntervalMs, requireHealthy, runner? })`
2. Inside orchestrator, execute strict order:
   - `applyStack(...)`
   - `composeAction('up', coreServices)` via injectable runner
   - `ensureCoreServicesReady(...)` polling `compose ps` + HTTP probes
   - `syncAutomations(...)`
   - `setupManager.completeSetup()`
3. Move/define canonical setup core service list in lib/admin and import from all setup endpoints.
   - Start from `packages/lib/src/admin/compose-runner.ts:4`
   - Derive an explicit setup set (likely `CoreServices` minus optional exclusions) in one place.

### B) Implement readiness convergence primitive

1. Extend `packages/lib/src/admin/compose-runner.ts` with a readiness API (or colocated module) that:
   - polls `compose ps --format json` (existing parser at `packages/lib/src/admin/compose-runner.ts:153`)
   - validates service status rules:
     - healthy if health check exists
     - running if no health check
   - probes HTTP health for gateway/assistant/openmemory/admin
2. Add bounded timeout behavior and deterministic poll cadence.
3. Collect diagnostics on failure:
   - failed services
   - last status/health snapshots
   - compose stderr from latest failed operation
   - tail logs per failed service (reuse `logs()` capability at `packages/lib/src/admin/compose-runner.ts:55`)

### C) Make command endpoint authoritative and side-effect minimal

1. Replace inline `setup.complete` implementation in `packages/ui/src/routes/command/+server.ts:348` with call to shared orchestrator.
2. Keep POSTGRES password bootstrap logic, but run it before orchestrator invocation.
   - Existing logic: `packages/ui/src/routes/command/+server.ts:349`
3. Remove `setup.start_core` handler entirely.
   - `packages/ui/src/routes/command/+server.ts:205`
4. Remove runtime side effects from:
   - `setup.access_scope` branch (`packages/ui/src/routes/command/+server.ts:236`)
   - `setup.profile` branch (`packages/ui/src/routes/command/+server.ts:254`)

### D) Collapse duplicate setup routes onto same orchestrator

1. Convert `packages/ui/src/routes/setup/complete/+server.ts` to delegate to the same shared orchestrator used by `/command`.
2. Remove local `CoreStartupServices` constant and route-specific compose-up sequencing.
   - `packages/ui/src/routes/setup/complete/+server.ts:15`
3. Remove startup side effects from `packages/ui/src/routes/setup/access-scope/+server.ts:25`.

### E) Update wizard flow to remove background startup

1. Delete fire-and-forget call to `setup.start_core` in wizard next-step logic.
   - `packages/ui/src/lib/components/SetupWizard.svelte:149`
2. Keep all startup/health wait within `finishSetup()` via `setup.complete`.
   - `packages/ui/src/lib/components/SetupWizard.svelte:219`

## Failure Payload Behavior

Define a stable failure response for completion endpoints (both `/command` and `/setup/complete`) when readiness fails:

```json
{
  "ok": false,
  "code": "setup_not_ready",
  "error": "core services did not converge before timeout",
  "details": {
    "failedServices": ["openmemory", "gateway"],
    "statuses": [
      { "name": "openmemory", "status": "running", "health": "unhealthy" },
      { "name": "gateway", "status": "exited", "health": null }
    ],
    "logs": {
      "openmemory": "<tail>",
      "gateway": "<tail>"
    },
    "hints": [
      "openpalm service logs openmemory --tail 200",
      "openpalm service restart gateway",
      "openpalm service status"
    ],
    "timeoutMs": 180000
  }
}
```

Behavior rules:

1. `setupManager.completeSetup()` is not called for `setup_not_ready`.
2. Compose/validation failures keep existing direct Docker stderr visibility, wrapped with typed `code` where possible.
3. HTTP status:
   - `400` for invalid setup input/secret validation
   - `503` for `setup_not_ready` convergence failures/timeouts
   - `500` only for unexpected internal exceptions

## Compatibility and Migration Notes (Routes/Clients)

1. `setup.start_core` command deprecation:
   - Short-term: keep handler as explicit no-op returning deprecation payload (`ok: true`, `status: "deprecated"`, `next: "use setup.complete"`) for one release.
   - Next release: remove command and return `unknown_command`.
2. `/setup/complete` route:
   - Preserve endpoint, but make it a thin shim to shared orchestrator to avoid breaking existing scripted clients.
3. `setup.access_scope` and `setup.profile` behavior change:
   - Clients must not expect immediate container restarts from these commands.
   - Runtime reconciliation is now exclusively at `setup.complete` (and explicit retry endpoint if added).
4. Response schema change for completion failures:
   - Document `code=setup_not_ready` and `details` contract so UI and CLI can render actionable diagnostics.

## Code, Docs, Tests, and Scripts Update Plan

### Code

1. Add shared setup finalization/readiness implementation in `packages/lib/src/admin/*`.
2. Refactor `packages/ui/src/routes/command/+server.ts` completion and remove non-terminal startup side effects.
3. Refactor `packages/ui/src/routes/setup/complete/+server.ts` and `packages/ui/src/routes/setup/access-scope/+server.ts` to eliminate duplicated orchestration.

### Docs

1. Update setup flow docs in `docs/cli.md`:
   - Remove `setup.start_core` as active startup step (`docs/cli.md:151`).
   - Clarify `setup.complete` as health-gated authoritative transition.
2. Update API docs in `dev/docs/api-reference.md` with:
   - deprecation note for `setup.start_core`
   - new `setup_not_ready` payload shape
3. Update reliability report status from PARTIAL to DONE after merge.
   - `dev/docs/install-setup-simplification-reliability-report-consolidated.md:23`

### Tests

1. Replace string-match test in `packages/ui/src/routes/command/command-setup-flow.test.ts:1` with behavioral tests using DI/mock compose runner.
2. Add unit tests for readiness convergence:
   - success with delayed healthy transitions
   - timeout with failed services/log diagnostics
   - no state completion on any failed branch
3. Add route tests for `/command` and `/setup/complete` parity (shared orchestrator).
4. Extend install E2E assertions to validate post-complete runtime status semantics beyond `completed=true`.
   - Current baseline test: `test/install-e2e/happy-path.docker.ts:379`

### Scripts/CI

1. Update release gate job to assert convergence diagnostics path (at least one failing fixture + one passing fixture).
   - `/.github/workflows/release.yml:161`
2. Add/adjust test scripts in package scripts to run new setup readiness test suite in CI.
3. Keep wrapper scripts (`install.sh`, `install.ps1`) unchanged for this P1 item, except docs/comments if they mention legacy startup sequencing.

## Rollout Sequence

1. Land lib/shared orchestrator + readiness primitive + unit tests.
2. Switch `/command` `setup.complete` to orchestrator and enforce invariants.
3. Switch `/setup/complete` to orchestrator shim and remove duplicated service list.
4. Remove background startup from wizard and non-terminal side effects.
5. Update docs and CI gates.
6. In following release, remove compatibility no-op for `setup.start_core`.

## Done Criteria

1. Both completion entry points use one shared backend function.
2. `completed=true` is impossible unless readiness succeeds.
3. `setup_not_ready` failures are structured and actionable.
4. Non-terminal setup commands are mutation-only.
5. Tests cover success, timeout, diagnostics payload, and state invariants.
6. Docs reflect authoritative completion and compatibility behavior.
