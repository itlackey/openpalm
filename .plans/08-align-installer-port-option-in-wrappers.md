# Implementation Plan: Align Installer `--port` Option in Wrappers (P2)

## Goal

Make `install.sh` and `install.ps1` accept and pass through `--port` so users can recover from ingress port conflicts from the one-line installers, with matching help text and explicit remediation guidance.

## Current Baseline (File:Line References)

- CLI already supports and validates install port selection: `packages/cli/src/main.ts:135`, `packages/cli/src/main.ts:137`, `packages/cli/src/main.ts:146`.
- CLI install already uses `options.port` for preflight and ingress wiring: `packages/cli/src/commands/install.ts:59`, `packages/cli/src/commands/install.ts:227`, `packages/cli/src/commands/install.ts:264`, `packages/cli/src/commands/install.ts:389`.
- CLI port-conflict remediation already points to `--port`: `packages/cli/src/commands/install.ts:93`.
- Bash wrapper does not parse/forward `--port` and rejects unknown options: `install.sh:28`, `install.sh:53`, `install.sh:69`, `install.sh:219`.
- PowerShell wrapper accepts only `Runtime/Ref/NoOpen`: `install.ps1:10`, `install.ps1:14`; current pass-through list has no port: `install.ps1:108`, `install.ps1:125`.
- CLI docs install options omit `--port`: `docs/cli.md:44`.
- Existing tests cover wrapper/documented flags but not `--port`: `packages/cli/test/install-methods.test.ts:103`, `packages/cli/test/install-methods.test.ts:201`, `packages/cli/test/main.test.ts:100`.

## Implementation Order

1. **Add Bash wrapper argument parsing for `--port`**
   - Update `install.sh` parser case block to accept `--port <number>` and append to `CLI_ARGS`.
   - Mirror existing missing-value handling style used for `--runtime`/`--ref` (`install.sh:31`, `install.sh:43`).
   - Keep wrapper thin: do basic numeric/range validation only to fail fast with clear wrapper-level errors; CLI remains source of truth.
   - Touchpoints: `install.sh:28-74` and delegation line `install.sh:219`.

2. **Update Bash wrapper help text and examples**
   - Add `--port` to usage line and options list.
   - Add one curl piping example showing `--port` usage for port-conflict recovery.
   - Touchpoints: `install.sh:13-17`, `install.sh:53-64`.

3. **Add PowerShell wrapper parameter and pass-through**
   - Extend `param(...)` with a nullable port parameter (e.g., `[int]$Port`) plus validation attributes/rules for 1-65535.
   - Add `--port` forwarding in `$CliArgs` assembly only when a value is provided.
   - Keep behavior parallel to Bash wrapper and CLI semantics.
   - Touchpoints: `install.ps1:10-15`, `install.ps1:108-123`.

4. **Add PowerShell help/discoverability**
   - Because `install.ps1` relies on PowerShell parameter help rather than an explicit `--help` case, add comment-based help (`.SYNOPSIS`, `.PARAMETER Port`, usage examples) at top-of-file so `Get-Help` includes `Port`.
   - Include an example showing alternate ingress port usage.
   - Touchpoints: `install.ps1:1-9` (new help block), `install.ps1:10-15` (param definitions).

5. **Add wrapper-level port-conflict remediation messaging**
   - Add a thin post-install failure handler around CLI invocation in each wrapper:
     - If CLI exits non-zero and emitted known port-conflict wording (`already in use`, `Port 80 is required`), print wrapper-specific remediation examples using the same installer entrypoint (`bash -s -- --port 8080` / `-Port 8080`).
     - Preserve original CLI stderr output and exit code; do not mask Docker/CLI errors.
   - Touchpoints: `install.sh:218-219`, `install.ps1:124-126`, remediation source wording in `packages/cli/src/commands/install.ts:93`.

6. **Update docs to reflect wrapper/CLI parity**
   - Add `--port <number>` to install options in `docs/cli.md` alongside `--runtime` and `--no-open`.
   - Add one short note in installer sections showing how to pass port overrides through both wrappers.
   - Touchpoints: `docs/cli.md:44-47`, `docs/cli.md:20-32`.

7. **Extend tests for parsing/help/passthrough contracts**
   - Update wrapper content tests to assert Bash wrapper mentions `--port` and PowerShell wrapper defines/forwards a port parameter.
     - `packages/cli/test/install-methods.test.ts:103-113`
     - `packages/cli/test/install-methods.test.ts:162-172`
   - Update docs coverage tests to require `--port` in install options section.
     - `packages/cli/test/install-methods.test.ts:200-210`
   - Update CLI help snapshot/assertions to include `--port` (already printed in main help, but test currently does not assert it).
     - `packages/cli/test/main.test.ts:100-108`
   - Add focused tests for wrapper remediation text trigger logic (unit-level string matching function if extracted), avoiding full process spawning.

8. **Run validation and CI-aligned checks locally**
   - Run targeted CLI test suites first:
     - `bun test packages/cli/test/main.test.ts`
     - `bun test packages/cli/test/install-methods.test.ts`
   - Run repo-standard test gate used by PR CI: `bun run test:ci` (`.github/workflows/test.yml:21`).
   - Ensure release validation gate remains green for these updates: `bun run lint:docs` + `bun test` (mirrors `.github/workflows/release.yml:68`, `.github/workflows/release.yml:77`).

## Acceptance Criteria

1. `install.sh` accepts `--port <number>`, includes it in help text, and forwards it to `openpalm install`.
2. `install.ps1` accepts a `Port` parameter, forwards it as `--port`, and exposes it in PowerShell help.
3. Wrappers print explicit recovery guidance for port-conflict failures without hiding original CLI errors.
4. `docs/cli.md` install options and wrapper usage examples include `--port`.
5. CLI/wrapper/docs tests are updated and pass in local runs and existing CI workflows.

## Out of Scope

- Changing CLI preflight taxonomy from message matching to typed preflight codes (separate P2 item).
- Broader setup reliability/runtime orchestration changes from other recommendations.
