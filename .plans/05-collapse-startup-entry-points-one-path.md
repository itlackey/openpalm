# Implementation Plan: Collapse Startup Entry Points to One Path (P1)

## Goal

Collapse setup-time runtime startup into one orchestration path so that full core startup is executed only through a shared backend function, with `setup.complete` as the authoritative transition.

This plan implements recommendation **"Collapse startup entry points to one path" (P1)** from `dev/docs/install-setup-simplification-reliability-report-consolidated.md`.

## Target Architecture

### Runtime startup model

1. **Bootstrap startup (unchanged):** `openpalm install` starts only `caddy` + `admin` for wizard access.
2. **Core startup (converged):** one internal orchestration function is used for full core startup.
3. **Authoritative completion:** `setup.complete` is the only setup transition that can mark `completed=true`, and only after orchestration succeeds.
4. **Non-terminal setup commands are mutation-only:** `setup.profile`, `setup.service_instances`, `setup.channels`, `setup.access_scope`, and `setup.step` do not start/restart core services.

### Single orchestration function responsibility

Create a shared function in the lib/admin compose layer (proposed name: `reconcileCoreRuntime`) with the following responsibilities:

- Accept the canonical core service set (single source of truth).
- Execute compose startup for that set (`composeAction('up', services)` or runner equivalent).
- Validate convergence criteria (initially compose success; extendable to health gate without changing call sites).
- Return a structured result (`ok`, `code`, `failedServices`, `stderr/stdout`, optional diagnostics).
- Remain free of setup-state mutation; callers decide whether to call `setupManager.completeSetup()`.

## Entry Points to Converge and Exact Modifications

1. `setup.start_core` command branch in `packages/ui/src/routes/command/+server.ts:205`
   - Delete handler and detached IIFE startup logic (`composePull` + per-service `composeAction('up')` + `caddy` restart).
   - Command should no longer exist in command API surface.

2. Fire-and-forget caller in `packages/ui/src/lib/components/SetupWizard.svelte:149`
   - Remove background `api('/command', { type: 'setup.start_core' })` call.
   - Keep step progression unchanged except no hidden runtime startup side effect.

3. `setup.access_scope` side-effect startup in `packages/ui/src/routes/command/+server.ts:236`
   - Keep only access scope persistence (`stackManager.setAccessScope`, `setRuntimeBindScope`, setup state update).
   - Remove `composeAction('up', ...)` calls in both completed and incomplete branches.

4. Parallel REST endpoint side effects in `packages/ui/src/routes/setup/access-scope/+server.ts:25`
   - Same mutation-only behavior as command endpoint.
   - Remove `composeAction('up', 'caddy' | 'openmemory' | 'assistant')` calls.

5. Parallel complete endpoint in `packages/ui/src/routes/setup/complete/+server.ts:15`
   - Remove local `CoreStartupServices` constant and direct compose startup branch.
   - Delegate to the same shared orchestration function used by `/command` `setup.complete`.

6. `setup.complete` command startup path in `packages/ui/src/routes/command/+server.ts:348`
   - Replace direct use of local `SetupCoreServices` + `composeAction('up', ...)` with shared orchestration function call.
   - Keep `applyStack(...)` before orchestration.
   - Keep `setupManager.completeSetup()` only after shared orchestration returns success.

7. Canonical core service declaration in `packages/lib/src/admin/compose-runner.ts:4`
   - Use `CoreServices` as canonical runtime service source.
   - Remove duplicated setup-only service arrays from UI route files.

## Code, Docs, Tests, and Scripts Updates

### Code updates

- `packages/lib/src/admin/compose-runner.ts`
  - Add shared orchestration function + result type.
  - Export canonical startup service subset helper if needed (for excluding non-start targets in specific contexts).
- `packages/ui/src/routes/command/+server.ts`
  - Remove `setup.start_core` branch.
  - Remove startup side effects in `setup.access_scope`.
  - Route `setup.complete` through shared orchestrator.
  - Remove now-unused imports (`composePull`, possibly `log`, local service constants).
- `packages/ui/src/routes/setup/complete/+server.ts`
  - Replace duplicate startup logic with shared orchestrator call path.
- `packages/ui/src/routes/setup/access-scope/+server.ts`
  - Remove runtime startup side effects.
- `packages/ui/src/lib/components/SetupWizard.svelte`
  - Remove fire-and-forget `setup.start_core` invocation.

### Docs updates

- `docs/cli.md`
  - Update wizard/API setup step table to remove `setup.start_core` row and side-effect language on `setup.access_scope`.
  - Clarify that full core startup is performed via `setup.complete` shared orchestration path.
