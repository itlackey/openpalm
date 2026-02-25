# Implementation Plan: Install Idempotency Metadata (P4)

## Objective

Replace compose-content heuristics in install idempotency detection with an explicit persisted metadata record so reinstall/update guidance is deterministic, migration-safe, and testable.

This plan implements recommendation **P4** from `dev/docs/install-setup-simplification-reliability-report-consolidated.md:374` and closes the OPEN status at `dev/docs/install-setup-simplification-reliability-report-consolidated.md:32`.

## Current Baseline (File:Line References)

- Install idempotency currently checks for `gateway:` and `assistant:` substrings in `STATE/docker-compose.yml` (`packages/cli/src/commands/install.ts:125`, `packages/cli/src/commands/install.ts:132`), then prompts at `packages/cli/src/commands/install.ts:142`.
- Installer state files already live in XDG state home (`packages/lib/src/paths.ts:24`, `packages/lib/src/config.ts:12`, `packages/cli/src/commands/install.ts:126`).
- Install currently rewrites setup bootstrap artifacts and resets setup state (`packages/cli/src/commands/install.ts:238`, `packages/cli/src/commands/install.ts:305`).
- `setup.complete` is the runtime transition that marks setup finished (`packages/ui/src/routes/command/+server.ts:348`, `packages/ui/src/routes/command/+server.ts:362`).
- Uninstall removes entire state directory when `--remove-all` is used (`packages/cli/src/commands/uninstall.ts:96`, `packages/cli/src/commands/uninstall.ts:110`).

## Metadata Schema

Store install metadata at:

- `${OPENPALM_STATE_HOME}/install-metadata.json`

Proposed v1 schema (typed in lib, JSON on disk):

```json
{
  "schemaVersion": 1,
  "install": {
    "mode": "bootstrap_only",
    "installedAt": "2026-02-25T18:44:12.123Z",
    "updatedAt": "2026-02-25T18:44:12.123Z",
    "openpalmVersion": "0.4.0",
    "runtime": "docker",
    "ingressPort": 80,
    "source": "installer"
  },
  "history": {
    "lastCommand": "install",
    "lastOutcome": "success"
  }
}
```

### Field rules

- `schemaVersion`: integer for forward migrations (start at `1`).
- `install.mode`: enum:
  - `bootstrap_only` (installer ran; wizard not completed yet)
  - `configured` (setup completed and runtime convergence path succeeded)
  - `unknown_legacy` (backfilled from heuristics; confidence-limited)
- `install.installedAt`: first successful write time; never overwritten.
- `install.updatedAt`: updated on each successful lifecycle transition.
- `install.openpalmVersion`: CLI package version at last successful transition.
- `install.runtime` / `install.ingressPort`: record operator-visible install intent.
- `install.source`: `installer` or `heuristic_migration`.
- `history.lastCommand` and `history.lastOutcome`: user-facing prompt context and debugging.

## Lifecycle Rules (Authoritative State Machine)

1. **Fresh install success**
   - After bootstrap services are successfully started (`compose up caddy admin` path in `packages/cli/src/commands/install.ts:305`), write metadata with `mode=bootstrap_only`, `source=installer`.
2. **Setup completion success**
   - After `setup.complete` successful completion (`packages/ui/src/routes/command/+server.ts:362`), update metadata to `mode=configured`, refresh `updatedAt`, `openpalmVersion` if available to server runtime.
3. **`openpalm update` success**
   - Keep mode unchanged; update `updatedAt`, `openpalmVersion`, `history.lastCommand=update` (`packages/cli/src/commands/update.ts:5`).
4. **Install with `--force`**
   - Allowed regardless of mode; metadata is overwritten only after successful install flow.
5. **Uninstall `--remove-all`**
   - Metadata is removed as part of state directory deletion (`packages/cli/src/commands/uninstall.ts:110`).
6. **Failed lifecycle action**
   - Never promote mode on failure; set `history.lastOutcome=failed` when safe.

## Migration Path from Heuristics

### Phase 1 (compatibility-on)

1. On install start, attempt to read `install-metadata.json`.
2. If metadata exists and validates, use it exclusively for prompt selection.
3. If metadata is missing/invalid:
   - run existing compose-content heuristic (`packages/cli/src/commands/install.ts:132`) as fallback,
   - derive best-effort mode:
     - heuristic says full stack -> `unknown_legacy`
     - heuristic says not installed -> no metadata yet.
4. If heuristic indicates prior install, write backfilled metadata with `source=heuristic_migration` before prompting.

### Phase 2 (post-migration hardening)

1. Keep heuristic only as a guarded fallback for one release.
2. Add warning telemetry/log line when fallback path is used.
3. After one stable release, remove compose substring heuristic and rely on metadata + explicit absence semantics.

## UX Prompt Design

Replace one generic warning with mode-aware prompts:

1. **`mode=configured`**
   - "OpenPalm is already configured (installed <timestamp>, version <v>)."
   - Actions: `openpalm update` (recommended), `openpalm install --force` (destructive reinstall).
2. **`mode=bootstrap_only`**
   - "OpenPalm bootstrap is installed but setup is not complete."
   - Actions: open wizard URL / continue setup, or force reinstall.
