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
| `platform` | @openpalm/lib (npm), openpalm CLI (npm + binaries), @openpalm/ui (npm), @openpalm/skeleton (npm), @openpalm/guardian (npm) | root `package.json` (max with npm-published) |
| `portals` | @openpalm/discord-portal + @openpalm/slack-portal (npm), `openpalm/portal` Docker image (`include_images`, on by default) | `portals/discord/package.json` |
| `assistant` | `openpalm/assistant` Docker image | `containers/assistant/VERSION` |
| `guardian` | @openpalm/guardian (npm), @openpalm/skeleton (npm), guardian Docker image (`include_images`, on by default) | `packages/guardian/package.json` (max with npm-published) |
| `images` | Guardian + assistant + portal Docker images (no npm) | root `package.json` (no bump — use `version` override to tag images at a new version) |
| `electron` | Electron installers (mac/linux/win). No npm. | `packages/electron/package.json` |
| `all` | **Every unit** — all platform npm + both portal npm adapters + all three Docker images (assistant/guardian/portal) + electron installers + CLI binaries, flag-free | root `package.json` (max with npm-published) |

> **`include_images` defaults to `true`.** It did not always: releases 0.12.43 and 0.12.45–0.12.52 shipped npm packages, git tags and GitHub releases with **no Docker images at all**, because the default was `false` and release practice had drifted to `unit=platform`. `tag-release` gated on `!contains(needs.*.result, 'failure')`, and a *skipped* job is not a failure, so every one of those runs reported success. Two things now prevent that: the default is `true`, and `tag-release` runs `scripts/verify-release-images.mjs` before creating any tag — it fails the release when an image job the unit expected was skipped. Unticking `include_images` is still supported for a deliberate npm-only thin-host patch; the guard only fires when images were *expected* and did not arrive.

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
    description: 'Rebuild Docker images alongside the npm publish (guardian/platform/portals; images and all always build images)'
    default: true

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

Publishes: @openpalm/skeleton → @openpalm/lib → (@openpalm/guardian, openpalm CLI, @openpalm/ui) → CLI binaries → optional Electron.

Stamps: root, lib, skeleton, guardian, cli, ui, electron, admin-tools package.json files + `scripts/setup.sh` `SCRIPT_VERSION` + `scripts/setup.ps1` `$ScriptVersion`.

The shared `scripts/set-version.mjs` helper is also responsible for rewriting the CLI's exact `@openpalm/skeleton` dependency pin to the release version during this stamp. That keeps the published CLI's bundled skeleton source in lockstep with `PLATFORM_VERSION`.


Preflight: full test suite (`bun run ui:build` then `bun run test`, plus `ui:check`, `ui-kit:check`, `ui:test:unit`, `electron:test`).

### `portals`

Stamps: `portals/discord/package.json`, `portals/slack/package.json`.

Builds: `openpalm/portal` Docker image (bakes discord + slack adapters; no npm publish).

### `assistant`

Stamps: `containers/assistant/VERSION`.

Builds: `openpalm/assistant` Docker image + smoke test (`opencode --version && akm --version && gh --version && jq --version && sqlite3 --version && uv --version`).

### `guardian`

Stamps: `packages/guardian/package.json`.

Publishes: @openpalm/skeleton + @openpalm/guardian npm (thin-host needs both at container startup).

Builds the guardian Docker image unless `include_images` is unticked.

Preflight: `bun test packages/guardian`.

### `images`

No stamp, no npm. Rebuilds guardian + assistant + portal Docker images at current (or overridden) version.

### `electron`

Stamps: `packages/electron/package.json`, `packages/electron/admin-tools/package.json`.

Builds mac/linux/win installers. No npm publish. Pass an explicit `version` matching the currently-published npm packages.

Preflight: `bun run electron:test`.

### `all`

The **complete** release. Stamps every unit's files simultaneously to the same version (any bump type or explicit override) and publishes everything, flag-free:

- **npm**: `@openpalm/{lib,ui,guardian,skeleton}` + `openpalm` (CLI) + `@openpalm/{discord,slack}-portal`
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
