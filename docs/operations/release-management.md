# Release Management

This guide is the authoritative reference for cutting OpenPalm releases. It
covers the current coordinated platform release flow plus the independently
versioned UI release line.

> **Ground truth.** The proven release flow described here was established and
> verified on the `release/0.11.0` line. Where this guide and a script's inline
> comments disagree, trust the running script — and open a PR to fix the comment.

---

## Release Tracks

OpenPalm currently uses two release tracks:

### Track A — Platform release (single coordinated version)

All platform packages and images share **one** version and ship **together** in a
single release driven by `.github/workflows/platform-release.yml`. You never
publish one platform package on its own; you cut a whole platform release or a
platform unit release through that workflow.

The authoritative manifest list lives in
[`.github/release-package-groups.json`](../../.github/release-package-groups.json)
under `platformManifests`. `scripts/bump-platform.sh` reads that list.
`packages/ui` is **not** in `platformManifests` — it is independently versioned
(Track B).

### Track B — UI (`@openpalm/ui`, independently versioned)

The SvelteKit operator UI is versioned and published **on its own schedule**,
decoupled from the platform. It ships as an adapter-node bundle to npm
(`@openpalm/ui`, `files: ["build"]`, zero runtime deps) and is fetched at
runtime from the registry by `packages/lib/src/control-plane/ui-assets.ts`
(integrity-verified). It is **not** a GitHub release asset. Publishing is handled
through `.github/workflows/platform-release.yml` as the `ui` unit. The Electron
app also bundles the UI, so the Electron build jobs run `bun run ui:build`
separately to produce a self-contained installer.

> **`workflow_dispatch` requires `main`.** GitHub only allows dispatching a
> workflow that exists on the repository's **default branch** (`main`).
> `platform-release.yml` must be present on `main` to be dispatchable from the
> Actions UI or via `gh workflow run`.

---

## Per-layer table

| Layer | What it is | How it's published | Trigger | Artifact(s) | Track |
|---|---|---|---|---|---|
| `openpalm` (CLI) | Host orchestrator. **npm name is `openpalm`**, not `@openpalm/cli`. | `platform-release.yml` | `workflow_dispatch` | npm | A (platform) |
| `@openpalm/lib` | Shared control-plane library | `platform-release.yml` | `workflow_dispatch` | npm | A (platform) |
| `@openpalm/ui` (`packages/ui`) | SvelteKit operator UI + API (adapter-node bundle, `files:["build"]`) | `platform-release.yml` (`ui` unit) | `workflow_dispatch` | npm only (`next` for prereleases, `latest` for stable) | **B (independent)** |
| `packages/electron` + `admin-tools` | Desktop app + bundled admin-tools plugin | `platform-release.yml` | `workflow_dispatch` | GitHub assets (.dmg/.AppImage/.exe + update metadata) — **not** on npm | A (platform) |
| `openpalm/assistant` | OpenCode assistant image | `platform-release.yml` | `workflow_dispatch` | Docker Hub | A (platform) |
| `openpalm/guardian` | Guardian image | `platform-release.yml` | `workflow_dispatch` | Docker Hub | A (platform) |
| `openpalm/portal` | Unified portal runtime image (bakes shared runtime + first-party adapters) | `platform-release.yml` | `workflow_dispatch` | Docker Hub | A (platform) |
| `openpalm/voice` (`-cpu`, `-cu121`) | Voice addon images | `platform-release.yml` | `workflow_dispatch` | Docker Hub | A (platform, additive — never blocks the release) |
| CLI binaries (5 platforms) | Standalone `bun build --compile` binaries | `platform-release.yml` | `workflow_dispatch` | GitHub assets | A (platform) |
| GitHub release | Release page + all assets + checksums | `platform-release.yml` | `workflow_dispatch` | GitHub release | A (platform) |
| `guardian-api` | Guardian-hosted OpenAI-compatible API service | baked into `openpalm/guardian` | n/a | Docker image only | A (platform) |
| `@openpalm/discord-portal` | Discord portal adapter | baked into `openpalm/portal` | n/a | Docker image only | A (platform) |
| `@openpalm/slack-portal` | Slack portal adapter | baked into `openpalm/portal` | n/a | Docker image only | A (platform) |

