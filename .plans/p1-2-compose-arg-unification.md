# P1-2 Implementation Plan: Compose Arg/Env-File Unification

Date: 2026-03-24  
Backlog item: `P1-2` in `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:155`

## Scope and Current State

This plan targets the **remaining** consolidation work for compose command assembly after the already-completed removal of `.openpalm/stack/start.sh`.

- Confirmed: `.openpalm/stack/start.sh` is already deleted (no file present).
- Remaining drift risk is now in TS call sites where CLI/admin still assemble compose args and preflight messages in multiple places.
- Goal: one canonical lib-level compose invocation builder used by both CLI and admin wrappers.

## What Is Still Duplicated (with exact refs)

### CLI duplication

- `packages/cli/src/lib/cli-compose.ts:24` builds full compose args (`--project-name`, `-f`, `--env-file`) locally.
- `packages/cli/src/lib/cli-compose.ts:67` repeats file/env resolution for preflight.
- `packages/cli/src/lib/cli-compose.ts:74` to `packages/cli/src/lib/cli-compose.ts:82` manually assembles a resolved command string for errors.
- `packages/cli/src/commands/install.ts:107` and `packages/cli/src/commands/install.ts:256` call CLI-local arg assembly rather than a single lib canonical structure.

### Admin duplication

- `packages/admin/src/lib/server/docker.ts:40` runs preflight with admin-local helper.
- `packages/admin/src/lib/server/docker.ts:44` to `packages/admin/src/lib/server/docker.ts:50` manually assembles resolved command string.
- Repeated route-level file/env assembly via `buildComposeFileList(state)` + `buildEnvFiles(state)`:
  - `packages/admin/src/routes/admin/install/+server.ts:60`
  - `packages/admin/src/routes/admin/update/+server.ts:38`
  - `packages/admin/src/routes/admin/uninstall/+server.ts:30`
  - `packages/admin/src/routes/admin/containers/pull/+server.ts:33`
  - `packages/admin/src/routes/admin/upgrade/+server.ts:47`

### Lib gaps preventing true unification

- `packages/lib/src/control-plane/docker.ts:80` has private `buildComposeArgs(...)` that is not reusable by CLI/admin.
- `packages/lib/src/control-plane/lifecycle.ts:244` owns compose file list builder in lifecycle module (wrong ownership for cross-consumer composition concerns).
- `packages/lib/src/control-plane/config-persistence.ts:69` owns env-file list; this is correct ownership, but consumers still reconstruct command presentation outside lib.

## Implementation Strategy

## 1) Introduce canonical compose invocation builder in `@openpalm/lib`

Create a shared API that returns both machine args and human-readable diagnostics.

Proposed API shape (module-level):

- `buildComposeInvocation(state)`
  - Returns:
    - `projectName`
    - `files`
    - `envFiles`
    - `composeBaseArgs` (for `docker` argv: `['compose', ...]`)
    - `resolvedConfigCommand` (display string for preflight failure output)
- `buildComposeBaseArgs({ files, envFiles, projectName? })`
  - Reusable by lib docker wrapper and external consumers.

Target files:

- Add new module under `packages/lib/src/control-plane` (e.g. `compose-invocation.ts`).
- Update exports in `packages/lib/src/index.ts` near existing lifecycle/docker exports (`packages/lib/src/index.ts:187`, `packages/lib/src/index.ts:201`).

Implementation detail requirements:

- Preserve existing `OP_PROJECT_NAME` behavior (`packages/lib/src/control-plane/docker.ts:38`).
- Keep env-file filtering deterministic and existence-aware (currently done in `docker.ts:83` and `config-persistence.ts:75`).
- Provide a **single** resolved command formatter so CLI/admin/lifecycle do not each build strings.

## 2) Move compose file-list responsibility out of lifecycle-centric location

Current `buildComposeFileList` lives in lifecycle (`packages/lib/src/control-plane/lifecycle.ts:244`), but it is a cross-cutting orchestration primitive.

Plan:

- Relocate this function into the new compose invocation module.
- Keep a temporary re-export in lifecycle for compatibility (short-lived), then remove direct lifecycle ownership.
- Ensure addon ordering is deterministic (sort addon names before path append) to meet acceptance criteria on consistent invocations.

Why this matters:

- Right now consumers import from lifecycle because no compose-specific module exists.
- Centralizing file + env + args + diagnostics in one module eliminates consumer-side reconstruction.

## 3) Migrate CLI to canonical lib builder

Update CLI compose wrapper to delegate instead of rebuilding.

Primary edits:

- `packages/cli/src/lib/cli-compose.ts:24`
  - Replace local arg assembly in `fullComposeArgs` with lib `buildComposeInvocation(state).composeBaseArgs` (or equivalent canonical output).
- `packages/cli/src/lib/cli-compose.ts:67`
  - Reuse invocation object for preflight inputs (`files`, `envFiles`).
- `packages/cli/src/lib/cli-compose.ts:74`
  - Replace local resolved command string with `resolvedConfigCommand` from lib.

Secondary call sites that benefit automatically:

- `packages/cli/src/commands/install.ts:107`
- `packages/cli/src/commands/install.ts:256`
- `packages/cli/src/commands/start.ts:30`
- `packages/cli/src/commands/update.ts:15`
- `packages/cli/src/commands/restart.ts:28`
- `packages/cli/src/commands/stop.ts:28`

## 4) Migrate admin wrappers/routes to canonical lib builder

### Docker wrapper preflight path

