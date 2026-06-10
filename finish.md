# Finish Plan

## Goal

Close the highest-value remaining work in this repo without reopening settled architecture. The workspace already shows three strong signals:

1. AKM host-sharing/build simplification is approved but not fully finished.
2. A legacy-cleanup pass has identified a small set of real bugs and a larger set of safe cleanup tasks.
3. `0.12.x` is intended to be a stabilization release, so the finish line should emphasize correctness, simplification, and verification over new feature sprawl.

## Scope To Finish First

### 1. Ship the remaining approved simplifications

Use `docs/technical/akm-and-build-simplification-proposals.md` as the source of truth and finish the three approved workstreams in this order:

1. **P1: always-mounted host AKM path**
2. **P3: Electron prefers bundled UI with version-aware fallback policy**
3. **P2: stop reseeding the full skeleton on every Electron launch**

Why this order:

- P1 removes the most brittle AKM complexity.
- P3 removes user-visible stale-UI risk.
- P2 becomes lower-risk once the overlay/materialization path is gone.

### 2. Fix the known functional regressions from legacy cleanup

From `docs/operations/legacy-cleanup-0.11.0.md`, do the real bugs before broad cleanup:

1. Fix `packages/lib/src/control-plane/lifecycle.ts` so update detection checks a currently published image, not the retired `admin` repo.
2. Fix `scripts/dev-e2e-test.sh` to authenticate with the cookie login flow instead of the removed `x-admin-token` header.
3. Fix `docs/installation.md` so it does not tell users to put secrets in `stack.env`.

These are small, high-confidence, and immediately reduce operator breakage.

## Execution Plan

### Phase A. Simplify host AKM sharing

1. Remove `.openpalm/config/stack/host-akm.compose.yml`.
2. Add a permanent `/host-stash` mount in `.openpalm/config/stack/core.compose.yml`.
3. Ensure setup/home-dir creation always writes `OP_HOST_AKM_STASH` and creates an empty fallback directory when host AKM is not present.
4. Reduce host-sharing enable/disable to one operation: add or remove the `host-akm` source entry in `OP_HOME/config/akm/config.json`.
5. Keep the default behavior asymmetric unless the code proves otherwise: assistant reads host stash; do not reintroduce automatic mutation of the user's host AKM config.

Acceptance:

- No overlay file or overlay detection branch remains.
- Host-sharing state is driven by AKM config source entries, not compose materialization.
- Setup works whether host AKM is present or absent.

### Phase B. Fix Electron UI delivery

1. Update the UI build resolver so Electron prefers the bundled UI when the bundled build is current.
2. Keep `data/ui` only as the host/CLI update channel.
3. Add a clear version/completeness check so stale or partial `data/ui` content cannot silently shadow a valid bundled build.

Acceptance:

- A fresh Electron launch does not serve an older cached UI over a newer bundled UI.
- Offline Electron startup still works from bundled assets.

### Phase C. Stop whole-tree reseeding on every Electron launch

1. Add a version stamp for skeleton seeding.
2. Seed the full skeleton only on first install or version change.
3. Separate registry refresh from broad skeleton copy.

Acceptance:

- Launching Electron repeatedly on the same version does not re-copy the full skeleton.
- User-removed optional files are not resurrected during normal startup.

### Phase D. Resolve the remaining real bugs

1. Update-image detection points at a live published image and has test coverage.
2. Dev E2E script logs in via `/admin/auth/login`, persists `op_session`, and uses the cookie jar for follow-up admin requests.
3. Installation docs align with the current secret boundary: secrets in `knowledge/secrets/*`, not `stack.env`.

Acceptance:

- Update checks work against current release artifacts.
- Dev E2E passes auth against the current UI/server behavior.
- Docs no longer direct users into an unsafe or invalid secret path.

### Phase E. Do the safe cleanup pass

After Phases A-D, take the high-confidence cleanup items from `docs/operations/legacy-cleanup-0.11.0.md` in small batches:

1. Remove dead exports and unused params.
2. Remove orphaned skeleton and `.dockerignore` residue.
3. Finish the visible `admin token` -> `password` copy cleanup.
4. Repair stale doc links and outdated architecture references.
5. Clean up script and CI loose ends that no longer match the shipped architecture.

Rule: keep each batch narrow and verifiable. Avoid mixing behavior changes with doc-only cleanup unless they are directly coupled.

## Verification

Run the smallest checks that prove each phase is actually complete:

1. `bun run ui:check`
2. `bun run test`
3. `bun run electron:test`
4. Focused tests for any touched package (`bun run cli:test`, `bun run lib:test`, `bun run guardian:test`, UI vitest/playwright slices as needed)
5. Manual Electron smoke test for startup, setup, UI resolution, and AKM host-sharing toggles

## Finish Criteria

This work is finished when all of the following are true:

1. The approved AKM/Electron simplification work is implemented with no overlay-driven host-sharing complexity left.
2. The legacy cleanup document's three functional bugs are closed.
3. Electron startup no longer risks stale bundled-vs-cached UI behavior.
4. Skeleton reseeding is version-bounded instead of per-launch.
5. The remaining cleanup list is reduced to non-blocking polish, not correctness issues.
6. Verification passes and the resulting behavior still complies with `docs/technical/core-principles.md`.
