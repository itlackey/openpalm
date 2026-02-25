# Implementation Plan: Remove fire-and-forget `setup.start_core` (P1)

## Objective

Remove the detached/background startup path (`setup.start_core`) so setup has one authoritative startup boundary (`setup.complete`) with explicit success/failure semantics.

## Current callers/usages and related assumptions

### Direct runtime callers/usages

1. UI caller in wizard:
   - `packages/ui/src/lib/components/SetupWizard.svelte:149`
   - `packages/ui/src/lib/components/SetupWizard.svelte:152`
   - Assumption: core startup can begin in the middle of setup without blocking user progression.

2. Command handler implementation:
   - `packages/ui/src/routes/command/+server.ts:205`
   - `packages/ui/src/routes/command/+server.ts:234`
   - Assumption: returning `{ ok: true, status: 'starting' }` is acceptable even when startup fails later.

### Related setup UX/state assumptions

3. Finalization currently happens only on `setup.complete` response return:
   - `packages/ui/src/lib/components/SetupWizard.svelte:218`
   - `packages/ui/src/lib/components/SetupWizard.svelte:289`
   - Assumption: user sees only "Finishing..." while request is in flight; there is no streamed progress from backend.

4. Complete screen polls health after finalization:
   - `packages/ui/src/lib/components/CompleteStep.svelte:11`
   - `packages/ui/src/lib/components/CompleteStep.svelte:16`
   - `packages/ui/src/lib/components/CompleteStep.svelte:65`
   - Assumption: some services may still be coming up after `setup.complete` returns.

5. Health endpoint used by Complete step:
   - `packages/ui/src/routes/setup/health-check/+server.ts:13`
   - Assumption: point-in-time health polling is sufficient for post-complete UI messaging (not authoritative backend convergence).

### Documentation/usages that must be updated

6. CLI flow doc still lists `setup.start_core` as step 3:
   - `docs/cli.md:151`

7. Consolidated reliability report tracks this recommendation as OPEN:
   - `dev/docs/install-setup-simplification-reliability-report-consolidated.md:24`

## Ordered refactor/removal steps

1. Remove the `setup.start_core` command branch from command API.
   - Delete handler block in `packages/ui/src/routes/command/+server.ts:205`.
   - Remove detached async IIFE startup logic and `status: 'starting'` return.

2. Remove fire-and-forget invocation from wizard service-instances step.
   - Delete call in `packages/ui/src/lib/components/SetupWizard.svelte:149` and `packages/ui/src/lib/components/SetupWizard.svelte:152`.
   - Keep `setup.service_instances` strictly as persistence/config mutation.

3. Ensure replacement behavior is explicit in `setup.complete` path.
   - Keep startup orchestration only in `setup.complete` (`packages/ui/src/routes/command/+server.ts:348`).
   - If startup pre-pull is desired, move it here synchronously and fail-fast on errors (no detached work).
   - Return structured failure payloads on compose failure (currently thrown error at `packages/ui/src/routes/command/+server.ts:360`).

4. Keep endpoint parity and avoid hidden alternate startup paths.
   - Confirm `/setup/complete` mirrors command behavior (`packages/ui/src/routes/setup/complete/+server.ts:39`).
   - Ensure there is no residual startup trigger in `/setup/service-instances` and related routes.

5. Align service list ownership while touching startup logic.
   - Prefer canonical `CoreServices` from `packages/lib/src/admin/compose-runner.ts:4`.
   - Remove/avoid adding new inline setup-only startup lists in command handlers.

6. Update frontend UX copy to match single startup boundary.
   - Remove any implication that startup already began before Finish Setup.
   - Preserve existing retry affordance on completion failure (`packages/ui/src/lib/components/SetupWizard.svelte:225`).

## Compatibility handling

1. Server-side compatibility shim (recommended for one release window):
   - Keep `setup.start_core` accepted but as explicit no-op response:
     - `{ ok: true, deprecated: true, code: 'setup_start_core_removed' }`
   - Log one warning server-side when called.
   - Rationale: older UI bundles (or external scripts) calling `/command` do not hard-fail immediately.

2. Removal phase (next release after shim):
   - Drop shim and let unknown command path return:
     - `unknown_command` from `packages/ui/src/routes/command/+server.ts:680`.

3. If project policy prefers immediate hard removal, skip shim and document this as a minor breaking change in release notes.

## Tests/docs/scripts updates

### Tests

1. Add command API coverage for deprecated/no-op or removed behavior:
   - `packages/ui/test/api/08-command-api.test.ts:49`
   - New assertion: `setup.start_core` returns expected compatibility response (shim mode) or `400 unknown_command` (hard-remove mode).

2. Add/adjust static guard tests for command file:
   - `packages/ui/src/routes/command/command-setup-flow.test.ts:5`
   - Assert no `setup.start_core` branch exists after removal.

3. Keep wizard flow ordering assertions valid:
   - `packages/ui/src/lib/components/setup-wizard-order.test.ts:6`
   - Optionally add assertion that `SetupWizard.svelte` does not contain `setup.start_core`.

4. Re-run setup wizard Playwright scenarios for regressions in completion/health polling:
   - `packages/ui/e2e/10-setup-wizard-ui.pw.ts:156`
   - Ensure no test relies on background startup side effects.

### Docs

1. Remove `setup.start_core` from setup flow table and renumber steps:
   - `docs/cli.md:147`
   - `docs/cli.md:151`

2. Update reliability report status when implemented:
   - `dev/docs/install-setup-simplification-reliability-report-consolidated.md:24`

### Scripts

1. Repository scan currently shows no install/ops scripts invoking `setup.start_core` directly.
   - Verification source: grep results from current tree (only UI command caller + docs).
2. No script changes required unless external release scripts/documentation reference this command.

## Verification checklist

- [ ] `grep -R "setup.start_core" packages/ui/src` shows no runtime caller in wizard and no live command branch (or only compatibility shim by design).
- [ ] `setup.service_instances` no longer triggers startup side effects.
- [ ] `setup.complete` remains the only setup command that starts core runtime services.
- [ ] Command API tests pass, including compatibility/removal assertions.
- [ ] Setup wizard unit/e2e tests pass with unchanged user-visible completion behavior.
- [ ] `docs/cli.md` setup sequence no longer mentions `setup.start_core`.
- [ ] Release notes/changelog call out compatibility mode or removal decision.

## Suggested execution order

1. Land backend change (`/command`) + compatibility behavior.
2. Land wizard caller removal.
3. Update tests.
4. Update docs.
5. Run UI test suite + targeted e2e setup flow.
