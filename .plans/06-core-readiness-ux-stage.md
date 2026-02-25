# Implementation Plan: Core Readiness UX Stage (P2)

## Goal

Add a deterministic "Core Readiness" stage before setup success so users can see progress, per-service health, and actionable recovery when startup fails.

This plan assumes P0/P1 runtime-path simplification is in progress or completed, and keeps one authoritative completion path.

## Current Baseline (File:Line References)

- Fire-and-forget startup is still invoked from the wizard: `packages/ui/src/lib/components/SetupWizard.svelte:149`.
- `setup.complete` currently does apply + compose up + complete with no convergence gate: `packages/ui/src/routes/command/+server.ts:348`.
- Parallel completion route duplicates startup list/logic: `packages/ui/src/routes/setup/complete/+server.ts:15`.
- Core service source of truth exists in lib: `packages/lib/src/admin/compose-runner.ts:4`.
- Existing one-shot health probe endpoint is available: `packages/ui/src/routes/setup/health-check/+server.ts:13`.
- Existing complete-step UI already polls health but is decoupled from real completion flow: `packages/ui/src/lib/components/CompleteStep.svelte:16`.
- `ComposeErrorCode` exists for structured backend failures: `packages/lib/src/types.ts:18`.
- Current setup-flow test coverage is mostly string matching and needs behavioral depth: `packages/ui/src/routes/command/command-setup-flow.test.ts:1`.

## UX States and Transitions

Implement a dedicated stage in the final wizard step with explicit backend-driven states.

### State machine

1. `idle` -> user clicks **Finish Setup**.
2. `applying_config` -> stack render/validate/write starts.
3. `starting_core_services` -> compose up for canonical core service set.
4. `verifying_health` -> bounded convergence checks (compose ps + HTTP probes).
5. `ready` -> success screen with per-service "ready" state.
6. `failed` -> show failing services, reason, log snippets, retry action.

### UX requirements by state

- `applying_config`: spinner + text "Applying configuration"; disable navigation buttons.
- `starting_core_services`: per-service checklist/chips with pending/starting/running.
- `verifying_health`: "Verifying health (can take 1-3 minutes)" and live status updates.
- `failed`: concise failure summary, expandable diagnostics, "Retry failed services" and "Copy diagnostics".
- `ready`: success confirmation + continue button.

### UI implementation touchpoints

- Update orchestration in `packages/ui/src/lib/components/SetupWizard.svelte:184`.
- Replace/expand final UI in `packages/ui/src/lib/components/CompleteStep.svelte:11`.
- Keep step indicator logic aligned with current step order in `packages/ui/src/lib/components/SetupWizard.svelte:21`.

## Data Model

Add shared typed contracts in lib and use them from UI + API handlers.

### Proposed types

Create in `packages/lib/src/types.ts` (or a new setup-readiness types module imported from lib):

- `SetupReadinessPhase = 'idle' | 'applying_config' | 'starting_core_services' | 'verifying_health' | 'ready' | 'failed'`
- `SetupServiceStatus = { name: string; desired: 'running'; status: 'pending' | 'starting' | 'running' | 'healthy' | 'unhealthy' | 'failed'; health?: string | null; lastUpdate: string; detail?: string }`
- `SetupReadinessSnapshot = { phase: SetupReadinessPhase; startedAt: string; updatedAt: string; completedAt?: string; services: SetupServiceStatus[]; failedServices: string[]; diagnostics?: SetupFailureDiagnostics; retryable: boolean }`
- `SetupFailureDiagnostics = { code: string; message: string; failedServices: Array<{ name: string; status: string; health?: string | null }>; logTails: Record<string, string>; suggestedCommands: string[] }`
- `SetupCompleteResponse = { ok: true; state: 'ready'; snapshot: SetupReadinessSnapshot } | { ok: false; state: 'failed'; snapshot: SetupReadinessSnapshot }`

### Persistence scope

- Keep readiness run state ephemeral in memory (per-process), keyed to current setup session; do not write to `setup-state.json`.
- Keep `setup-state.json` authoritative only for `completed` transition via `SetupManager` (`packages/lib/src/admin/setup-manager.ts`).

## Backend API Needs

Keep one orchestration path and expose status in a typed way.

### API contract additions

1. `POST /command` `type: 'setup.complete'`
   - Runs full reconciliation path.
   - Returns typed `SetupCompleteResponse` including phase/service snapshot.
   - Sets `setup.completed=true` only when phase reaches `ready`.

2. `GET /setup/core-readiness`
   - Returns latest `SetupReadinessSnapshot` for UI polling every 1s.
   - Returns `404` when no active or recent run exists.

3. `POST /setup/core-readiness/retry`
   - Re-runs same reconciliation function against failed/all core services (idempotent).
   - Returns initial snapshot (`phase='starting_core_services'`).

4. Optional (preferred if low effort): `GET /setup/core-readiness/stream` (SSE)
   - Pushes phase + service updates for smoother UX; fallback remains polling endpoint.

### Internal backend requirements

- Add `ensureCoreServicesReady(...)` in lib compose/admin layer (`packages/lib/src/admin/compose-runner.ts`).
- Use canonical `CoreServices` list from `packages/lib/src/admin/compose-runner.ts:4` to avoid list drift.
- Reuse compose classification semantics from `packages/lib/src/types.ts:18` for failure code mapping.
- Collapse duplicate completion orchestration by delegating both endpoints to one shared function:
  - `packages/ui/src/routes/command/+server.ts:348`
  - `packages/ui/src/routes/setup/complete/+server.ts:17`