- `dev/docs/install-setup-simplification-reliability-report-consolidated.md`
  - Mark recommendation status for "Collapse startup entry points to one path" from OPEN -> COMPLETE after merge.

### Tests updates

- `packages/ui/test/api/08-command-api.test.ts`
  - Add assertion that `setup.complete` still succeeds through the shared path.
  - Add negative assertion that `setup.start_core` now returns unknown/unsupported command.
- `packages/ui/test/api/03-setup-api.test.ts`
  - Ensure `/setup/access-scope` remains mutation-only and does not require runtime side effects for success.
- `packages/ui/test/api/helpers.ts`
  - Keep `runMinimalSetup()` intact but ensure it does not rely on any removed startup side effects.
- `packages/ui/src/lib/components/setup-wizard-order.test.ts`
  - Update expectations to remove references to background startup behavior.
- `test/install-e2e/happy-path.docker.ts`
  - Remove comments/assertions that refer to legacy `SetupCoreServices`/background startup path.
  - Keep `setup.complete` as the only full startup trigger in flow assertions.

### Scripts / CI updates

- `.github/workflows/release.yml:161`
  - Keep `setup-wizard-e2e` gate, but update job/test assertions to validate that no deprecated setup command is required.
  - Add a lightweight smoke assertion (in test code) that converged flow does not call removed `setup.start_core`.

## Dependency Ordering

1. **Lib contract first**
   - Add shared orchestration function and exported types in `packages/lib`.
2. **Server convergence second**
   - Rewire both completion entry points (`/command` and `/setup/complete`) to shared orchestrator.
3. **Remove legacy startup entry points third**
   - Delete `setup.start_core` and remove `setup.access_scope` startup side effects in both endpoint styles.
4. **UI cleanup fourth**
   - Remove fire-and-forget call in wizard.
5. **Docs/test/CI alignment last**
   - Update docs tables and all tests to match converged behavior.

Rationale: this sequence avoids breaking callers while convergence logic is introduced, then safely removes old paths.

## Rollback Strategy

1. **Fast rollback (single PR revert):** revert the convergence PR if setup completion regressions appear in smoke tests.
2. **Partial rollback (server-only):** restore `setup.complete` direct compose startup in route handlers while keeping UI changes; do not reintroduce background startup unless required.
3. **Compatibility rollback guard (short-lived):** if needed during rollback window, temporarily accept `setup.start_core` as a no-op returning structured deprecation response (not background startup) to prevent older clients from hard-failing.
4. **Validation before/after rollback:** run `packages/ui` API tests, setup wizard Playwright tests, and `test/install-e2e/happy-path.docker.ts` to confirm setup completion and auth transitions.

## Line-Referenced File Map (Current Baseline)

- `packages/lib/src/admin/compose-runner.ts:4` - canonical `CoreServices` source to use for converged startup.
- `packages/ui/src/routes/command/+server.ts:49` - duplicate `SetupCoreServices` to remove.
- `packages/ui/src/routes/command/+server.ts:205` - `setup.start_core` entry point to delete.
- `packages/ui/src/routes/command/+server.ts:236` - `setup.access_scope` startup side effects to remove.
- `packages/ui/src/routes/command/+server.ts:348` - `setup.complete` to switch to shared orchestrator.
- `packages/ui/src/routes/setup/complete/+server.ts:15` - duplicate `CoreStartupServices` and parallel startup path to collapse.
- `packages/ui/src/routes/setup/access-scope/+server.ts:25` - parallel access-scope startup side effects to remove.
- `packages/ui/src/lib/components/SetupWizard.svelte:149` - fire-and-forget `setup.start_core` invocation to remove.
- `docs/cli.md:151` - setup step table row for `setup.start_core` to remove/update.
- `packages/ui/test/api/08-command-api.test.ts:40` - completion-path assertion to retain/expand.
- `packages/ui/test/api/03-setup-api.test.ts:171` - `/setup/complete` behavioral coverage to retain/expand.
- `packages/ui/test/api/helpers.ts:240` - minimal setup helper flow depending on `/setup/complete`.
- `packages/ui/src/lib/components/setup-wizard-order.test.ts:6` - wizard ordering check to update after removing background startup.
- `test/install-e2e/happy-path.docker.ts:379` - end-to-end `setup.complete` convergence assertion.
- `.github/workflows/release.yml:161` - release gate job executing setup wizard E2E.

## Completion Criteria

- No runtime startup logic remains outside bootstrap install and shared core orchestrator.
- `setup.start_core` is removed (or temporary no-op deprecation shim only during rollback window).
- `setup.access_scope` endpoints are mutation-only.
- Both completion endpoints use one backend orchestration function.
- Tests and docs reflect the single startup path.
