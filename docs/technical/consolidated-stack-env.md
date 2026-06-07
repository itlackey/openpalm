# Design: consolidate stack composition + versions into `stack.env`; drop `stack.yml`

**Status:** proposed (0.12.0). **Author:** design pass.
**Related:** the 0.10→0.11 migration harness design, issue #440 (launch/status), the
0.10→0.11 upgrade guide + scripts.

## Goal

Make `knowledge/env/stack.env` the **single authoritative host-side record of the
stack's composition and versions** — image tag, on-disk layout version, UI build
version, and which addons are enabled — and **remove `config/stack/stack.yml`**
entirely. Today these are scattered across `stack.yml` (`version` + `addons[]`),
on-disk stamps (`.skeleton-version`, `.openpalm-ui-version`), and a Dockerfile/image
baked layer. One file should answer "what is this stack, and at what versions?".

## Scope decisions

- **Addon enablement moves into `stack.env`** as `OP_ENABLED_ADDONS` (a
  comma-separated list). Today it lives in `stack.yml` `addons[]` — this is the
  state that actually makes `stack.yml` non-vestigial, so relocating it is what
  unblocks dropping the file.
- **Image-baked tool versions (OpenCode, akm-cli, bun, gws) are OUT OF SCOPE for
  now.** They are Dockerfile `ARG`s baked into the image at build time; the host
  cannot change them, only *record* them. Recording them in `stack.env` invites
  drift unless sourced from a release manifest — deferred to a later pass
  (a versions-manifest shipped with core assets). Until then they continue to be
  reported from the image/Dockerfile as today.
- **`stack.yml` is removed** (not kept as a fallback). The migration harness
  converts existing installs; there is no runtime back-compat read of `stack.yml`
  (consistent with the project's no-migration-shim rule — the harness *is* the
  sanctioned migration path).

## Host-controlled vs build-time versions (why the split)

| Version | Control | In `stack.env`? |
|---|---|---|
| `OP_IMAGE_TAG` | host — selects all server images | yes (already) |
| layout (`OP_LAYOUT_VERSION`) | host — migration harness | yes (new) |
| UI build (`OP_UI_VERSION`) | host — npm, independent of image | yes (new) |
| enabled addons (`OP_ENABLED_ADDONS`) | host — compose profiles | yes (new; was `stack.yml`) |
| OpenCode / akm-cli / bun / gws | **build-time, baked into the image** | **no (deferred)** — fixed by `OP_IMAGE_TAG` |

`stack.env` is authoritative *and controlling* for the host-controlled rows. For
the build-time rows it could only ever be a *record*, so it is omitted until a
release manifest can source it truthfully.

## Consolidated `stack.env` (target)

```ini
# ── platform composition + versions (authoritative) ──
OP_IMAGE_TAG=0.11.0            # selects assistant/guardian/channel/voice images
OP_LAYOUT_VERSION=1           # on-disk home layout schema (migration-harness gate)
OP_UI_VERSION=0.11.0          # host UI build (npm), independent of OP_IMAGE_TAG
OP_ENABLED_ADDONS=voice,discord  # was stack.yml addons[] → compose --profile addon.<name>
OP_SETUP_COMPLETE=true
# … existing non-secret runtime config (ports, paths, profiles) unchanged …
```

`OP_ENABLED_ADDONS` rules (port the existing `stack.yml` validation): comma-split,
trim, validate each against `^[a-z0-9][a-z0-9-]{0,62}$`, dedupe, sort; empty/absent
= no addons.

## What is removed / replaced

**Removed:**
- `config/stack/stack.yml` (the file) + its skeleton seed.
- `packages/lib/src/control-plane/stack-spec.ts`: `StackSpec`, `readStackSpec`,
  `writeStackSpec`, `listStackSpecAddons`, `setStackSpecAddon`,
  `STACK_SPEC_FILENAME`. Move `SPEC_DEFAULTS` (ports/image defaults — still used)
  into a small constants module (e.g. `constants.ts`).
- The `StackSpec`/`readStackSpec`/`writeStackSpec` exports from `index.ts`.