> **Platform packages that do NOT publish to npm.** Of the eight `platformManifests`
> entries, only two publish to npm: `@openpalm/lib` and `openpalm` (CLI). The
> root manifest, `containers/guardian`, `portals/discord`, `portals/slack`,
> `packages/electron`, and `packages/electron/admin-tools` are version-stamped for coordination but ship
> as Docker images / GitHub assets only. `bump-platform.sh` stamps the version on
> all eight so the lockfile and cross-references stay consistent.
>
> **`packages/ui` is NOT in `platformManifests`.** It is in `independentNpmPackages`
> and is published through `platform-release.yml` as the `ui` unit. Full/host
> platform releases also include the UI because the host unit owns it.

---

## Dist-tag rules

| Release kind | Detection | npm dist-tag | Docker `latest` / `latest-*` |
|---|---|---|---|
| Prerelease (`0.11.0-beta.15`) | version contains `-` | `next` | **not created** (gated off) |
| Stable (`0.11.0`) | no `-` | `latest` | created |

- `platform-release.yml` adds `--tag next` for prereleases on every npm publish job.
- Docker `latest` (and voice `latest-cpu` / `latest-cu121`) tags are gated with
  `enable=${{ ... prerelease != 'true' }}`, so during a beta line **only the
  immutable `vX.Y.Z` Docker tags exist** — never a moving `latest`.
- The reusable `publish-npm-package.yml` applies the same rule to `@openpalm/ui`
  (`-` in the version → `--tag next`).

---

## Cutting a platform release (Track A)

A platform release is driven by `platform-release.yml`. It prepares the release
version, stamps setup scripts, regenerates `bun.lock`, and publishes the
selected units.

Use `workflow_dispatch` with explicit `version` and `ref` inputs. The workflow
is the source of truth for release preparation and publication.

### What must be synchronized before dispatching a release

1. Every manifest in `platformManifests` (`.version`).
2. `scripts/setup.sh` — `SCRIPT_VERSION="<version>"`.
3. `scripts/setup.ps1` — `$ScriptVersion = '<version>'`.
4. `bun.lock` (regenerated so workspace versions match).

The CLI's internal `@openpalm/lib` floor range (`">=<version> <N.0.0"`) must also
track lib's version — `bump-platform.sh` handles this automatically.

### Option 1 — current scripted flow

`scripts/release.sh` now prepares the branch, pushes it, and dispatches
`platform-release.yml` with the requested version and current branch ref.

```bash
VERSION=0.11.0-beta.16

# 1. Bump all platform manifests (+ sync the CLI's @openpalm/lib floor range)
./scripts/bump-platform.sh "$VERSION"

# 2. Stamp the setup scripts (platform-release guard verifies these)
sed -i "s/^SCRIPT_VERSION=\".*\"/SCRIPT_VERSION=\"${VERSION}\"/" scripts/setup.sh
sed -i "s/^\$ScriptVersion = '.*'/\$ScriptVersion = '${VERSION}'/" scripts/setup.ps1

# 3. Regenerate the lockfile so workspace versions match the bumped manifests
bun install

# 4. Test gate (must pass before dispatching)
bun run test       # guardian, portals, cli, lib, electron admin-tools (not UI)
bun run ui:check   # svelte-check + TypeScript

# 5. Commit + push the release-prep commit on the current branch
git add -A
git commit -m "chore: release ${VERSION}"
git push origin "$(git rev-parse --abbrev-ref HEAD)"

# 6. Dispatch the platform release workflow
gh workflow run platform-release.yml --ref main \
  -f version="${VERSION}" \
  -f ref="$(git rev-parse --abbrev-ref HEAD)" \
  -f dry_run=false
```

The workflow then performs the release from the requested branch ref.

> `scripts/release.sh` automates steps 1-6 and works from the current branch.

### Option 2 — `workflow_dispatch`

Run the **platform release** workflow from the GitHub Actions UI (or
`gh workflow run platform-release.yml`) with:

- `version` — the release version (required for a real release).
- `dry_run` — `true` to build every artifact but skip all bumping, tagging,
  pushing, and publishing (useful to validate matrices).