3. **`mode=unknown_legacy`**
   - "Legacy install detected from existing state files."
   - Actions: `openpalm update` (safe path), `--force` for clean reinstall.
4. **Corrupt metadata**
   - "Install metadata is unreadable; using compatibility checks."
   - Automatically back up bad file to `install-metadata.json.bak.<timestamp>` and continue.

Prompt plumbing should stay in CLI install command surface (`packages/cli/src/commands/install.ts:125`) to preserve scriptability and explicit operator intent.

## Implementation Changes

### Code

1. Add typed metadata contracts in `packages/lib/src/types.ts:51` (or adjacent new types module).
2. Add metadata IO helper in lib (new `packages/lib/src/install-metadata.ts`):
   - `readInstallMetadata(xdgStatePath)`
   - `writeInstallMetadataAtomic(...)`
   - `migrateLegacyInstallMetadata(...)`
3. Refactor idempotency guard in `packages/cli/src/commands/install.ts:125` to use metadata-first prompt selection.
4. Write metadata on successful install bootstrap in `packages/cli/src/commands/install.ts` after core service startup succeeds.
5. Update metadata from setup completion path in `packages/ui/src/routes/command/+server.ts:348` (or shared completion orchestrator if introduced by P1/P2 work).
6. Update update command to refresh metadata post-success (`packages/cli/src/commands/update.ts:5`).
7. Ensure uninstall behavior is documented as metadata cleanup by virtue of state directory removal (`packages/cli/src/commands/uninstall.ts:110`).

### Docs

1. Document metadata-driven idempotency in `docs/cli.md:125` (Install step table) and install command behavior section at `docs/cli.md:36`.
2. Add operational note in `docs/troubleshooting.md` for corrupt/missing metadata recovery.
3. Mark P4 complete in `dev/docs/install-setup-simplification-reliability-report-consolidated.md:32` and link implementation files.
4. Add developer contract note in `dev/docs/api-reference.md` for setup completion metadata transition if server path updates metadata.

### Tests

1. Add unit tests for metadata parsing, validation, atomic writes, and migration fallback (new `packages/lib/src/install-metadata.test.ts`).
2. Extend install command tests to assert metadata-first prompt branches (e.g., `packages/cli/test/install.test.ts:7`).
3. Extend command API tests so `setup.complete` promotes metadata mode to `configured` (`packages/ui/test/api/08-command-api.test.ts:40`).
4. Add regression test for corrupt metadata backup + heuristic fallback behavior.
5. Add uninstall remove-all regression ensuring metadata file is deleted with state tree (`packages/cli/test/uninstall-extensions.test.ts` or a new uninstall-focused test file).

### Scripts / CI

1. Add a small migration utility for dev/CI fixtures (new `dev/scripts/migrate-install-metadata.ts`) to backfill metadata in fixture state dirs used by install E2E.
2. Add root script alias (in `package.json:20`) for local verification, e.g. `test:install:metadata` running targeted lib/cli/ui tests.
3. Update release gate smoke workflow to include one run with pre-existing metadata fixture and one legacy-without-metadata fixture (`.github/workflows/release.yml:161`).

## Rollback Handling

1. **Atomic persistence**
   - Write to `install-metadata.json.tmp` then rename, to avoid partial files.
2. **Read-time resilience**
   - Invalid JSON or schema mismatch must not block install/update; warn, back up file, and continue with compatibility fallback.
3. **Behavioral rollback flag**
   - Keep compatibility fallback path for one release (metadata read failure -> old heuristic prompt logic) to allow safe rollback without blocking installs.
4. **Release rollback**
   - If regression appears, revert metadata usage in prompt decision while leaving file writes harmless; schema remains forward-compatible.
5. **No destructive cleanup on failures**
   - Never delete existing compose/env artifacts just because metadata parse fails.

## Verification Plan

### Automated

1. `bun test packages/lib/src/install-metadata.test.ts`
2. `bun test packages/cli/test/install.test.ts`
3. `bun test packages/ui/test/api/08-command-api.test.ts`
4. `bun test packages/cli/test/main.test.ts`
5. `bun run test:install:smoke` (ensure install+wizard path still works)

### Scenario matrix

1. Fresh machine, no metadata -> install succeeds, file created, mode `bootstrap_only`.
2. Existing configured metadata -> install shows update/reinstall guidance without compose substring checks.
3. Legacy full-stack compose but no metadata -> migration writes `unknown_legacy` and prompts once.
4. Corrupt metadata -> backup created, fallback path used, install remains operable.
5. Setup complete after install -> metadata flips to `configured`.
6. `openpalm uninstall --remove-all` -> metadata file removed with state directory.

## Done Criteria

1. Install idempotency prompts are driven by metadata, not compose-content substring heuristics, in normal operation.
2. Legacy installs are migrated safely with explicit fallback and no install dead-ends.
3. Metadata lifecycle is updated by install, setup completion, update, and uninstall flows.
4. Docs and release report reflect the new contract and P4 completion.
5. CI covers fresh, migrated, and corrupt-metadata scenarios.
