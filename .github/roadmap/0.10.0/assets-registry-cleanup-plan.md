# OpenPalm 0.10.0 - Assets and Registry Cleanup Plan

## Summary

This plan cleans up the repo-level `assets/` and `registry/` directories so they match the 0.10.0 component model and the current filesystem contract.

The core problem is split responsibility:

- `assets/` currently mixes core stack bootstrap files, seeded OpenCode config, core automations, optional overlays, and legacy manual-setup examples.
- `registry/` currently mixes the intended `registry/components/` model with the deprecated flat `registry/channels/` model.
- code, scripts, tests, and docs still support both worlds at once, which creates duplicate files, duplicate install flows, and conflicting runtime assumptions.

The target outcome is:

- `assets/` contains only core stack artifacts and the schemas/examples needed to manually stand up the basic stack.
- `registry/` contains only optional/discoverable installables: `registry/components/` and `registry/automations/`.
- there is one canonical source for each artifact class.
- legacy channel-specific codepaths are removed rather than carried forward behind compatibility shims.

## Why this work is needed

The current repo conflicts with the accepted 0.10.0 direction in several places:

- the roadmap says the registry is moving from `registry/channels/` to `registry/components/` (`.github/roadmap/0.10.0/README.md:190`), but admin and lib code still read `registry/channels/` directly.
- the core principles say user config lives in `config/components/` and component composition is file-drop based (`docs/technical/authoritative/core-principles.md:43`, `docs/technical/authoritative/core-principles.md:96`), but older docs and APIs still describe `CONFIG_HOME/channels/` and flat channel overlays.
- `assets/README.md` still documents XDG-era staging, `secrets.env`, and channel installation from `registry/*.yml` (`assets/README.md:3`).
- `registry/README.md` documents the new component model but also keeps `registry/channels/` as a live legacy format (`registry/README.md:148`).

## Agent review outcome

Three independent review passes converged on the same core recommendations:

1. Freeze a strict ownership boundary: `assets = core bootstrap`, `registry = optional catalog`.
2. Remove `registry/channels/` rather than preserving it as a second-class supported path.
3. Collapse duplicated admin and lib codepaths so component discovery/install is the only installable-container model.
4. Delete duplicate artifacts instead of keeping "reference copies" in both directories.
5. Treat this as repo taxonomy plus control-plane simplification work, not just a file move.

## Non-negotiable principles

- `assets/` must be sufficient for a user to manually stand up the documented basic stack with no dependency on `registry/`.
- `registry/` must own optional and discoverable installables only.
- one artifact class gets one canonical repo location.
- no string templating or generated compose fragments; keep whole-file assembly and Compose-native merge behavior.
- all control-plane logic changes must land in `packages/lib/` first (`docs/technical/authoritative/core-principles.md:128`).
- no repo cleanup is complete until docs, tests, scripts, and API/UI code all reflect the same ownership model.

## Proposed target directory structure

```text
assets/
  core/
    compose/
      core.yml
      admin.yml
    caddy/
      Caddyfile
    assistant/
      AGENTS.md
      opencode.jsonc
    admin/
      opencode.jsonc
    automations/
      cleanup-data.yml
      cleanup-logs.yml
      validate-config.yml
  schemas/
    user.env.schema
    system.env.schema
    redact.env.schema
    setup-config.schema.json
  examples/
    user.env.example

registry/
  components/
    <component>/
      compose.yml
      .env.schema
      .caddy?
  automations/
    *.yml
```

Notes:

- `admin.yml` stays under `assets/` only if admin remains part of the documented basic stack; if admin becomes optional in the final 0.10 shape, it should move to `registry/components/admin/` instead.
- `ollama.yml` should not remain a top-level core asset unless it is part of the basic stack. Current recommendation: move it to `registry/components/ollama/`.
- core automations may stay in `assets/core/automations/` if they are seeded by default; if they are meant to be optional catalog items, keep them only in `registry/automations/`. Do not keep the same automation in both places.

## Pre-implementation decisions

These decisions should be made before file moves begin so implementation does not stall mid-refactor:

1. Is `admin.yml` part of the documented basic stack or an optional component overlay?
2. Is `ollama` a seeded built-in optional overlay or a normal registry component?
3. Are cleanup and validation automations seeded core defaults or optional catalog items?
4. Is `registry/components/index.json` a real generated artifact with a supported consumer path, or should it be removed along with its docs/tests?

The implementation issue should explicitly record the chosen answer for each item.

## Canonical ownership rules

### `assets/`

Keep only:

- base core compose file(s) required for manual bootstrap
- base Caddyfile for the core stack
- seeded assistant/admin OpenCode config that is part of the core installation contract
- env/schema files and config schemas required by the basic stack
- default core automations only if they are always seeded as part of core installation
- examples for manual setup aligned with the 0.10 `~/.openpalm/` contract

Remove or relocate:

- optional service overlays that are not part of the basic stack
- any legacy `secrets.env` artifact that still models the old contract
- any examples that describe `registry/*.yml`, `CONFIG_HOME/channels`, XDG roots, or staging artifacts

### `registry/`

