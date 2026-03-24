# P1-3 Implementation Plan: Standardize Stack Spec Parsing and Remove Legacy Ad-Hoc YAML Parsing

Date: 2026-03-24  
Backlog item: `P1-3` in `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:189`

## Scope

This plan covers the remaining P1-3 work now that `.openpalm/stack/start.sh` is already deleted.

- Focus: parser consistency and compatibility handling across `@openpalm/lib`, CLI, and admin.
- Non-goals: changing Docker Compose semantics or reintroducing script-level orchestration.

## Current State and Drift Points (with exact refs)

## Canonical parser exists but is strict and thin

- `packages/lib/src/control-plane/stack-spec.ts:144` reads `stack.yaml` and returns `null` for non-v2 specs.
- `packages/lib/src/control-plane/stack-spec.ts:156` hard-rejects any `version !== 2`.
- `packages/lib/src/control-plane/stack-spec.ts:158` auto-defaults only `addons`, with no broader normalization/migration.

## Core orchestration depends on parsed spec for addon resolution

- `packages/lib/src/control-plane/lifecycle.ts:244` builds compose file list using parsed stack spec.
- `packages/lib/src/control-plane/lifecycle.ts:254` resolves enabled addon overlays from `spec.addons`.
- `packages/lib/src/control-plane/lifecycle.ts:266` derives managed services from compose + stack spec fallback.

## Admin mutators/readers depend on strict parser behavior

- `packages/admin/src/routes/admin/addons/+server.ts:109` fails on missing/invalid `stack.yaml`.
- `packages/admin/src/routes/admin/addons/[name]/+server.ts:95` same behavior for single-addon updates.
- `packages/admin/src/routes/admin/connections/+server.ts:54` and `packages/admin/src/routes/admin/connections/+server.ts:110` read/write through current parser contract.
- `packages/admin/src/routes/admin/connections/assignments/+server.ts:156` and `packages/admin/src/routes/admin/connections/assignments/+server.ts:180` same strict dependency.

## Compatibility gap is visible in tests

- `packages/lib/src/control-plane/install-edge-cases.test.ts:551` currently expects v1 specs to return `null`.
- `packages/lib/src/control-plane/install-edge-cases.test.ts:557` asserts no compatibility behavior exists.

## Implementation Strategy

## 1) Build one lib-owned stack spec normalization pipeline

Create a single parser entrypoint in lib that all consumers use for addon/capability resolution.

Planned changes:

- Extend `packages/lib/src/control-plane/stack-spec.ts` with a normalized read path, for example:
  - `readStackSpecWithDiagnostics(configDir)` -> `{ spec, format, migrated, warnings }`
  - `normalizeLegacyStackSpec(raw)` for legacy shapes.
- Keep `readStackSpec(configDir)` for compatibility, but make it a thin wrapper over normalized parsing.
- Add hard shape guards before casting (replace direct `as StackSpec` return at `packages/lib/src/control-plane/stack-spec.ts:159`).

Compatibility targets to support:

- Legacy `addons` list shape (array/string list) -> normalized to `Record<string, boolean | { env }>`.
- Missing optional fields -> normalized defaults (for example `addons: {}`) without silent data loss.
- Legacy top-level keys that can be mapped safely (read-compatible) without expanding architecture.
- Version handling:
  - Keep explicit rejection for un-migratable specs.
  - Add deterministic migration path for safely mappable legacy documents.

Guardrail: no parser forks in CLI/admin; parsing logic stays in lib only.

## 2) Add explicit migration/compatibility writer in lib

Add one migration helper in lib that can rewrite legacy-but-mappable files to canonical v2.

Planned API:

- `migrateStackSpecIfNeeded(configDir, opts?)` in `packages/lib/src/control-plane/stack-spec.ts` or a focused companion module.
- Returns structured outcome (`noop`, `migrated`, `rejected`) with warnings/reason codes.

When invoked:

- During lib lifecycle setup paths before compose file resolution:
  - `packages/lib/src/control-plane/lifecycle.ts:244`
  - `packages/lib/src/control-plane/lifecycle.ts:266`
- During setup finalize path:
  - `packages/lib/src/control-plane/setup.ts:173`

Behavior rules:

- Non-destructive by default: back up original file before rewrite when migration occurs.
- Deterministic YAML output by reusing `writeStackSpec` (`packages/lib/src/control-plane/stack-spec.ts:135`).
- No silent rewrite on invalid/unmappable input; return actionable error.

## 3) Standardize addon resolution to parser output only

Ensure every addon selection path (compose overlays, managed services, admin addon routes) is driven from normalized lib parser output.

Planned edits:

- Keep `buildComposeFileList` in lib as the sole addon overlay resolver (`packages/lib/src/control-plane/lifecycle.ts:244`).
- Ensure it consumes normalized parser result, not raw object assumptions.
- Ensure `buildManagedServices` fallback (`packages/lib/src/control-plane/lifecycle.ts:278`) uses normalized addon names only.
- Ensure admin addon routes use the same normalized semantics via `readStackSpec`/migration path before mutate:
  - `packages/admin/src/routes/admin/addons/+server.ts:109`
  - `packages/admin/src/routes/admin/addons/[name]/+server.ts:95`

## 4) CLI compatibility handling and failure messaging

CLI should not parse stack spec directly, but should surface consistent migration/parse outcomes from lib.

Planned changes:

- Add migration check in CLI state bootstrap path:
  - `packages/cli/src/lib/cli-state.ts:22`
- Preserve no-ad-hoc-parser rule in CLI command layer:
  - `packages/cli/src/commands/install.ts` (no new stack.yaml YAML parse in command code).
