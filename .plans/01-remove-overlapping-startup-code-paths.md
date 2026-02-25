# Implementation Plan: Remove Overlapping Startup Code Paths (P0)

## Objective

Eliminate overlapping runtime startup orchestration during install/setup so that OpenPalm has one authoritative core-start path after bootstrap, while preserving guardrails:

- single compose runner path,
- direct Docker/Compose error visibility,
- reliable setup completion semantics.

Target behavior:

1. `openpalm install` still boots only bootstrap services (`caddy` + `admin`).
2. Setup non-terminal commands mutate config/state only (no runtime up/restart side effects).
3. Only setup finalization path performs core runtime startup.

## Current-State Findings (with code references)

- Bootstrap startup is correctly isolated in CLI install: minimal compose (`caddy` + `admin`) is written and started in `packages/cli/src/commands/install.ts:303`, `packages/cli/src/commands/install.ts:360`, and `packages/cli/src/commands/install.ts:385`.
- Command endpoint duplicates startup behavior in multiple branches:
  - dedicated fire-and-forget starter `setup.start_core` with detached async IIFE in `packages/ui/src/routes/command/+server.ts:205`.
  - `setup.access_scope` runs `composeAction('up', ...)` and swallows errors in initial setup in `packages/ui/src/routes/command/+server.ts:236` and `packages/ui/src/routes/command/+server.ts:249`.
  - `setup.profile` conditionally runs `composeAction('up', 'assistant')` in `packages/ui/src/routes/command/+server.ts:267`.
  - `setup.complete` runs startup separately using a local service constant in `packages/ui/src/routes/command/+server.ts:49` and `packages/ui/src/routes/command/+server.ts:359`.
- Wizard triggers hidden background startup before completion by calling `setup.start_core` in `packages/ui/src/lib/components/SetupWizard.svelte:149`.
- Parallel REST setup routes duplicate completion/scope startup logic:
  - `/setup/complete` defines its own core list and performs compose up in `packages/ui/src/routes/setup/complete/+server.ts:15` and `packages/ui/src/routes/setup/complete/+server.ts:39`.
  - `/setup/access-scope` performs compose side effects in `packages/ui/src/routes/setup/access-scope/+server.ts:25`.
- Core service lists are not canonicalized at setup call sites:
  - canonical list exists in lib at `packages/lib/src/admin/compose-runner.ts:4`.
  - separate setup list exists in command route at `packages/ui/src/routes/command/+server.ts:49`.
  - separate setup list exists in setup route at `packages/ui/src/routes/setup/complete/+server.ts:15`.
- Setup completion state is marked by `completeSetup()` setting `completed=true` in `packages/lib/src/admin/setup-manager.ts:151`; this must remain gated behind successful final startup execution.
- Docs still describe `setup.start_core` as a setup phase step in `docs/cli.md:151`.
- API/integration tests currently exercise duplicated `/setup/*` flows and `/setup/complete` directly (not just `/command`): `packages/ui/test/api/helpers.ts:226`, `packages/ui/test/api/helpers.ts:240`, and `packages/ui/test/api/03-setup-api.test.ts:171`.
- Release smoke uses setup wizard E2E at `test/install-e2e/happy-path.docker.ts:379` via workflow job `setup-wizard-e2e` in `.github/workflows/release.yml:161`.

## Ordered Implementation Steps

1. **Create a shared setup finalization orchestrator in UI server layer**
   - Add a new internal module (for example `packages/ui/src/lib/server/setup-completion.ts`) that owns the finalization transaction:
     1) ensure `POSTGRES_PASSWORD` exists,
     2) run `applyStack(...)`,
     3) run one compose `up` for core services,
     4) sync automations,
     5) mark setup complete.
   - Move duplicated logic from `packages/ui/src/routes/command/+server.ts:348` and `packages/ui/src/routes/setup/complete/+server.ts:28` into this shared function.
   - Keep error contract Docker-first: return compose stderr/code directly (wrapped minimally with setup context), do not add silent retries.

2. **Canonicalize setup core service selection through lib constants**
   - Stop defining startup arrays inside route handlers (`packages/ui/src/routes/command/+server.ts:49`, `packages/ui/src/routes/setup/complete/+server.ts:15`).
   - Import `CoreServices` from `packages/lib/src/admin/compose-runner.ts:4` and derive setup runtime list once (exclude bootstrap-only or UI-managed exclusions deterministically, not ad hoc inline arrays).
   - If needed, add one exported helper in lib compose-runner to derive "setup-startable core services" to avoid repeating filter logic across routes.

3. **Remove fire-and-forget startup command path**
   - Delete `setup.start_core` branch from `packages/ui/src/routes/command/+server.ts:205`.
   - Remove the wizard call to `setup.start_core` in `packages/ui/src/lib/components/SetupWizard.svelte:149`.
   - Ensure wizard UX copy still indicates that startup happens at final "Finish Setup" action (`packages/ui/src/lib/components/SetupWizard.svelte:218`).

4. **Make non-terminal setup commands config-only**
   - In `setup.access_scope`, remove compose side effects from `packages/ui/src/routes/command/+server.ts:242` and `packages/ui/src/routes/setup/access-scope/+server.ts:25`.
   - In `setup.profile`, remove conditional assistant startup from `packages/ui/src/routes/command/+server.ts:267`.
   - Keep state/env mutation behavior unchanged and idempotent.

