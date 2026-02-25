# Implementation Plan: Structured Preflight Failure Types (P2)

## Goal

Replace message-substring preflight handling with stable typed failure codes so install/setup decisions are deterministic, localization-friendly, and easier to test.

This plan implements recommendation **"Structured preflight failure types" (P2)** from `dev/docs/install-setup-simplification-reliability-report-consolidated.md:311`.

## Current Baseline (File:Line References)

- Preflight currently returns freeform warning strings via `PreflightWarning`: `packages/lib/src/preflight.ts:4`.
- Disk check emits prose-only warning text (no code): `packages/lib/src/preflight.ts:33`.
- Port check emits prose-only warning text (no code): `packages/lib/src/preflight.ts:58`.
- Daemon check emits prose-only warning text (no code): `packages/lib/src/preflight.ts:108`.
- Install command parses warning text with `includes(...)` to decide fatal behavior: `packages/cli/src/commands/install.ts:74`.
- Existing typed compose failures already exist and should be mirrored in design style: `packages/lib/src/types.ts:18` and `packages/lib/src/compose-runner.ts:12`.
- CLI docs describe preflight checks but not typed outcomes: `docs/cli.md:48`.
- API guidance already expects stable `code` fields in error payloads: `dev/docs/api-reference.md:14`.

## Type System Changes

### 1) Add explicit preflight code taxonomy in shared lib types

Add to `packages/lib/src/types.ts` near existing error code unions (`packages/lib/src/types.ts:18`):

- `PreflightCode`
  - `daemon_unavailable`
  - `daemon_check_failed`
  - `port_conflict`
  - `disk_low`
  - `unknown`
- `PreflightSeverity = 'fatal' | 'warning'`
- `PreflightIssue`
  - `code: PreflightCode`
  - `severity: PreflightSeverity`
  - `message: string` (human-facing default)
  - `detail?: string` (human-facing default)
  - `meta?: { port?: number; availableGb?: number; runtime?: string; command?: string }`
- `PreflightResult`
  - `ok: boolean`
  - `issues: PreflightIssue[]`

Rationale:
- Keep typed decision fields (`code`, `severity`) separate from display fields (`message`, `detail`).
- Keep human text for CLI output and backward compatibility during migration.
- Keep types in `packages/lib` to satisfy shared-contract guidance.

### 2) Refactor preflight API to return typed outcomes

Update `packages/lib/src/preflight.ts:126`:

- Introduce `runPreflightChecksDetailed(...) => Promise<PreflightResult>` as the new canonical API.
- Keep `runPreflightChecks(...) => Promise<PreflightWarning[]>` as temporary compatibility shim for one release window.
- Internally migrate individual checks (`checkDiskSpace`, `checkPort`, `checkDaemonRunning`) from `PreflightWarning | null` to `PreflightIssue | null` and have shim map back to warning shape.

## Mapping Strategy From Existing Warnings

Map existing checks deterministically without parsing messages:

| Existing source | Current string trigger | New `PreflightCode` | Severity | Meta to include |
|---|---|---|---|---|
| `checkDiskSpace` (`packages/lib/src/preflight.ts:30`) | available KB < threshold | `disk_low` | `warning` | `availableGb` |
| `checkPort` (`packages/lib/src/preflight.ts:54`, `packages/lib/src/preflight.ts:71`) | listener found on configured port | `port_conflict` | `fatal` | `port`, optional listener snippet |
| `checkDaemonRunning` non-zero exit (`packages/lib/src/preflight.ts:106`) | daemon not running | `daemon_unavailable` | `fatal` | `runtime`, `command` |
| `checkDaemonRunning` exception (`packages/lib/src/preflight.ts:115`) | daemon check could not execute | `daemon_check_failed` | `fatal` (default) | `runtime`, `command`, raw error |

Additional mapping rule:
- Any future non-classified branch in preflight should emit `code: 'unknown'` with explicit `severity` to avoid implicit string behavior.

## Call-Site Migration Away From Message Parsing

### Phase A (introduce typed path, no behavior change)

1. In `packages/cli/src/commands/install.ts:60`, switch to `runPreflightChecksDetailed(...)`.
2. Continue printing `issue.message` and `issue.detail` exactly as today for user-facing continuity.
3. Replace substring checks at `packages/cli/src/commands/install.ts:74` and `packages/cli/src/commands/install.ts:88` with code-based branching:
   - fatal daemon: `issue.code === 'daemon_unavailable' || issue.code === 'daemon_check_failed'`
   - fatal port: `issue.code === 'port_conflict'`

