# Release Architecture

> **Last updated 2026-07-06** against the live codebase at 0.12.52.

## Goals

- Each deployable unit has its own independent semantic version
- No version skipping within a unit — each release increments exactly one semver step from the last published
- Git tag and GitHub release created for every release, every unit
- npm OIDC provenance maintained through a single reusable workflow file
- A maintainer triggers a release by selecting a unit, a bump type, and/or an explicit version — no manual version calculation

---

## Units

Each unit has a single canonical version anchor. All packages/images within a unit share the same version and move together.

| Unit | Artifacts | Canonical version anchor |
|---|---|---|
| `platform` | @openpalm/lib (npm), openpalm CLI (npm + binaries), @openpalm/ui (npm), @openpalm/client (npm), @openpalm/skeleton (npm), @openpalm/guardian (npm) | root `package.json` (max with npm-published) |
| `portals` | @openpalm/discord-portal + @openpalm/slack-portal (npm), optional `openpalm/portal` Docker image (`include_images=true`) | `portals/discord/package.json` |
| `assistant` | `openpalm/assistant` Docker image | `containers/assistant/VERSION` |
| `guardian` | @openpalm/guardian (npm), @openpalm/skeleton (npm), optional guardian Docker image | `packages/guardian/package.json` (max with npm-published) |
| `images` | Guardian + assistant + portal Docker images (no npm) | root `package.json` (no bump — use `version` override to tag images at a new version) |
| `electron` | Electron installers (mac/linux/win). No npm. | `packages/electron/package.json` |
| `all` | **Every unit** — all platform npm + both portal npm adapters + all three Docker images (assistant/guardian/portal) + electron installers + CLI binaries, flag-free | root `package.json` (max with npm-published) |