- `packages/admin/src/lib/server/docker.ts:40`
  - Keep preflight enforcement behavior, but use lib-resolved command formatter instead of local string assembly at `packages/admin/src/lib/server/docker.ts:44`.

### Route-level compose inputs

Replace repeated route-local `files/buildComposeFileList` + `envFiles/buildEnvFiles` pairs with one invocation object per request.

Highest-impact routes:

- `packages/admin/src/routes/admin/install/+server.ts:60`
- `packages/admin/src/routes/admin/update/+server.ts:38`
- `packages/admin/src/routes/admin/uninstall/+server.ts:30`
- `packages/admin/src/routes/admin/containers/pull/+server.ts:33`
- `packages/admin/src/routes/admin/upgrade/+server.ts:47`

Follow-on consistency routes (same pattern in existing grep output):

- `packages/admin/src/routes/admin/containers/up/+server.ts:42`
- `packages/admin/src/routes/admin/containers/down/+server.ts:41`
- `packages/admin/src/routes/admin/containers/restart/+server.ts:41`
- `packages/admin/src/routes/admin/containers/list/+server.ts:26`
- `packages/admin/src/routes/admin/logs/+server.ts:67`
- `packages/admin/src/routes/admin/uninstall/+server.ts:30`

## 5) Align lifecycle preflight to the same formatting helper

`reconcileCore()` currently hand-builds the resolved command string:

- `packages/lib/src/control-plane/lifecycle.ts:141`
- `packages/lib/src/control-plane/lifecycle.ts:144`

Switch it to the same canonical formatter used by CLI/admin so failures are identical across all supported entrypoints.

## Test Plan (exact files/refs)

## A) Lib tests (new/expanded)

- Add targeted tests for canonical invocation builder in new test file under `packages/lib/src/control-plane`.
  - Validate deterministic file order (core first, sorted addons).
  - Validate env-file order and filtering behavior.
  - Validate resolved command string format.
- Update guardrails to prevent reintroduction of distributed command assembly:
  - `packages/lib/src/control-plane/cleanup-guardrails.test.ts:99`
  - `packages/lib/src/control-plane/cleanup-guardrails.test.ts:122`

## B) CLI tests

- Add/adjust CLI wrapper tests to assert CLI no longer manually formats compose command diagnostics:
  - `packages/cli/src/install-flow.test.ts:332` (compose command assertions)
  - `packages/cli/src/main.test.ts:83` (mocking strategy; preserve non-interactive behavior)

## C) Admin tests

- Update admin docker wrapper tests to verify preflight failure message uses shared formatter:
  - `packages/admin/src/lib/server/docker.test.ts:69`
  - `packages/admin/src/lib/server/docker.test.ts:178`
- Update env-file expectation tests if builder output shape/ordering changes:
  - `packages/admin/src/lib/server/config-persistence.test.ts:152`

## D) Required verification commands

- `cd packages/admin && npm run check`
- `cd core/guardian && bun test`
- `cd packages/lib && bun test`
- `cd packages/cli && bun test`

## Docs Update Plan (exact refs)

Update docs so they reference canonical CLI/admin orchestration behavior (not script parity assumptions).

- `docs/how-it-works.md:45`
  - Clarify CLI/admin both invoke compose through shared `@openpalm/lib` assembly.
- `docs/how-it-works.md:158`
  - Keep manual compose example, add note that CLI/admin generate same file/env set/order.
- `docs/technical/api-spec.md:103`
  - Note lifecycle endpoints use shared compose invocation builder (consistent args/env files).
- `docs/operations/manual-compose-runbook.md:48`
  - Add cross-reference that this command structure mirrors lib-backed CLI/admin orchestration.

Optional cleanup (if in scope for this tranche):

- `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:155`
  - Annotate that `start.sh` deletion task is complete and remaining work is TS-level unification.

## Complexity Check / Risk Controls

Unjustified complexity to avoid:

- Do **not** add multiple overlapping builders (e.g., separate builder for CLI and admin wrappers).
- Do **not** keep duplicated resolved-command formatter logic in lifecycle/CLI/admin after lib helper exists.
- Do **not** introduce feature behavior changes beyond argument/env-file assembly consolidation.

Risk controls:

- Keep function signatures stable where possible; introduce wrapper exports first, then migrate call sites.
- Preserve preflight gating semantics (`OP_SKIP_COMPOSE_PREFLIGHT`) across all entrypoints.
- Land with guardrail tests that explicitly fail if manual compose arg string construction is reintroduced outside the canonical module.

## Sequenced Execution Steps

1. Add canonical compose invocation module + exports in lib.
2. Move/alias compose file list builder from lifecycle to new module.
3. Refactor lib lifecycle preflight error formatting to canonical formatter.
4. Refactor CLI compose wrapper to consume canonical invocation object.
5. Refactor admin docker wrapper and top lifecycle/container routes to consume canonical invocation object.
6. Update/extend tests (lib -> CLI/admin).
7. Update docs refs listed above.
8. Run verification commands and fix regressions.

## Definition of Done for P1-2 Remaining Work

- No supported entrypoint (CLI/admin/lib lifecycle) manually reconstructs compose base args or resolved command strings.
- Canonical compose invocation object/function in `@openpalm/lib` is the single source for:
  - project name
  - compose file list
  - env-file list
  - base `docker compose` args
  - preflight diagnostic command string
- `start.sh` stays absent and no docs describe it as an active path.
- Tests and docs listed above are updated and passing.