**Replaced with env-based helpers** (new, in lib — single source for CLI + UI):
- `listEnabledAddons(stackEnvPath): string[]` — parse `OP_ENABLED_ADDONS`.
- `setAddonEnabled(stackEnvPath, name, enabled): void` — upsert the key (reuse
  `upsertEnvValue`/`mergeEnvContent` from `env.ts`).
- version readers: `readImageTag`, `readLayoutVersion`, `readUiVersion`,
  `readStackVersions(): { imageTag, layoutVersion, uiVersion, enabledAddons }`.

## Touch-point inventory (callers to repoint)

- `packages/lib/src/control-plane/compose-args.ts:48` — `listStackSpecAddons` →
  `listEnabledAddons`.
- `packages/lib/src/control-plane/registry.ts:433,853,864` — addon list +
  `setStackSpecAddon` → env helpers.
- `packages/lib/src/control-plane/setup.ts:225` — drop `writeStackSpec`.
- `packages/lib/src/index.ts:312,316,317` — drop StackSpec exports; add new helpers.
- `packages/ui/.../api/setup/current-config/+server.ts:131`,
  `packages/ui/src/lib/server/setup-deploy.ts:352` — `listEnabledAddonIds` now
  sources from `stack.env`.
- `packages/ui/src/routes/admin/versions/+server.ts` — report `OP_LAYOUT_VERSION`
  + `OP_UI_VERSION` from `stack.env` (single read).
- `scripts/dev-setup.sh:153-160` — `--enable-addon` writes `OP_ENABLED_ADDONS` in
  `.dev/knowledge/env/stack.env` instead of templating `stack.yml`.
- `packages/cli/src/install-flow.test.ts:52` + other tests seeding `stack.yml`.
- `home.ts`/`paths.ts` doc comments that list `stack.yml` under `config/stack/`.

## Migration (existing installs)

A migration-harness step (`OP_LAYOUT_VERSION` bump):
1. If `config/stack/stack.yml` exists, read its `addons[]`, write
   `OP_ENABLED_ADDONS=<sorted,csv>` into `stack.env` (only if not already set).
2. Write `OP_LAYOUT_VERSION` and `OP_UI_VERSION` into `stack.env` (back-fill from
   the build dir stamp for UI).
3. Leave `stack.yml` in place (non-destructive) but stop reading it; the harness
   may note it is now ignored.

This **supersedes** the `stack.yml`-creation in the 0.10→0.11 migration scripts:
those should write `OP_LAYOUT_VERSION`/`OP_ENABLED_ADDONS` into `stack.env` rather
than create `config/stack/stack.yml`. The upgrade guide's step 6 ("move/strip
stack.yml") is replaced by "addons live in `stack.env`; there is no `stack.yml`".

## Integration with the migration harness

`OP_LAYOUT_VERSION` in `stack.env` *is* the harness's layout-version gate (replacing
the proposed `.layout-version` stamp) — one fewer file, consistent with this
direction. The harness reads it to compute pending migrations and writes it as the
commit point after a successful, backed-up migration.

## Risks / notes

- `stack.env` is the akm `env:stack` asset and non-secret system config; addon
  enablement + version markers are all non-secret — correct fit.
- Validation must match the current `ADDON_NAME_RE` so a hand-edited
  `OP_ENABLED_ADDONS` can't inject arbitrary profile names.
- `versions/+server.ts` and diagnostics get simpler (one file to read), but the
  omitted tool versions mean "OpenCode version" still comes from the image until
  the manifest pass lands — call this out in the version UI.
- Keep `SPEC_DEFAULTS` (ports/image defaults) — only the YAML spec machinery goes.

## Out of scope (follow-ups)

- Release **versions-manifest** to source OpenCode/akm-cli/etc. into `stack.env`
  truthfully (the deferred tool-versions decision).
- Filesystem-presence addon model (`config/stack/addons/<name>/`) — considered;
  rejected for now in favor of the `stack.env` list to match the consolidation goal
  and minimize churn.

## Test plan

- lib unit: `listEnabledAddons`/`setAddonEnabled` round-trip + validation; version
  readers; compose-args emits the same `--profile addon.*` from `OP_ENABLED_ADDONS`
  as it did from `stack.yml`.
- migration: `stack.yml addons[]` → `OP_ENABLED_ADDONS`, idempotent, non-destructive.
- regression: no remaining readers of `stack.yml` (grep gate in CI).