5. **Collapse parallel `/setup/complete` implementation onto shared orchestrator**
   - Keep endpoint compatibility, but route both `/command` (`setup.complete`) and `/setup/complete` through the same shared function introduced in step 1.
   - Remove duplicate completion code from `packages/ui/src/routes/setup/complete/+server.ts:28` onward, leaving only auth/locality checks plus shared-function call.
   - Ensure both endpoints return equivalent success/failure payloads (same status and error shape).

6. **Align setup API helper paths to a single logical path in tests**
   - Update `packages/ui/test/api/helpers.ts:220`-`packages/ui/test/api/helpers.ts:240` to use `/command` setup commands for mutable steps where possible, reducing reliance on duplicate `/setup/*` route implementations.
   - Keep `/setup/step` and `/setup/status` route tests where endpoint contracts are intentional, but stop using `/setup/complete` as the only completion path in shared helpers.

7. **Document the new single startup path explicitly**
   - Update setup flow table in `docs/cli.md:147`-`docs/cli.md:156`:
     - remove `setup.start_core` row,
     - change `setup.access_scope` to config-only,
     - keep `setup.complete` as sole core startup trigger.
   - Update sequence narrative in `docs/cli.md:98`-`docs/cli.md:106` so runtime startup is represented only at completion.
   - Update report status in `dev/docs/install-setup-simplification-reliability-report-consolidated.md:21` from OPEN to implemented once merged, with links to final PR/files.

8. **Add a guard script/check to prevent path reintroduction**
   - Add a lightweight CI check script (for example under `dev/scripts/`) that fails if:
     - `setup.start_core` reappears in runtime code,
     - non-terminal setup handlers call `composeAction('up'|'restart', ...)`.
   - Wire it into existing validation command flow (`package.json:20` scripts and release/unit workflow gates in `.github/workflows/release.yml:60`) so duplication regressions fail fast.

## Tests To Add/Update

1. **Route logic unit tests (command handler)**
   - Expand `packages/ui/src/routes/command/command-setup-flow.test.ts` to assert:
     - no `setup.start_core` branch exists,
     - `setup.profile` and `setup.access_scope` contain no runtime startup side effects,
     - `setup.complete` is the only setup command that invokes startup.

2. **Setup completion route parity tests**
   - Add/extend tests for `packages/ui/src/routes/setup/complete/+server.ts` and `/command` completion to assert same payload and error behavior using mocked compose runner responses.

3. **API integration tests**
   - Update `packages/ui/test/api/03-setup-api.test.ts` to complete through `/command` (`setup.complete`) and verify completion state remains correct.
   - Update `packages/ui/test/api/08-command-api.test.ts` to include negative case coverage ensuring removed command types return `unknown_command` for `setup.start_core`.

4. **E2E smoke test updates**
   - Update `test/install-e2e/happy-path.docker.ts` to assert full wizard success without any mid-wizard startup command dependency.
   - Keep release workflow job invocation stable in `.github/workflows/release.yml:169`, only changing test expectations/file name if needed.

5. **Lib-level service-list regression test**
   - Add a targeted test in `packages/lib/src/admin/compose-runner.test.ts` to verify canonical core list derivation used by setup completion remains stable and includes expected core services.

## Docs Updates

- `docs/cli.md`: remove outdated `setup.start_core` documentation and clarify that only completion performs core startup.
- `dev/docs/install-setup-simplification-reliability-report-consolidated.md`: mark recommendation status and add implementation notes once delivered.
- If API contract docs enumerate setup command types, update `dev/docs/api-reference.md:33` to explicitly list retained setup commands and note `setup.start_core` removal.

## Rollout and Risks

- **Risk: Hidden dependency on `/setup/complete` duplicate behavior in tests/tools**
  - Mitigation: keep endpoint path but delegate to shared orchestrator first; remove internals only after parity tests pass.
- **Risk: Service-list drift during refactor**
  - Mitigation: derive from `CoreServices` in `packages/lib/src/admin/compose-runner.ts:4` and add regression test.
- **Risk: Reduced perceived progress (no background startup)**
  - Mitigation: ensure finish-step messaging in `packages/ui/src/lib/components/SetupWizard.svelte:218` clearly indicates startup occurs during finalization.
- **Risk: accidental error masking regression**
  - Mitigation: forbid `.catch(() => {})` in setup startup paths and assert raw compose stderr propagation in tests.

## Acceptance Checks

1. No runtime code contains `setup.start_core` command handling or wizard invocation.
2. `setup.profile` and `setup.access_scope` handlers mutate config/state only and do not run compose lifecycle commands.
3. `setup.complete` is the only setup command that starts core runtime services.
4. `/command` and `/setup/complete` use the same internal completion orchestrator and produce equivalent results.
5. Core service startup list is sourced from lib canonical definitions (no duplicate route-local constants).
6. Updated docs describe one startup path (bootstrap install + completion startup) with no references to background startup command.
7. Updated unit/integration/E2E tests pass locally and in CI release gates.
8. Docker/compose failures during completion are surfaced directly to caller (no silent swallowing, no detached fire-and-forget success).