On a real dispatch, the workflow bumps the selected manifests, stamps setup
scripts, regenerates the lockfile, commits to the target branch, and performs the
publishes for the selected units.

### Republish / re-cut safety

`platform-release.yml` is built to be re-runnable for the same version/ref:

- Docker, CLI, and Electron build matrices are `fail-fast: false`, so one flaky
  leg can be re-run without cancelling its siblings.
- The **Publish GitHub release** job deletes any existing release for the tag
  first (preserving the git tag), then recreates it — avoiding
  `softprops/action-gh-release` leaving a zero-asset release on a re-cut.
- Every npm publish job treats "version already published" as success.

---

## Publishing Portal Runtime Inputs (Track A)

First-party portal adapters are baked into the `openpalm/portal` image, and the
OpenAI-compatible API now ships from the `openpalm/guardian` image. These are
platform-coupled release inputs, not independently published npm packages.

### How portal updates reach users

Portal runtime changes ship through the coordinated platform release flow:

1. Update the baked portal adapter sources under `portals/discord/` or
   `portals/slack/`, or the guardian-hosted OpenAI-compatible API under
   `containers/guardian/src/openai-api*.ts`.
2. Cut the normal platform release.
3. Users receive the new portal behavior when they pull the new image tags and
   recreate the affected services.

The `openpalm/portal` image selects its baked adapter via `PORTAL_PACKAGE` in
[`channels.compose.yml`](../../.openpalm/config/stack/channels.compose.yml).

---

## Publishing the UI (Track B)

`@openpalm/ui` publishes to **npm only** (no Docker image, no GitHub release
asset). The published artifact is the adapter-node SvelteKit bundle
(`files: ["build"]`, self-contained, zero runtime deps). At runtime,
`packages/lib/src/control-plane/ui-assets.ts` fetches the tarball from the npm
registry and verifies its integrity before installing it.

### How to publish the UI

UI publishing runs through `platform-release.yml` as the `ui` unit.

> **Dispatch only works from `main`.** `workflow_dispatch` is only available when
> the workflow file exists on the repository's default branch (`main`). If you
> need to publish a UI build from a release branch, ensure
> `platform-release.yml` on `main` supports the flow you need, then dispatch it
> with `ref` set to that branch.

### OIDC trusted publishing

`platform-release.yml` (and its reusable npm-publish child) requests
`id-token: write` so that `npm publish --provenance` works without a stored
`NPM_TOKEN`. Provenance attestations appear on the npm package page.

### Why the UI is NOT in the platform release

The UI can be updated independently of Docker images and CLI binaries — an
operator's running stack picks up a new UI version without an image restart. This
mirrors the portal/runtime model. The `platform-release.yml` workflow still builds the UI
inside `build-electron-artifacts` to bundle a version-stamped copy into the
Electron installer; that is the only UI build that happens during a platform
release, and it is intentionally separate from the npm publish path.

---

## npm publishing: single entry point (`platform-release.yml`)

All npm publishing flows through **one** workflow, `.github/workflows/platform-release.yml`.
This is required by npm trusted publishing (OIDC): npm allows **only one** trusted
publisher per package and validates the **calling (top-level) workflow's name**, not
the reusable workflow that runs `npm publish`. So every package's npm trusted
publisher must be configured (on npmjs.com → package → Settings → Trusted Publisher)
as:

- Repository: `itlackey/openpalm`
- Workflow: `platform-release.yml`
- Environment: (none)

Set this for every published package: `@openpalm/lib`, `openpalm`, and
`@openpalm/ui`. Until that is set, the
orchestrator's real (non-dry) npm publish will 403.

The orchestrator releases by **deployment unit** (see
[`.github/release-package-groups.json`](../../.github/release-package-groups.json) →
`units`). Pick units with the `release_*` booleans on dispatch:

| Unit | `release_*` | What it ships | Versioned manifests | Tag + GitHub release? |
|---|---|---|---|---|
| **host** | `release_host` | `@openpalm/lib` + `openpalm` (CLI) + `@openpalm/ui` (npm) + CLI native binaries + Electron installers | root, lib, cli, ui, electron, admin-tools (+ setup scripts) | **yes** (carries the binaries/installers) |
| **channels** | `release_channels` | guardian image + portal image | portal-runtime, guardian, baked portal adapters | no (registry-only) |
| **assistant** | `release_assistant` | assistant image | (image-only) | no (registry-only) |
| **voice** | `release_voice` | voice `cpu`/`cu121` images | (image-only) | no (registry-only) |