> **Every unit except `all` is partial by design** — it publishes only its own slice and silently leaves the others behind. In particular, `platform` does **not** touch the portal image or the discord/slack npm adapters (that's a `portals` release). For a complete, coordinated release of the whole platform, use **`all`** — it builds every unit at one version with no `include_images`/`include_electron` flags required. The **only** artifact `all` does not build is the **voice** image, which ships from `publish-voice.yml` on its own cadence (GPU cpu/cu121 variants).

### Dual-owned packages

`@openpalm/skeleton` and `@openpalm/guardian` are published by **both** `platform` and `guardian` units:

- Platform needs skeleton so the CLI can seed OP_HOME on install
- Guardian needs both because the thin-host guardian docker image downloads them at container startup via `npm install` in its entrypoint

Both publish steps use `allow-existing: true`. `bump-unit.mjs` anchors version computation on `maxPublished()` across all dual-owned packages so neither unit computes a next version that collides with what the other unit already published.

### Electron

Electron is NOT part of the platform unit's automatic publish path. It is:
- Optionally included in a `platform` release when `include_electron=true` or bump is non-patch
- Always included in an `all` release
- Independently releasable via `unit=electron` — use this when only `packages/electron/` has changed (e.g. IPC fixes, harness contract changes) without needing to republish npm packages

The last published Electron release was `v0.12.4` (assets: `.AppImage`, `.zip` for mac/win/linux).

---

## Single Workflow

All releases run from `.github/workflows/release.yml`. npm publishing is centralized in the reusable `.github/workflows/publish-npm-package.yml` (OIDC provenance via single trusted publisher entry point).

---

## Workflow Inputs

```yaml
inputs:
  unit:
    description: 'Unit to release'
    options: [platform, portals, assistant, guardian, images, electron, all]

  bump:
    description: 'Semver increment (ignored for unit=images or when version is set)'
    options: [patch, minor, major]
    default: patch

  version:
    description: 'Explicit version override (e.g. 0.12.22-rc.1). Skips bump computation.'

  include_electron:
    description: 'Build Electron installer alongside platform release (use unit=electron for standalone)'
    default: false

  include_images:
    description: 'Also rebuild Docker images (guardian/platform only; images and all always build images)'
    default: false

  dry_run:
    description: 'Validate and build without publishing, committing, or tagging'
    default: true
```

For `unit=all`, `bump` determines the version increment (patch/minor/major all valid). An explicit `version` override takes precedence over `bump` for all units.

---

## Release Flow (per-unit)

1. **Compute** next version: explicit `version` override → or `bumpVersion(anchor, bump)`; anchors use `maxPublished()` for dual-owned packages
2. **Regression guard**: verify `next > last_published` for all npm packages in scope
3. **Preflight**: run tests relevant to the unit
4. **Stamp** all manifest files in the unit
5. **Sync** lockfile (`bun install`)
6. **Dry-run gate** — if `dry_run=true`, print planned changes and exit 0
7. **Commit** (`chore(release): stamp ${unit} to ${version}`) + push with retry/rebase
8. **Publish artifacts** (npm packages and/or Docker images)
9. **Create git tag** — after all artifacts published ("tag exists = fully published")
10. **Create GitHub release** at that tag

---

## Per-Unit Details

### `platform`

Publishes: @openpalm/skeleton → @openpalm/lib → (@openpalm/guardian, openpalm CLI, @openpalm/ui) → CLI binaries → optional Electron. @openpalm/client publishes in parallel (exact-pin, `needs-build`, like @openpalm/ui) — it deliberately has **no** @openpalm/lib ordering dependency because the client never bundles the host library (ui-runtime-modes-plan.md §8.10; `@openpalm/ui-kit` is inlined from the workspace at build time and is **never published**).

Stamps: root, lib, skeleton, guardian, cli, ui, client, electron, admin-tools package.json files + `scripts/setup.sh` `SCRIPT_VERSION` + `scripts/setup.ps1` `$ScriptVersion`.

Preflight: full test suite (`bun run client:build` then `bun run test` — which includes the client-bundle purity gate — plus `ui:check`, `ui-kit:check`, `client:check`, `ui:test:unit`, `electron:test`).

### `portals`

Stamps: `portals/discord/package.json`, `portals/slack/package.json`.

Builds: `openpalm/portal` Docker image (bakes discord + slack adapters; no npm publish).

### `assistant`

Stamps: `containers/assistant/VERSION`.

Builds: `openpalm/assistant` Docker image + smoke test (`codex --version && claude --version`).

### `guardian`

Stamps: `packages/guardian/package.json`.

Publishes: @openpalm/skeleton + @openpalm/guardian npm (thin-host needs both at container startup).

Optionally builds guardian Docker image when `include_images=true`.

Preflight: `bun test packages/guardian`.

### `images`

No stamp, no npm. Rebuilds guardian + assistant + portal Docker images at current (or overridden) version.

### `electron`

Stamps: `packages/electron/package.json`, `packages/electron/admin-tools/package.json`.

Builds mac/linux/win installers. No npm publish. Pass an explicit `version` matching the currently-published npm packages.

Preflight: `bun run electron:test`.

### `all`

The **complete** release. Stamps every unit's files simultaneously to the same version (any bump type or explicit override) and publishes everything, flag-free:

- **npm**: `@openpalm/{lib,ui,client,guardian,skeleton}` + `openpalm` (CLI) + `@openpalm/{discord,slack}-portal`
- **Docker**: `openpalm/{assistant,guardian,portal}` (+ `:latest` for stable)
- **Electron** installers (mac/linux/win) + CLI native binaries
- Per-unit tags + bare `X.Y.Z` summary tag + GitHub release

No `include_images` / `include_electron` needed — `all` always builds them. The only thing it does **not** build is the voice image (`publish-voice.yml`, separate cadence). Prefer `all` for a real release; reach for a partial unit only for a deliberate, isolated hotfix.

---

## Git Tag Scheme

| Unit | Tag(s) |
|---|---|
| `platform` | `platform-X.Y.Z` + `X.Y.Z` |
| `portals` | `portals-X.Y.Z` |
| `assistant` | `assistant-X.Y.Z` |
| `guardian` | `guardian-X.Y.Z` |
| `images` | `images-X.Y.Z` |
| `electron` | `electron-X.Y.Z` |
| `all` | `platform-X.Y.Z`, `portals-X.Y.Z`, `assistant-X.Y.Z`, `guardian-X.Y.Z`, `electron-X.Y.Z` + `X.Y.Z` |

Tags and image tags are **bare semver** (no `v` prefix) as of 0.12.41. Releases
published before the cutover keep their legacy `vX.Y.Z` tags; every read path
(`normalizeVersion`, the Docker Hub resolver, the CLI self-update redirect,
`groupReleasesByUnit`'s legacy pattern) still tolerates a leading `v`.

All tags are created last, after all artifacts are published. Existing tags at the same SHA are skipped; tags at a different SHA fail the job (no tag movement).

---

## Docker Image Tag Scheme

```
openpalm/assistant:X.Y.Z   (+ :latest for stable releases)
openpalm/guardian:X.Y.Z    (+ :latest for stable releases)
openpalm/portal:X.Y.Z      (+ :latest for stable releases)
```

`latest` is only applied for non-prerelease versions (no `-` in version string).

---

## Example Commands

```bash
# Routine platform patch
gh workflow run release.yml -f unit=platform -f bump=patch -f dry_run=false

# Platform with Electron bundled
gh workflow run release.yml -f unit=platform -f bump=minor -f include_electron=true -f dry_run=false

# Electron-only release (installers only, no npm republish)
gh workflow run release.yml -f unit=electron -f version=0.12.22 -f dry_run=false

# Guardian npm packages only (thin-host update without a platform cut)
gh workflow run release.yml -f unit=guardian -f bump=patch -f dry_run=false

# Docker images only (e.g. OpenCode version bump in assistant image)
gh workflow run release.yml -f unit=assistant -f bump=patch -f dry_run=false

# All units at a specific version (full coordinated release)
gh workflow run release.yml -f unit=all -f version=1.0.0 -f dry_run=false

# All units with a patch bump (computed automatically)
gh workflow run release.yml -f unit=all -f bump=patch -f dry_run=false

# Rebuild Docker images only at the current version
gh workflow run release.yml -f unit=images -f dry_run=false
```

---

## scripts/bump-unit.mjs

The version computation + file stamping script. Key behaviors:

- **`anchorFn()`** — reads the unit's canonical on-disk version
- **`maxPublished(name)`** — queries npm registry for highest published version; used by platform and guardian anchors to prevent collision with independently-published dual-owned packages
- **`anchorFromPublished(diskVersion, packages)`** — returns `max(diskVersion, maxPublished(...packages))`
- Units: defined in `UNITS` object; each has `anchorFn` and `stamp(version)` method
- Error-safe in offline contexts: npm queries that fail return `null` and are ignored

Preview locally: `UNIT=platform BUMP=patch STAMP=false node scripts/bump-unit.mjs`