Keep only:

- `registry/components/<id>/` component directories
- `registry/automations/*.yml` optional automations

Delete:

- `registry/channels/`
- docs or validation paths that preserve flat channel overlays as a supported repo format
- stale/generated metadata files that are not actually produced or consumed

## Catalog source and hydration model

The cleanup must make the repo catalog path explicit:

- repo source of truth for optional installables: `registry/components/` and `registry/automations/`
- runtime local catalog/cache: `~/.openpalm/data/catalog/` and `~/.cache/openpalm/registry/` where applicable
- user-owned enabled config: `~/.openpalm/config/components/` and `~/.openpalm/config/openpalm.yml`

Required follow-up:

1. Define how repo `registry/components/` entries become runtime catalog entries.
2. Move that logic into `packages/lib/` if it is reusable control-plane behavior.
3. Remove admin-only flat registry sync assumptions once component/catalog sync is the only supported path.

This is required because the current code already has a split between old flat registry loading and newer component/catalog flows.

## Duplicate and mislocated artifacts to fix

1. Remove duplicate `cleanup-logs.yml` ownership; it exists in both `assets/` and `registry/automations/`.
2. Replace `assets/secrets.env` with a 0.10-aligned example file under `assets/examples/` that models `vault/user.env` / `vault/system.env`, or remove it entirely if it is no longer needed.
3. Move `assets/ollama.yml` into `registry/components/ollama/` unless the basic stack explicitly includes Ollama.
4. Remove `registry/channels/*.yml` and `registry/channels/*.caddy` after the code and docs stop consuming them.
5. Drop any undocumented or unused generated registry metadata such as `registry/components/index.json` unless it is brought under a real generation/consumption flow.

## Implementation workstreams

### Workstream 1 - Repo taxonomy and file moves

Goal: make the repo tree itself express the correct ownership model.

Tasks:

1. Reorganize `assets/` into explicit subdirectories for core compose, Caddy, OpenCode seed files, schemas, and examples.
2. Move or delete optional overlays that do not belong in the core bootstrap set.
3. Remove duplicate automation files across `assets/` and `registry/automations/`.
4. Delete `registry/channels/` after the runtime and docs are migrated.
5. Update `assets/README.md` and `registry/README.md` to describe only the new structure.

### Workstream 2 - Shared lib and lifecycle simplification

Goal: remove channel-specific and flat-registry-specific control-plane logic.

Tasks:

1. Narrow `CoreAssetProvider` so it exposes only core/bootstrap artifacts (`packages/lib/src/control-plane/core-asset-provider.ts:8`).
2. Update core seeding and refresh lists in `packages/lib/src/control-plane/core-assets.ts:255` and `packages/lib/src/control-plane/core-assets.ts:275` to match the new asset taxonomy.
3. Redesign the registry abstraction itself so it is component/catalog-shaped instead of channel-shaped (`packages/lib/src/control-plane/registry-provider.ts:8`, `packages/lib/src/control-plane/fs-registry-provider.ts:11`).
4. Explicitly converge the two lifecycle models currently present in lib: old channel-overlay assembly and new instance-based component assembly.
5. Stop special-casing channel overlays in compose assembly and managed-service calculation (`packages/lib/src/control-plane/lifecycle.ts:264`, `packages/lib/src/control-plane/lifecycle.ts:293`).
6. Remove legacy channel overlay discovery/install flows from `packages/lib/src/control-plane/channels.ts:24` once component-only install paths exist.
7. Update route staging to operate on component instances with optional `.caddy`, not only channel overlays (`packages/lib/src/control-plane/staging.ts:129`).

### Workstream 3 - Admin/API/registry simplification

Goal: make admin use one installable-container model and remove flat-channel registry support.

Tasks:

1. Replace Vite-bundled flat channel registry imports in `packages/admin/src/lib/server/vite-registry-provider.ts:11`.
2. Replace cloned-registry flat channel discovery in `packages/admin/src/lib/server/registry-sync.ts:140`.
3. Collapse `/admin/channels/*` and `/admin/registry/*` duplication into component-oriented routes.
4. Remove backward-compatible `REGISTRY_CHANNEL_*` exports and deprecated wrappers once consumers are migrated.
5. Ensure admin component install/list/status flows align with the `registry/components/` contract only.
6. Update admin-tools and client API code that still speaks in channel-specific terms.

### Workstream 4 - CLI, scripts, and CI

Goal: make install/update/dev tooling reflect the new boundaries.

Tasks:

1. Stop assuming every downloadable managed file lives at `assets/<filename>` in install/update code (`packages/cli/src/lib/docker.ts:72`, `packages/cli/src/commands/install.ts:132`).
2. Update install/setup to fetch or seed only core assets from `assets/`.
3. Update bootstrap, dev, release, and upgrade scripts that still assume `secrets.env`, `CONFIG_HOME/channels/`, flat registry files, or staged artifacts.
4. Update `scripts/dev-setup.sh` to stop copying legacy `secrets.env` and other old-layout files.
5. Update `scripts/validate-registry.sh` and CI to validate both `registry/components/` and `registry/automations/` explicitly.
6. Remove CI validation or fixture support for flat `registry/channels/` files.