## Failure and Retry Interactions

### Failure behaviors

- If apply fails: phase -> `failed`, code -> `invalid_compose` or validation code, no completion flag set.
- If compose up fails: phase -> `failed`, include stderr summary + service-level failure.
- If health convergence times out: phase -> `failed`, include failing services + log tails + commands.
- Always surface Docker-originated stderr/log context (lightly structured, not masked).

### Retry behaviors

- Retry button is enabled only when `snapshot.retryable=true`.
- Retry calls `POST /setup/core-readiness/retry` and resets phase to `starting_core_services`.
- Retry is safe to click repeatedly (idempotent compose up + bounded convergence).
- UI preserves previous diagnostics until new run emits first update.

### Suggested diagnostics payload content

- Failed service names and last known compose state.
- Tail logs per failed service (for example, 50-100 lines).
- Copy-ready commands:
  - `openpalm status`
  - `openpalm logs <service>`
  - `openpalm service restart <service>`

## Concrete Implementation Steps

### 1) Backend

1. Introduce shared readiness types in lib and export for UI consumption (`packages/lib/src/types.ts`).
2. Add reconciliation primitive in lib compose layer (`packages/lib/src/admin/compose-runner.ts`).
3. Create shared setup-completion orchestrator module in UI server layer (new helper imported by both routes).
4. Update `setup.complete` command handler to use orchestrator and typed response (`packages/ui/src/routes/command/+server.ts:348`).
5. Update `/setup/complete` route to call same orchestrator (`packages/ui/src/routes/setup/complete/+server.ts:17`).
6. Add `GET /setup/core-readiness` and `POST /setup/core-readiness/retry` route handlers under `packages/ui/src/routes/setup/`.
7. Remove/deprecate fire-and-forget `setup.start_core` path (`packages/ui/src/routes/command/+server.ts:205`) once no callers remain.

### 2) UI

1. Refactor final step to consume readiness snapshot (poll or SSE) in `packages/ui/src/lib/components/CompleteStep.svelte`.
2. Update `finishSetup()` flow in `packages/ui/src/lib/components/SetupWizard.svelte:184` to:
   - start completion,
   - subscribe/poll readiness,
   - render phase transitions,
   - gate success navigation on `phase='ready'`.
3. Add failed-state UI controls: Retry, Copy diagnostics, Expand logs.
4. Remove background startup trigger from providers step (`packages/ui/src/lib/components/SetupWizard.svelte:149`).

### 3) Tests

1. Replace string-presence checks with behavior tests in `packages/ui/src/routes/command/command-setup-flow.test.ts`.
2. Add API tests for readiness snapshot + retry endpoints in `packages/ui/test/api/03-setup-api.test.ts`.
3. Extend command API tests for typed `setup.complete` outcomes in `packages/ui/test/api/08-command-api.test.ts`.
4. Extend component tests for phase rendering, failed-state controls, and retry UX in `packages/ui/src/lib/components/complete-step.test.ts`.
5. Extend Docker install E2E to assert all core services healthy/running after completion in `test/install-e2e/happy-path.docker.ts:379`.
6. Add release-gate assertion/job update to enforce the health check in `.github/workflows/release.yml:161`.

### 4) Docs

1. Update user expectation language in `README.md:46` to reflect bootstrap-first then verified core readiness.
2. Update install option docs in `docs/cli.md:44` and setup completion semantics in `docs/cli.md:57`.
3. Add troubleshooting guidance for readiness failure and retry commands in `docs/troubleshooting.md`.
4. Document readiness API/status payloads in `dev/docs/api-reference.md`.

## Accessibility Checks

- Add `aria-live="polite"` for phase/status text updates in final step.
- Ensure status chips and failure badges are not color-only; include text labels/icons.
- Ensure keyboard access and focus order for Retry/Copy diagnostics/Continue buttons.
- Move focus to the error summary when phase becomes `failed`.
- Verify contrast for status colors against current theme tokens.
- Add/adjust component tests for accessibility attributes and keyboard operation.

## Mobile Responsiveness Checks

- Verify final step layout at 320px, 375px, 768px widths.
- Ensure service status list wraps without horizontal scroll.
- Keep diagnostics panel collapsible with max-height + internal scroll.
- Ensure primary actions remain reachable above fold on small screens.
- Validate touch target sizing (>= 44px recommended) for action buttons.
- Add UI test coverage (or visual snapshot checks) for mobile breakpoints.

## Acceptance Criteria

1. Final setup does not report success until readiness phase reaches `ready` and all core services meet criteria.
2. `setup.completed` is written only after readiness success (never on failed/timeout runs).
3. UI shows explicit phases: applying config, starting services, verifying health, success/failure.
4. UI exposes per-service real-time status and failed-service diagnostics.
5. Failure state includes retry action that can recover transient failures without page reload.
6. Retry is idempotent and safe across repeated clicks.
7. API returns typed readiness payloads (phase, services, diagnostics, retryable) with stable contract.
8. Accessibility checks (live regions, keyboard flow, contrast) pass for final stage UI.
9. Mobile checks pass at defined breakpoints with no blocking overflow or unreachable actions.
10. Automated tests cover happy path, timeout/failure path, and retry-success path.

## Out of Scope (for this P2 plan)

- Full preflight typed error taxonomy overhaul (separate P2 recommendation).
- Wrapper `--port` pass-through implementation (separate P2 recommendation).
- Installer idempotency metadata redesign (P4).
