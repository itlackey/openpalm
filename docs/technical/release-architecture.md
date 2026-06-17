# Release Architecture

> **Corrections note (2026-06-17):** This document was reconciled against the
> actual codebase. Sections that previously stated incorrect facts (npm-published
> portals, `assistant-X.Y.Z` Docker tags, lib as the platform anchor, missing
> `admin-tools`/setup-script stamping) have been fixed. Items that could not be
> verified from the repo are marked **[UNCERTAIN]**.

## Goals

- Each deployable unit has its own independent semantic version
- No version skipping within a unit — each release increments exactly one semver step from the last published
- Git tag and GitHub release created for every release, every unit
- Version independence is scoped within a major version — a major cut resets all units to `X.0.0`
- npm OIDC provenance is maintained through a single reusable workflow file
- An agent or maintainer triggers a release by selecting a unit and a bump type — no version number input

> **NOTE — relationship to the existing workflow.** The repo currently ships a
> *version-input* orchestrator (`.github/workflows/platform-release.yml` +
> `scripts/release-plan.mjs` + `.github/release-package-groups.json`) that takes
> an explicit `version` string and `release_*` booleans. This document describes a
> *target* design that replaces the explicit version input with a `unit` + `bump`
> selection and computes the next version automatically. The "What Changes in the
> Repository" section below is the migration delta from the current state.

---

## Units

Each unit has a single canonical version anchor. All packages/images within a unit share the same version and move together.

| Unit | Artifacts | Cadence | Canonical version file |
|---|---|---|---|
| `platform` | root `package.json`, @openpalm/lib (npm), openpalm CLI (npm + binaries), @openpalm/ui (npm), @openpalm/admin-tools-plugin, optional Electron installer | Frequent patches | `package.json` (repo root) |
| `portals` | `openpalm/portal` Docker image, `openpalm/guardian` Docker image, baked-in discord/slack adapters (versioned in-repo, **not published to npm**) | Frequent | `portals/discord/package.json` |
| `assistant` | `openpalm/assistant` Docker image | Slow — external dep updates (OpenCode etc.) | `containers/assistant/VERSION` (**new file — does not exist yet**) |
| `guardian` | `openpalm/guardian` Docker image | Slow — standalone or coordinated with assistant or portals | `containers/guardian/package.json` |
| `major` | All units simultaneously | Rare — major version milestones only | All of the above |

> **CORRECTION — platform anchor.** The platform unit's canonical version is the
> **repo-root `package.json`**, not `packages/lib/package.json`. CI anchors the
> host/platform line and the setup-script versions to the root manifest (see
> `.github/release-package-groups.json` → `units.host` lists `package.json` first
> with the comment "CI anchors the host unit + the setup-script versions to root").
> `PLATFORM_VERSION` is nonetheless derived from `packages/lib/package.json` (see
> the PLATFORM_VERSION section); lib and root are stamped together in a platform
> release, so they stay equal in practice.

> **CORRECTION — portals are NOT on npm.** `portals/discord/package.json` and
> `portals/slack/package.json` are both `"private": true` (package names
> `@openpalm/discord-portal` and `@openpalm/slack-portal`). They are **never
> published to npm**. They are baked into the `openpalm/portal` Docker image at
> build time and versioned in-repo only. The portals unit therefore publishes
> **Docker images only** (`openpalm/portal`, and — in the current workflow —
> `openpalm/guardian`), plus a git tag/release. No npm publish jobs run for it.

> **CORRECTION — guardian package is also private.** `containers/guardian/package.json`
> is `"private": true` (name `@openpalm/guardian`). Bumping its version stamps an
> in-repo version anchor for the guardian image; it is never published to npm. Its
> `dependencies` (`@modelcontextprotocol/sdk`, `dotenv`) are installed during the
> Docker build, so a version bump alone does not change the build — it only labels
> the image's source version.

Electron is part of the `platform` unit. In the current workflow it is built on
every `host` release (not gated behind a flag); this design proposes gating it
behind an `include_electron` flag (default `false`) on patch bumps and always
building it on minor/major. **[UNCERTAIN]** whether the team wants the flag —
the current `platform-release.yml` builds Electron unconditionally whenever the
host unit is in scope.

Guardian is standalone in this design. In the **current** workflow, however,
guardian ships as part of the `portals` unit (`units.portals` includes
`containers/guardian/package.json`, and the portals image matrix builds both
`openpalm/guardian` and `openpalm/portal`). Splitting guardian into its own unit
is part of the proposed change. When portals or assistant changes also require a
guardian update under the new scheme, the agent/maintainer issues a separate
guardian release after the primary release completes.