- On un-migratable spec, return a clear error that includes:
  - reason code,
  - file path (`config/stack.yaml`),
  - remediation instructions.

## 5) Admin compatibility handling for API-driven writes

Admin write routes should trigger migration-on-write if legacy-but-mappable shape is detected.

Planned behavior:

- Before mutating addon/capability state, run lib migration helper and proceed on success.
- If migration fails, return `400 bad_request` for user-fixable shape issues and `500` only for true internal failures.

Primary routes:

- `packages/admin/src/routes/admin/addons/+server.ts:84`
- `packages/admin/src/routes/admin/addons/[name]/+server.ts:74`
- `packages/admin/src/routes/admin/connections/+server.ts:64`
- `packages/admin/src/routes/admin/connections/assignments/+server.ts:161`

## 6) Complexity controls (explicit)

Unjustified complexity to avoid:

- Do not create separate compatibility parsers per consumer.
- Do not introduce multiple migration formats or version-specific route logic.
- Do not add broad YAML parsing in CLI/admin transport layers.

Allowed complexity (justified):

- One lib normalization + migration path with diagnostics.
- One-time migration backup/write path for safe legacy conversion.

## File-Level Change Plan

## Lib (source of truth)

- `packages/lib/src/control-plane/stack-spec.ts:144`
  - Introduce normalized parse result and compatibility mapping.
- `packages/lib/src/control-plane/stack-spec.ts:156`
  - Replace strict immediate reject with migrate-or-reject decision.
- `packages/lib/src/control-plane/lifecycle.ts:244`
  - Ensure compose file list uses normalized/migrated spec read.
- `packages/lib/src/control-plane/lifecycle.ts:266`
  - Ensure managed service fallback uses normalized addon set.
- `packages/lib/src/control-plane/setup.ts:173`
  - Ensure setup writes canonical v2 and does not regress compatibility output.
- `packages/lib/src/index.ts:259`
  - Export new migration/diagnostic APIs for CLI/admin.

## CLI (thin consumer)

- `packages/cli/src/lib/cli-state.ts:22`
  - Invoke shared migration/diagnostic API during state bootstrap.
- `packages/cli/src/lib/cli-compose.ts:24`
  - Keep addon/compose resolution via lib-only output (no local spec parsing).

## Admin (thin consumer)

- `packages/admin/src/routes/admin/addons/+server.ts:109`
- `packages/admin/src/routes/admin/addons/[name]/+server.ts:95`
- `packages/admin/src/routes/admin/connections/+server.ts:54`
- `packages/admin/src/routes/admin/connections/assignments/+server.ts:156`
  - Use lib migration/diagnostic path before read/write operations and return consistent error mapping.

## Tests Plan

## New/expanded lib tests

- `packages/lib/src/control-plane/stack-spec.test.ts` (new)
  - v2 canonical parse remains stable.
  - legacy addon list/object variants normalize correctly.
  - unmappable legacy shape returns structured failure.
  - migration rewrite produces canonical v2 YAML.
- `packages/lib/src/control-plane/install-edge-cases.test.ts:551`
  - Replace current "v1 returns null" assertion with migrate-or-reject assertions.
- `packages/lib/src/control-plane/lifecycle.test.ts` (or add if absent)
  - same legacy `stack.yaml` yields identical compose file list and managed service set after normalization.

## Admin tests

- `packages/admin/src/lib/server/lifecycle.test.ts:87`
  - add fixture coverage for legacy stack spec shapes used in compose file selection.
- `packages/admin/src/routes/admin/addons/[name]/server.test.ts` (new if needed)
  - verify legacy spec is migrated (or cleanly rejected) before addon mutation.
- `packages/admin/src/routes/admin/connections/assignments/server.test.ts:120`
  - verify capability updates work after compatibility normalization path.

## CLI tests

- `packages/cli/src/install-flow.test.ts:198`
  - add legacy `stack.yaml` fixture case and verify normalized addon result consistency.
- `packages/cli/src/main.test.ts` (target parser/migration error messaging path)
  - verify actionable error output when spec is unmappable.

## Docs Updates

Update docs to match finalized parser/migration behavior and remove any stale implication of non-canonical stack spec handling.

- `docs/technical/api-spec.md:98`
  - document that admin mutation endpoints normalize/migrate legacy stack spec shapes via lib before write.
- `docs/managing-openpalm.md:136`
  - clarify addon updates are persisted in canonical v2 stack spec format.
- `docs/technical/manual-setup.md:119`
  - keep "compose files are deployment truth" wording, but add note that CLI/admin still use `config/stack.yaml` for addon metadata and normalize legacy forms.
- `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:189`
  - optionally annotate completion notes once shipped.

## Verification Commands

Run after implementation:

- `cd packages/lib && bun test`
- `cd packages/cli && bun test`
- `cd packages/admin && npm run check`
- `cd packages/admin && bun test`
- `cd core/guardian && bun test`

Targeted validation commands:

- `cd packages/lib && bun test src/control-plane/stack-spec.test.ts`
- `cd packages/admin && bun test src/lib/server/lifecycle.test.ts`
- `cd packages/cli && bun test src/install-flow.test.ts`

## Acceptance Criteria Mapping (P1-3)

- Same `stack.yaml` yields same addon set in all supported orchestration paths:
  - achieved by single lib parser+normalizer and shared compose/addon resolution.
- Legacy ad-hoc parsing path remains removed:
  - no reintroduction of script parsing; no CLI/admin parser forks.
- Migration/compatibility is explicit and test-covered:
  - migrate-or-reject behavior is deterministic with actionable diagnostics.