### Phase B (retire legacy parsing contract)

4. Remove string-based conditional comments and logic from install flow.
5. Deprecate and then remove `runPreflightChecks(...)` warning-array shim after all call sites are migrated (currently only install path uses it: `packages/cli/src/commands/install.ts:60`).
6. Keep `checkPort80()` deprecation untouched (`packages/lib/src/preflight.ts:87`) until broader API cleanup.

## Code/Docs/Tests/Scripts Update Plan (with file:line refs)

### Code

- `packages/lib/src/types.ts:18`
  - Add `PreflightCode`, `PreflightSeverity`, `PreflightIssue`, `PreflightResult`.
- `packages/lib/src/preflight.ts:4`
  - Replace warning-only internal model with typed issue model; add compatibility shim.
- `packages/lib/src/index.ts:14`
  - Ensure new preflight result types stay exported through the public lib entry.
- `packages/cli/src/commands/install.ts:60`
  - Migrate to typed preflight call and code-based fatal branching.

### Docs

- `docs/cli.md:48`
  - Update preflight section to describe typed categories (`daemon_unavailable`, `port_conflict`, `disk_low`) and fatal vs warning behavior.
- `dev/docs/api-reference.md:14`
  - Add a short preflight note under admin/common expectations describing stable `code` values for install/setup diagnostics.
- `dev/docs/install-setup-simplification-reliability-report-consolidated.md:27`
  - Move status from PARTIAL to COMPLETE when migration lands.

### Tests

- `packages/cli/src/commands/install-port.test.ts:43`
  - Replace assumptions tied to message text with assertions on typed code/severity from preflight API.
- `packages/cli/test/install.test.ts:48`
  - Remove source-string assertions that encode old API usage; add behavior-oriented tests around code-based handling.
- Add new unit tests: `packages/lib/src/preflight.test.ts` (new)
  - Verify each check maps to expected `PreflightCode`.
  - Verify `severity` contracts (`disk_low` warning; daemon/port fatal).
  - Verify compatibility shim returns equivalent message/detail output.
- Add new CLI integration-focused tests: `packages/cli/src/commands/install.preflight-codes.test.ts` (new)
  - Simulate mixed issue sets and assert install exits/fails for fatal codes without message parsing.

### Scripts / CI

- `package.json:22`
  - Add a targeted script (for example `test:preflight-contract`) to run new preflight type contract tests quickly.
- `.github/workflows/release.yml:77`
  - Ensure preflight-contract tests run in release validation (either as part of `bun test` filters or explicit step).

## Backward Compatibility Plan

- Keep output text unchanged in the first migration pass to avoid user-visible wording churn.
- Maintain `message`/`detail` fields on `PreflightIssue` so existing console rendering paths remain stable.
- Provide temporary adapter function (`runPreflightChecks`) returning legacy warning arrays for any external/internal callers not yet migrated.
- Keep fatal behavior parity with current install semantics:
  - daemon unavailable/check failed -> hard fail
  - port conflict -> hard fail
  - disk low -> warning only
- Document deprecation timeline in changelog/release notes before removing legacy shim.

## Localization Considerations

- Use `code` + `meta` as the semantic source of truth; treat `message`/`detail` as default English rendering.
- Centralize message formatting in one preflight formatter helper (within `packages/lib/src/preflight.ts`) so localization can later swap formatter implementations without touching decision logic.
- Avoid tests that depend on exact English text for fatal branching.

## Testability Considerations

- Prefer deterministic test seams by injecting/spying process execution outcomes for each check path.
- Assert contracts on `code`, `severity`, and `meta`, not full prose.
- Keep a small snapshot/contract test for default English messages to catch accidental UX regressions while still allowing localization work.
- Add regression test proving no `includes(...)`-style parsing remains in install preflight decision logic (`packages/cli/src/commands/install.ts:74` current removal target).

## Rollout Sequence

1. Add new shared types and typed preflight API in lib.
2. Migrate install command to typed path while preserving printed text.
3. Add/adjust tests (lib + CLI) for code-based behavior.
4. Update docs and release workflow test coverage.
5. Remove legacy shim in a follow-up once no call sites remain.

## Completion Criteria

- Install flow contains no preflight decision logic based on message substrings.
- Preflight outcomes expose stable typed codes and severities in shared lib contracts.
- Fatal/warning behavior is unchanged functionally, but now code-driven.
- Docs describe typed preflight categories and behavior.
- Tests validate mapping + branching by type code and guard against regressions.