---

## Single / Reusable Workflow

This design runs all releases from one top-level workflow: `.github/workflows/release.yml`.

npm OIDC provenance and the npm publish step are centralized in the existing
reusable workflow **`.github/workflows/publish-npm-package.yml`** (already in the
repo; `on: workflow_call`). The top-level `release.yml` calls it for every npm
publish, so provenance trusts a single publishing path regardless of which unit
is being released.

Docker-only units (`portals`, `assistant`, `guardian`) also run through
`release.yml` for version computation, tagging, and GitHub release creation. No
npm jobs execute for them (their packages are private).

---

## Workflow Inputs

```yaml
inputs:
  unit:
    description: 'Unit to release: platform | portals | assistant | guardian | major'
    required: true
    type: choice
    options: [platform, portals, assistant, guardian, major]

  bump:
    description: 'Semver increment: patch | minor | major (ignored for unit=major)'
    required: true
    type: choice
    options: [patch, minor, major]
    default: patch

  include_electron:
    description: 'Build and publish Electron installer (platform unit only, minor/major bumps)'
    required: false
    type: boolean
    default: false

  dry_run:
    description: 'Validate and build without publishing, committing, or tagging'
    required: false
    type: boolean
    default: true
```

For `unit=major`, `bump` is ignored. The major version number is derived by
incrementing the current major from the **repo-root `package.json`** (the platform
anchor). The root, `packages/lib`, `packages/cli`, `packages/ui`,
`packages/electron`, and `packages/electron/admin-tools` are all kept equal on
platform/major cuts, so any of them yields the same major.

---

## Release Flow (per-unit)

Every unit follows the same steps:

1. **Read** current version from the unit's canonical version file
2. **Compute** next version: `semver_bump(current, bump_type)`
3. **Regression guard**: verify `next > last_published` (npm registry for npm units; Docker Hub for image units; git tags for all). The current workflow's guard (`platform-release.yml` → "Regression guard + already-published probe") only probes npm for non-private manifests; image-only and private units are correctly skipped there and must instead be guarded against the existing git tag / Docker Hub tag.
4. **Stamp** all manifest files (and `containers/assistant/VERSION`) in the unit to the new version. For the platform unit this includes the setup scripts (`scripts/setup.sh` `SCRIPT_VERSION`, `scripts/setup.ps1` `$ScriptVersion`).
5. **Sync** lockfile (`bun install`)
6. **Dry-run gate** — if `dry_run=true`, print planned changes and exit 0
7. **Commit** (e.g. `chore(release): stamp units to 0.12.3`) and push to the release `ref`
8. **Publish artifacts** (npm packages and/or Docker images — see per-unit details below)
9. **Create git tag** pointing at the bump commit
10. **Create GitHub release** at that tag

> **NOTE — workspace dependencies.** `packages/ui` and `packages/electron`
> reference `@openpalm/lib` as `"workspace:*"`, while `packages/cli` references it
> as `">=0.12.2 <1.0.0"` (a range, not `workspace:*`). Bumping lib's version does
> **not** break `workspace:*` consumers (Bun resolves them locally), and the CLI's
> range is wide enough that a patch/minor lib bump stays satisfied. Re-running
> `bun install` after stamping keeps `bun.lock` consistent — this step is required
> and already present in the current workflow.

---

## Per-Unit Job Structure

### `platform`

Jobs (sequential where noted):
1. `compute-version` — reads root `package.json`, computes next version
2. `preflight` — runs `bun run ui:check`, `bun run test`, and `bun run electron:test` (matching the current preflight gate)
3. `bump` — stamps root `package.json`, lib, cli, ui, electron, and `packages/electron/admin-tools/package.json`; stamps `scripts/setup.sh` + `scripts/setup.ps1`; runs `bun install`; commits and pushes
4. `npm-lib` — publishes `@openpalm/lib` via `publish-npm-package.yml`
5. `npm-cli` — publishes `openpalm` (CLI) via reusable workflow (depends on `npm-lib`)
6. `npm-ui` — publishes `@openpalm/ui` via reusable workflow (`needs-build: true`; depends on `npm-lib`)
7. `cli-binaries` — builds CLI binaries (depends on `npm-lib`). **[UNCERTAIN]** count: the current matrix builds **5** targets (linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64). A `build:windows-arm64` script exists in `packages/cli/package.json` but is **not** in the CI matrix — so the live count is 5, not 6.
8. `electron` — builds Electron installers (depends on `npm-ui`; gated on `include_electron=true` in this design; built unconditionally in the current workflow)
9. `tag-release` — creates the git tag and GitHub release with CLI binary + Electron artifacts attached