- **Full coordinated release:** dispatch `platform-release.yml` with `version` +
  `ref` and **leave all `release_*` unchecked** — it releases host + channels +
  assistant together (voice is never part of a full release; check `release_voice`
  to add it). This bumps the whole platform to one version and tags it.
- **Per-unit release** (e.g. a UI/CLI patch, an adapter + guardian refresh, an
  assistant rebuild): check just that unit's `release_*`. Only that unit's
  manifests are stamped to `version`; **units drift independently** — CI's
  version-sync enforces consistency *within* a unit, not across units. The host
  unit owns root + the setup-script version, so the "platform version" tracks the
  host/CLI line.
- **Always `dry_run` first.** It validates semver, a clean tree, the test gate,
  the per-unit regression guard, packs every in-scope npm package and builds
  (amd64-only) every in-scope image without publishing/committing/tagging.

The standalone `publish-ui.yml` / `publish-channel-*.yml` workflows were retired
(they would fail the trusted-publisher check as a different calling workflow).
`publish-npm-package.yml` remains as the reusable child invoked by the orchestrator.

---

## Beta → stable cutover checklist

When promoting a `0.X.Y-beta.N` line to a stable `0.X.Y`:

- [ ] Cut the stable platform release (`0.X.Y`, no `-` suffix). This publishes npm
      under `latest` and creates the Docker `latest` / `latest-*` tags.
- [ ] **Publish a stable `@openpalm/ui` version (Track B)** so `@latest` on npm
      resolves to the current UI. Dispatch `platform-release.yml` with the `ui`
      unit (or include UI in a coordinated cut). Without this step, any fresh
      install that fetches `@openpalm/ui@latest` would pull the previous stable
      line's UI.
- [ ] Publish the stable portal and guardian images (Track A) so the baked
      portal adapters and guardian-hosted OpenAI-compatible API are available
      under stable image tags.
- [ ] **Flip `PORTAL_PACKAGE` and image tags to the stable line** in
      [`.openpalm/config/stack/channels.compose.yml`](../../.openpalm/config/stack/channels.compose.yml)
      when cutting stable from a prerelease branch.
- [ ] Verify `scripts/setup.sh` / `scripts/setup.ps1` `SCRIPT_VERSION` equals the
      stable version (the tag-push guard enforces this).
- [ ] Update `CHANGELOG.md`.

---

## 0.11.0 stable — outstanding cleanup & work

Concrete items deferred during the `0.11.0-beta` line that must be handled when
cutting stable `0.11.0` (captured 2026-06-02 at `beta.15`):

**Required for a correct stable cut**

- [x] **Move `akm-cli` off the `next` prerelease tag.** Done — `containers/assistant/Dockerfile`
      pins `ARG AKM_CLI_VERSION=0.8.0` (stable). The guardian no longer installs
      akm-cli (its OpenCode is a pure moderator), so there is no second pin to keep
      in lockstep; CI validates the assistant pin and only compares the guardian if
      it ever reintroduces one. NOTE: the `akm-opencode` OpenCode plugin
      (`.openpalm/config/assistant/opencode.jsonc`) is still `@latest` (0.7.6) — no
      stable 0.8.0 plugin is published yet (0.8.0 line is on `@next`); 0.7.6 works
      against the 0.8.0 CLI (the plugin shells to stable CLI commands). Revisit when
      a stable `akm-opencode` 0.8.0 ships.
- [ ] **Publish a stable `@openpalm/ui` version** (Track B, via `platform-release.yml` `ui` unit).
      During the `0.11.x` beta line, `@openpalm/ui` has only been published with
      prerelease versions (→ `next` dist-tag). A fresh install on the stable release
      must be able to resolve `@openpalm/ui@latest`. Merge the current `packages/ui`
      state to `main` (or dispatch `platform-release.yml` with an explicit stable version and the `ui` unit)
      to create the first `latest` UI tag.
- [ ] **Publish the stable portal and guardian images** so the baked portal
      adapters and guardian-hosted API move onto the stable image tags.
