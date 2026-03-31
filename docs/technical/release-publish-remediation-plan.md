# Release / Publish Remediation Plan (CLI + lib)

## Context

The `openpalm` npm package depends on `@openpalm/lib` at a matching semver floor. If the release workflow publishes CLI without publishing `@openpalm/lib` for the same release version, npm installs fail with `ETARGET` for the missing `@openpalm/lib` version.

This plan fixes the immediate breakage and removes policy drift between scripts, CI checks, workflow comments, and docs.

## Goals

1. Ensure every platform release publishes `@openpalm/lib` before `openpalm`.
2. Keep platform version synchronization explicit and enforced in CI.
3. Reduce contradictory release policy text across the repository.
4. Minimize workflow complexity and avoid introducing new custom tooling unless justified.

## Non-goals

- Rewriting the entire release workflow into a new orchestration model.
- Changing runtime architecture (CLI still consumes `@openpalm/lib` as the shared control-plane package).
- Adding a new package manager or lockfile scheme.

## High-priority fixes (implemented immediately)

1. **Publish `@openpalm/lib` in `release.yml`.**
   - Add a dedicated npm publish job (`publish-lib-npm`) mirroring existing publish job behavior.
   - Keep idempotent behavior for already-published versions.
2. **Gate CLI npm publish on lib publish.**
   - Add `publish-lib-npm` to `publish-cli-npm.needs`.
   - Guarantees dependency availability ordering for consumers.
3. **Promote `packages/lib` to platform-version sync checks.**
   - Include `packages/lib/package.json` in:
     - release version stamping/checking logic
     - CI platform version sync validation
     - local `scripts/bump-platform.sh`
4. **Align docs/comments to current behavior.**
   - Update package-management guidance and workflow comments to match actual release strategy.
5. **Standardize GitHub Actions Node runtime on Node 24.**
   - Update all `actions/setup-node` steps in release/CI/publish workflows from Node 22 to Node 24 for consistency with current runtime baseline.

## Next phase (implemented)

1. **Release preflight package availability check for CLI dependency**
   - Added an explicit preflight check before CLI publish to verify `@openpalm/lib@${VERSION}` is resolvable from npm.
   - This provides a fail-fast guard even if publish ordering or manual reruns drift.

## Medium-priority follow-ups

1. **Unify package-group metadata**
   - Introduce a single source of truth (JSON/TS config) for:
     - platform-synced packages
     - independently published packages
   - Reuse it from CI and release scripts to avoid list drift.
2. **Clarify assistant-tools/admin-tools strategy**
   - Decide whether they are platform-coupled or independently versioned.
   - Add explicit workflow(s) and matching docs once decided.

## Low-priority follow-ups

1. **Add smoke test for published CLI installability**
   - In release workflow, create temp project and run `npm install openpalm@${VERSION} --dry-run`.
   - Fail fast on dependency resolution errors.
2. **Consolidate publish job definitions**
   - Optionally migrate repetitive publish job bodies in `release.yml` to a reusable local workflow/composite action if repetition grows.
   - Keep complexity budget in check; avoid abstraction until duplication is materially painful.

## Risk assessment

- **Low risk:** Changes are release/pipeline metadata only; no runtime code path changes.
- **Main risk:** Tightening version sync to include `packages/lib` can fail release runs if versions are out of sync.
  - Mitigation: this is desired fail-fast behavior and prevents broken npm publishes.

## Validation checklist

1. `release.yml` contains `publish-lib-npm`.
2. `publish-cli-npm.needs` includes `publish-lib-npm`.
3. Release version stamping/checking lists include `packages/lib/package.json`.
4. CI platform sync check includes `packages/lib/package.json`.
5. `scripts/bump-platform.sh` updates `packages/lib/package.json`.
6. `actions/setup-node` is set to Node 24 across release/CI/publish workflows.
7. CLI publish includes an npm preflight check for `@openpalm/lib@${VERSION}` availability.
8. Docs/comments no longer contradict workflow behavior for lib/CLI/channels-sdk publication.