> **NOTE — `@openpalm/admin-tools-plugin` is NOT published to npm.** It is in the
> platform/host unit's stamp set (so its version stays aligned), but it is bundled
> into the Electron app, not published as an npm package. Stamp it; do not add an
> npm-publish job for it.

### `portals`

Jobs:
1. `compute-version` — reads `portals/discord/package.json`
2. `bump` — stamps `portals/discord/package.json` and `portals/slack/package.json`. **In the current workflow the portals unit also stamps `containers/guardian/package.json`** (guardian rides with portals). This design proposes splitting guardian out; if it is split, the portals bump stamps only the two portal manifests.
3. `docker-portal` — builds and pushes `openpalm/portal` (see Docker Image Tag Scheme)
4. `docker-guardian` — (current workflow only, while guardian rides with portals) builds and pushes `openpalm/guardian`
5. `tag-release` — creates the portals tag and GitHub release

> **CORRECTION — no npm publish for portals.** The previous version of this doc
> listed `npm-discord` / `npm-slack` jobs publishing `@openpalm/discord-portal` /
> `@openpalm/slack-portal`. Those packages are `private` and are never published.
> Remove those jobs.

### `assistant`

Jobs:
1. `compute-version` — reads `containers/assistant/VERSION`
2. `bump` — writes new version to `containers/assistant/VERSION`; commits and pushes
3. `docker-assistant` — builds and pushes `openpalm/assistant` (includes the existing assistant image smoke test: `codex --version && claude --version && pi --version && copilot --version`)
4. `tag-release` — creates the assistant tag and GitHub release

> **NOTE — assistant model bootstrap.** The assistant Dockerfile `COPY --from`s a
> baked embedder model from `openpalm/assistant-models:v1` (published out-of-band by
> `.github/workflows/publish-assistant-models.yml`). That bundle must exist before
> the first assistant image build. A new design doc should not silently drop this
> dependency.

### `guardian`

Jobs:
1. `compute-version` — reads `containers/guardian/package.json`
2. `bump` — stamps `containers/guardian/package.json`; commits and pushes
3. `docker-guardian` — builds and pushes `openpalm/guardian`
4. `tag-release` — creates the guardian tag and GitHub release

---

## Major Release (`unit=major`)

A major cut is the only time all units move together.

Steps:
1. Read current major version from the repo-root `package.json`
2. Compute `next_major = current_major + 1`, target version = `next_major.0.0`
3. Stamp ALL unit canonical files (root, lib, cli, ui, electron, admin-tools, portals discord/slack, guardian, `containers/assistant/VERSION`) and the setup scripts to `next_major.0.0`
4. Run the full preflight gate (`bun run test`, `bun run ui:check`, `bun run electron:test`)
5. Publish all npm packages (lib → cli → ui). **Portals/guardian/assistant are images only — no npm publish.**
6. Build and push all Docker images (portal, assistant, guardian)
7. Build Electron installer (always included on major)
8. Build CLI binaries
9. Create individual prefixed tags for each unit (see Git Tag Scheme)
10. Create a monorepo summary tag `vX.0.0` pointing at the same commit
11. Create individual GitHub releases for each unit at their prefixed tags

After the major cut all units start their independent increment from `X.0.0`.

---

## Git Tag Scheme

| Unit | Tag format | Example |
|---|---|---|
| platform | `platform-X.Y.Z` | `platform-0.12.5` |
| portals | `portals-X.Y.Z` | `portals-0.12.5` |
| assistant | `assistant-X.Y.Z` | `assistant-0.12.5` |
| guardian | `guardian-X.Y.Z` | `guardian-0.12.5` |
| major (summary) | `vX.0.0` | `v1.0.0` |

> **NOTE — divergence from the current tag scheme.** The existing
> `platform-release.yml` creates a **single** `v${version}` git tag (e.g.
> `v0.12.4`) for the whole release, not per-unit prefixed tags. Adopting per-unit
> prefixed tags is a behavior change introduced by this design. The `vX.Y.Z`
> summary tag here is reused as the major-only summary tag.

All tags are created last, after all artifacts are published ("tag exists = fully published"). The current workflow's tag step is idempotent and refuses to move an existing tag — preserve that behavior.

---

## Docker Image Tag Scheme