- [ ] **Then flip `PORTAL_PACKAGE` / image pins from prerelease to stable** in
      `.openpalm/config/stack/channels.compose.yml` where applicable.
- [ ] **Verify the first stable publishes the moving Docker tags** — `latest`,
      and especially `openpalm/voice:latest-cpu` / `latest-cu121`, which have
      **never existed** (gated off for prereleases). Confirm `push-voice-images`
      creates them.
- [ ] **Confirm fresh-install defaults resolve.** `DEFAULT_IMAGE_TAG = "latest"`
      (`config-persistence.ts`) only works once stable `latest` images exist — a
      pure-beta fresh install via CLI/wizard would fail to pull. Validate a clean
      install on a non-dev machine.
- [ ] **Finalize `CHANGELOG.md`.** The last entry is `beta.11`; fold the
      `beta.12`→`beta.15` work into a single `[0.11.0]` section: env/secret
      migration (vault→env+secret), channel-adapter runtime architecture
      (optional-peer + `@next`), ollama healthcheck fix, `OP_IMAGE_TAG`
      stack.env-driven fix, and the release-pipeline hardening.

**Cleanup / maintenance (not stable blockers)**

- [ ] `npm deprecate '@openpalm/assistant-tools@0.10.0' '...'` — orphaned package;
      `packages/assistant-tools` was removed (folded into
      `@openpalm/admin-tools-plugin`) and its publish workflow deleted.
- [x] **Bump deprecated GitHub Actions off the Node 20 runtime.** Done
      (2026-06-05): repo-wide bump to Node 24 majors — `actions/checkout` v4→v6,
      `actions/setup-node` v4→v6, `actions/upload-artifact` v4→v7,
      `actions/download-artifact` v4→v8, `softprops/action-gh-release` v2→v3; the
      now-redundant `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` flag was removed from
      `ci.yml`. Verified `using: node24` + input compatibility; CI green.
- [ ] **Voice `rocm6`** is still unimplemented (the Dockerfile hard-errors and the
      profile is gated). Either implement the ROCm image or keep it gated and
      documented as unsupported.
- [ ] **Decide the desktop-app image-tag policy.** Electron now reads `OP_IMAGE_TAG`
      from `stack.env` (the forced `latest` was removed). For stable, confirm fresh
      desktop installs resolve `latest` images, or pin installs to the app's own
      version tag.
- [ ] **Validate the 0.10.x → 0.11.0 upgrade path.** The env/secret migration is
      manual ([`docs/operations/secrets-env-migration.md`](secrets-env-migration.md));
      verify it's complete for existing `0.10.x` operators.
- [ ] **`OP_ADMIN_PORT` → `OP_HOST_UI_PORT` is a hard cut (no fallback).** The
      legacy name is no longer emitted or read. Operators who customized the admin
      port must re-run setup (`openpalm install` / wizard; `bun run dev:setup` for
      dev) or hand-rename the key in `knowledge/env/stack.env`, else the UI binds
      to the default `3880`. `OP_ADMIN_OPENCODE_PORT` was removed outright. Confirm
      the CHANGELOG [Unreleased] breaking note covers this and call it out in the
      release announcement.

---

## Related files

| File | Role |
|---|---|
| `.github/release-package-groups.json` | Authoritative `platformManifests` + `independentNpmPackages` lists |
| `scripts/bump-platform.sh` | Bumps every platform manifest; syncs the CLI's `@openpalm/lib` floor range |
| `scripts/release.sh` | One-shot release from the **current branch** (bump + stamp + test gate + commit + push branch + tag) |
| `scripts/setup.sh` / `scripts/setup.ps1` | Install scripts; `SCRIPT_VERSION` must match the release tag |
| `.github/workflows/platform-release.yml` | Platform release pipeline and single npm trusted-publisher entry point |
| `.github/workflows/publish-npm-package.yml` | Reusable npm publish child used by the platform release workflow |
| `containers/portal/README.md` | Portal runtime architecture (image bundles baked adapters) |
| `docs/channels/community-channels.md` | Channel adapter authoring guide |
| `docs/technical/package-management.md` | Single-lockfile policy and cross-package reference rules |