### Workstream 5 - Tests and docs

Goal: remove split-brain documentation and test assumptions.

Tasks:

1. Rewrite `assets/README.md` to describe the core-only bootstrap role.
2. Rewrite `registry/README.md` to remove the legacy channel section.
3. Update docs that still describe `CONFIG_HOME/channels/`, `registry/*.yml`, XDG roots, `secrets.env`, or staged artifacts, including API docs, manual setup docs, managing docs, channel docs, and package READMEs.
4. Rewrite tests that seed, discover, install, refresh, or validate flat channel files.
5. Add coverage that asserts the new asset/registry taxonomy, the runtime catalog hydration path, and the absence of duplicate ownership.

### Workstream 6 - Migration and deprecation handling

Goal: remove legacy runtime paths without breaking supported 0.10 migration flows.

Tasks:

1. Distinguish runtime removal from migration support: legacy `CONFIG_HOME/channels/` may still appear in migration helpers and upgrade tests until migration support is retired, but it must no longer be an active runtime/control-plane path.
2. Add explicit upgrade detection for installs still using flat channel artifacts and fail loudly with migration guidance instead of silently half-working.
3. Update migrate/upgrade tests to validate the transition from legacy channel installs to the component/catalog model.
4. Document API deprecation behavior for any removed or redirected admin routes.
5. Ensure asset path changes have a rollback-safe manifest or typed map so install/update failures can be diagnosed cleanly.

## Recommended implementation order

1. Freeze the ownership contract in docs and the plan.
2. Remove legacy flat registry readers/writers from lib and admin behind a component-only abstraction.
3. Simplify compose/Caddy lifecycle logic to stop treating channels as a separate artifact class.
4. Move/delete files in `assets/` and `registry/` to match the new contract.
5. Update install/dev/refresh tooling and CI.
6. Rewrite docs and tests last, then do a final duplicate-file and dead-code sweep.

## Acceptance criteria

- a user can manually bootstrap the basic stack using only files documented under `assets/`.
- every optional installable lives in exactly one canonical repo location under `registry/`.
- `registry/channels/` no longer exists and no shipping code references it.
- no shipping code references `CONFIG_HOME/channels/` as the active install model.
- `packages/lib/` is the only place that owns artifact discovery, install, validation, compose assembly, and refresh logic.
- no duplicate files remain between `assets/` and `registry/`.
- docs, tests, scripts, and admin/CLI behavior all describe the same repo taxonomy.
- the repo has an explicit, documented catalog hydration path from repo `registry/` to runtime catalog/config locations.
- legacy `CONFIG_HOME/channels/` references remain only in migration helpers, legacy-detection code, or regression tests while 0.10 migration support exists; they are not part of the active runtime path.

## Risks and mitigation

- Breaking admin install/refresh flows too early: migrate code before deleting `registry/channels/`.
- Breaking install/update downloads by changing asset paths: introduce a manifest or typed asset map before moving files.
- Treating optional overlays as core because they were historically seeded from `assets/`: make a conscious keep/move decision for `admin.yml`, `ollama.yml`, and core automations.
- Breaking runtime catalog sync during transition: define the repo-to-catalog hydration model before removing registry-sync code.
- Leaving compatibility shims behind: explicitly delete deprecated wrappers and exports after the new flows land.
- Docs drift: require final doc updates as part of the same workstream, not follow-up cleanup.
- `redact.env.schema` drift: decide whether it remains a generated asset, a release artifact, or a build-time output and document that choice.

## Recommended issue split

The work is large enough that implementation should likely be broken into dependent PRs/issues, even if tracked by one umbrella issue:

1. Repo taxonomy and duplicate-file removal
2. Control-plane simplification in `packages/lib/`
3. Admin/API/registry cleanup and legacy channel removal
4. CLI/scripts/CI updates
5. Docs and tests sweep

## Key references

- `docs/technical/authoritative/core-principles.md:38` - config ownership and component-based stack config
- `docs/technical/authoritative/core-principles.md:95` - Compose multi-file component model
- `docs/technical/authoritative/core-principles.md:128` - lib-first control-plane rule
- `.github/roadmap/0.10.0/README.md:25` - component directory contract
- `.github/roadmap/0.10.0/README.md:190` - registry migration to `registry/components/`
- `assets/README.md:3` - current outdated role description for `assets/`
- `registry/README.md:148` - legacy `registry/channels/` still documented
- `packages/lib/src/control-plane/core-assets.ts:255` - core automations seeded from assets
- `packages/lib/src/control-plane/core-assets.ts:275` - current managed-asset list still includes optional overlays
- `packages/lib/src/control-plane/registry-provider.ts:8` - current channel-shaped registry abstraction
- `packages/lib/src/control-plane/lifecycle.ts:264` - compose file list still special-cases channels
- `packages/admin/src/lib/server/vite-registry-provider.ts:11` - build-time flat channel registry imports
- `packages/admin/src/lib/server/registry-sync.ts:140` - runtime flat channel registry sync