> **CORRECTION — image tag format.** The previous version of this doc proposed
> tagging images as `openpalm/assistant:assistant-0.12.5`. That format is **NOT
> compatible** with how the stack references images. The runtime compose files
> resolve images through `v`-prefixed tags:
>
> - `core.compose.yml`: `openpalm/assistant:${OP_ASSISTANT_IMAGE_TAG:-${OP_IMAGE_TAG:-latest}}`
> - `portals.compose.yml`: `openpalm/guardian:${OP_GUARDIAN_IMAGE_TAG:-…}`, `openpalm/portal:${OP_PORTAL_IMAGE_TAG:-…}`
>
> and lib stamps those env vars in the canonical Docker form (`OP_ASSISTANT_IMAGE_TAG=v0.11.5`,
> per `composite-upgrade.test.ts` and `formatForDocker()` in `versioning.ts`). The
> current `docker/metadata-action` produces `v${version}` + `latest` tags.
>
> **Use the `v`-prefixed tag, not a unit-prefixed Docker tag.** The unit prefix
> belongs on the *git tag* only.

Docker images are tagged with both the `v`-prefixed version and `latest`:

```
openpalm/assistant:v0.12.5
openpalm/assistant:latest

openpalm/guardian:v0.12.5
openpalm/guardian:latest

openpalm/portal:v0.12.5
openpalm/portal:latest
```

`latest` is only applied for stable (non-prerelease) versions — the current
metadata-action config gates it on `enable=${{ !contains(inputs.version, '-') }}`.

On a major cut the version tag is naturally `v1.0.0` (no additional plain-version
tag is needed since the standard tag is already `v`-prefixed).

---

## PLATFORM_VERSION and Update Checks

`PLATFORM_VERSION` in `packages/lib/src/control-plane/versioning.ts` is derived
from `packages/lib/package.json` (`formatForDocker(libPkg.version)`, so it is
`v`-prefixed). It represents the control plane (lib/CLI/UI) version — it changes
only on `platform` releases.

Docker image update checks must query Docker Hub directly, not compare against
`PLATFORM_VERSION`. The existing `resolveLatestPlatformTagForCurrentMajor()` in
`packages/lib/src/control-plane/lifecycle.ts` already does this — it queries
Docker Hub for the newest semver tag matching the current major.

> **CORRECTION — `updateAvailable` description.** The previous doc said the admin
> compares `services.version < PLATFORM_VERSION`. The actual code in
> `packages/ui/src/routes/admin/+page.svelte` (~line 117) is:
>
> ```ts
> const updateAvailable = $derived(
>   isSemver(platformVersion) &&
>     services.some((s) => isSemver(s.version) && compareVersions(s.version, platformVersion) < 0),
> );
> ```
>
> `platformVersion` is a reactive `$state` populated from the releases endpoint
> (it carries the running control-plane / `PLATFORM_VERSION`), and the check is a
> per-service comparison, not a single field comparison. The intent is the same as
> the doc described: a service is "behind" the control plane. **[UNCERTAIN]**
> whether this should change at all — keying the in-app "update available" banner
> off the control-plane version is a deliberate product decision (#498 comment in
> the file). If images are to drift independently of the platform, the
> independent-drift detection should be **added** (using the Docker Hub query) for
> image-only units, rather than replacing the control-plane comparison wholesale.
> Treat this as design intent to confirm with the maintainer, not a settled change.

---

## Starting Version State

Current on-disk versions (verified 2026-06-17):

| File | Current version |
|---|---|
| `package.json` (root) | `0.12.2` |
| `packages/lib/package.json` | `0.12.2` |
| `packages/cli/package.json` | `0.12.2` |
| `packages/electron/package.json` | `0.12.2` |
| `packages/electron/admin-tools/package.json` | `0.12.2` |
| `scripts/setup.sh` `SCRIPT_VERSION` | `0.12.2` |
| `scripts/setup.ps1` `$ScriptVersion` | `0.12.2` |
| `packages/ui/package.json` | `0.12.4` |
| `portals/discord/package.json` | `0.12.4` |
| `portals/slack/package.json` | `0.12.4` |
| `containers/guardian/package.json` | `0.12.4` |
| `containers/assistant/VERSION` | does not exist |

> **CORRECTION — the previous doc said lib/cli/electron were at 0.12.2 and ui at
> 0.12.4; that is accurate, but it omitted root `package.json`, admin-tools, and
> the setup scripts (all also at 0.12.2), and it implied the platform anchor was
> lib. Align the whole platform unit (root, lib, cli, ui, electron, admin-tools,
> setup scripts) to a single starting point before the first release.**

Recommended alignment before the first release under this system:

| Unit | Members to align | Starting version |
|---|---|---|
| platform | root, lib, cli, ui, electron, admin-tools, setup scripts | Align all to `0.12.4` |
| portals | discord, slack (and guardian if it still rides with portals) | `0.12.4` |
| assistant | seed `containers/assistant/VERSION` | `0.12.4` (matches the last `v0.12.4` image/tag) |
| guardian | `containers/guardian/package.json` | `0.12.4` |

The first release of each unit under the new system computes `next = 0.12.5` (for a patch bump).

---

## What Changes in the Repository

### Deleted
- `.github/workflows/platform-release.yml` — replaced by the new `release.yml`. **[UNCERTAIN]** — verify no other workflow `uses:` it before deleting (none found in the repo; it is dispatched manually).
- `scripts/release-plan.mjs` — unit selection/planning logic, replaced by per-unit compute-version logic in `bump-unit.mjs`
- `.github/release-package-groups.json` — unit definitions now live in `release.yml` (or in `bump-unit.mjs`) directly

> **NOTE — do NOT delete these release-adjacent workflows.** The repo also has
> `publish-assistant-models.yml`, `publish-voice-models.yml`, and
> `publish-voice.yml`. These build the baked model bundles and the voice images
> that `platform-release.yml`'s `voice` job and the assistant Dockerfile depend on.
> They are out-of-band and must be **kept**. The voice unit is currently part of
> `platform-release.yml`'s inputs (`release_voice`); the new `release.yml` must
> either keep a `voice` path or leave `publish-voice.yml` as the voice release
> mechanism. **[UNCERTAIN]** — decide whether voice becomes its own `unit` in
> `release.yml` or stays on `publish-voice.yml`.

### Added
- `.github/workflows/release.yml` — single top-level release workflow
- `scripts/bump-unit.mjs` — reads anchor version, applies bump, stamps unit files (including the setup scripts for the platform unit), returns new version
- `containers/assistant/VERSION` — canonical version file for the assistant unit, seeded to `0.12.4`

### Updated
- `package.json` (root), `packages/lib/package.json`, `packages/cli/package.json`, `packages/ui/package.json`, `packages/electron/package.json`, `packages/electron/admin-tools/package.json` — aligned to `0.12.4`
- `scripts/setup.sh` (`SCRIPT_VERSION`) and `scripts/setup.ps1` (`$ScriptVersion`) — aligned to `0.12.4` and stamped on every platform release
- `packages/lib/src/control-plane/versioning.ts` — `PLATFORM_VERSION` stays (derived from lib); add documentation clarifying it tracks the platform unit only
- `packages/ui/src/routes/admin/+page.svelte` and `packages/ui/src/routes/admin/versions/+server.ts` — **[UNCERTAIN]** — only if independent image-drift detection is adopted; add a Docker-Hub-query-based signal for image-only units alongside (not replacing) the control-plane `updateAvailable` comparison

### Kept
- `.github/workflows/publish-npm-package.yml` — reusable npm publish workflow, called by `release.yml` for all npm publishes
- `scripts/set-version.mjs` — used by `bump-unit.mjs` to stamp individual manifests
- `.github/workflows/publish-assistant-models.yml`, `publish-voice-models.yml`, `publish-voice.yml` — out-of-band model/voice builds (dependencies of the assistant image and the voice unit)
- `.github/workflows/ci.yml` and all other CI workflows (tests, checks, etc.)

---

## Example Release Commands

```bash
# Routine platform patch (root + lib + cli + ui + electron + admin-tools)
gh workflow run release.yml -f unit=platform -f bump=patch -f dry_run=false

# Portal release (portal + guardian Docker images; no npm)
gh workflow run release.yml -f unit=portals -f bump=patch -f dry_run=false

# OpenCode dependency update (assistant image only)
gh workflow run release.yml -f unit=assistant -f bump=patch -f dry_run=false

# Guardian needs updating alongside assistant (if guardian is split into its own unit)
gh workflow run release.yml -f unit=assistant -f bump=patch -f dry_run=false
# then after it completes:
gh workflow run release.yml -f unit=guardian -f bump=patch -f dry_run=false

# Platform minor release with Electron
gh workflow run release.yml -f unit=platform -f bump=minor -f include_electron=true -f dry_run=false

# Major version cut (all units → 1.0.0)
gh workflow run release.yml -f unit=major -f dry_run=false
```
