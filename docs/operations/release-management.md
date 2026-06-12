# Release Management

This guide is the authoritative reference for cutting OpenPalm releases. It
covers the three independent publish tracks, exactly which packages and images
belong to each, and the step-by-step procedures for all three.

> **Ground truth.** The proven release flow described here was established and
> verified on the `release/0.11.0` line. Where this guide and a script's inline
> comments disagree, trust the running script — and open a PR to fix the comment.

---

## The three tracks

OpenPalm ships on three completely separate cadences:

### Track A — Platform release (single coordinated version)

All platform packages and images share **one** version and ship **together** in a
single release triggered by a `v*` git tag. You never publish one platform
package on its own; you cut a whole platform release.

The authoritative manifest list lives in
[`.github/release-package-groups.json`](../../.github/release-package-groups.json)
under `platformManifests`. `scripts/bump-platform.sh` reads that list.
`packages/ui` is **not** in `platformManifests` — it is independently versioned
(Track C).

### Track B — Channel adapters (independently versioned)

The three first-party channel adapters are versioned and published **on their own
schedule**, decoupled from the platform. A typo fix in the Discord adapter does
**not** require a platform release — you bump and publish just that one package,
and it reaches users on the next container restart (see
[Publishing a channel adapter](#publishing-a-channel-adapter-track-b)).

### Track C — UI (`@openpalm/ui`, independently versioned)

The SvelteKit operator UI is versioned and published **on its own schedule**,
decoupled from the platform. It ships as an adapter-node bundle to npm
(`@openpalm/ui`, `files: ["build"]`, zero runtime deps) and is fetched at
runtime from the registry by `packages/lib/src/control-plane/ui-assets.ts`
(integrity-verified). It is **not** a GitHub release asset. Publishing is handled
by `.github/workflows/publish-ui.yml`, which calls the same reusable
`publish-npm-package.yml` as the channel adapters (with `needs-build: true` to
run `bun run build` before packing). The Electron app also bundles the UI — the
`build-electron-artifacts` job in `release.yml` runs `bun run ui:build`
separately to produce a self-contained installer.

> **`workflow_dispatch` requires `main`.** GitHub only allows dispatching a
> workflow that exists on the repository's **default branch** (`main`).
> `publish-ui.yml` must be present on `main` to be dispatchable from the Actions
> UI or via `gh workflow run`. The push trigger (`paths: packages/ui/**`) also
> fires only on pushes to `main`.

---

## Per-layer table

| Layer | What it is | How it's published | Trigger | Artifact(s) | Track |
|---|---|---|---|---|---|
| `openpalm` (CLI) | Host orchestrator. **npm name is `openpalm`**, not `@openpalm/cli`. | `platform-release.yml` | `workflow_dispatch` | npm | A (platform) |
| `@openpalm/lib` | Shared control-plane library | `platform-release.yml` | `workflow_dispatch` | npm | A (platform) |
| `@openpalm/ui` (`packages/ui`) | SvelteKit operator UI + API (adapter-node bundle, `files:["build"]`) | `publish-ui.yml` → `publish-npm-package.yml` | push to `main` touching `packages/ui/**`, or `workflow_dispatch` | npm only (`next` for prereleases, `latest` for stable) | **C (independent)** |
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

> **Platform packages that do NOT publish to npm.** Of the seven `platformManifests`
> entries, only two publish to npm: `@openpalm/lib` and `openpalm` (CLI). The
> root manifest, `packages/portal-runtime`, `core/guardian`, `packages/electron`,
> and `packages/electron/admin-tools` are version-stamped for coordination but ship
> as Docker images / GitHub assets only. `bump-platform.sh` stamps the version on
> all seven so the lockfile and cross-references stay consistent.
>
> **`packages/ui` is NOT in `platformManifests`.** It is in `independentNpmPackages`
> and published by `publish-ui.yml` (Track C) — `release.sh` / `bump-platform.sh`
> do not touch it.

---

## Dist-tag rules

| Release kind | Detection | npm dist-tag | Docker `latest` / `latest-*` |
|---|---|---|---|
| Prerelease (`0.11.0-beta.15`) | version contains `-` | `next` | **not created** (gated off) |
| Stable (`0.11.0`) | no `-` | `latest` | created |

- `release.yml` adds `--tag next` for prereleases on every npm publish job.
- Docker `latest` (and voice `latest-cpu` / `latest-cu121`) tags are gated with
  `enable=${{ ... prerelease != 'true' }}`, so during a beta line **only the
  immutable `vX.Y.Z` Docker tags exist** — never a moving `latest`.
- The reusable `publish-npm-package.yml` applies the same rule to `@openpalm/ui`
  (`-` in the version → `--tag next`).

---

## Cutting a platform release (Track A)

A platform release is triggered by pushing a `v<version>` tag. The
`prepare-tag` job in `release.yml` behaves differently depending on how the tag
came to exist:

- **`workflow_dispatch`** — the job *bumps* all platform manifests, *stamps* the
  setup scripts' `SCRIPT_VERSION`, regenerates `bun.lock`, commits, and *creates*
  the tag for you.
- **Plain tag push** — the job only *verifies* that every platform manifest **and
  both setup scripts** already equal the release version, and **fails otherwise**.
  It does not bump anything.

This means: if you create the tag yourself (the manual flow below), the repo state
at the tagged commit must already be fully synchronized, or the release fails the
guard.

### What must equal the release version before a tag push

1. Every manifest in `platformManifests` (`.version`).
2. `scripts/setup.sh` — `SCRIPT_VERSION="<version>"`.
3. `scripts/setup.ps1` — `$ScriptVersion = '<version>'`.
4. `bun.lock` (regenerated so workspace versions match).

The CLI's internal `@openpalm/lib` floor range (`">=<version> <N.0.0"`) must also
track lib's version — `bump-platform.sh` handles this automatically.

### Option 1 — proven manual flow (used on `release/0.11.0`)

`scripts/release.sh` hardcodes `git push origin main` and has interactive
prompts, which do not fit a `release/<x>` branch. The manual flow used on this
line instead:

```bash
VERSION=0.11.0-beta.16

# 1. Bump all platform manifests (+ sync the CLI's @openpalm/lib floor range)
./scripts/bump-platform.sh "$VERSION"

# 2. Stamp the setup scripts (release.yml's tag-push guard verifies these)
sed -i "s/^SCRIPT_VERSION=\".*\"/SCRIPT_VERSION=\"${VERSION}\"/" scripts/setup.sh
sed -i "s/^\$ScriptVersion = '.*'/\$ScriptVersion = '${VERSION}'/" scripts/setup.ps1

# 3. Regenerate the lockfile so workspace versions match the bumped manifests
bun install

# 4. Test gate (must pass before tagging)
bun run test       # channels-sdk, guardian, cli, all channel packages (not UI)
bun run ui:check   # svelte-check + TypeScript

# 5. Commit + push the release-prep commit on the current branch
git add -A
git commit -m "chore: release ${VERSION}"
git push origin "$(git rev-parse --abbrev-ref HEAD)"

# 6. Tag and push — THIS triggers release.yml
git tag "v${VERSION}"
git push origin "v${VERSION}"
```

The tag push runs `release.yml`'s verify path; if any of the four synchronized
items is off, the run fails fast with a clear error.

> `scripts/release.sh` automates steps 1–6 (it also stamps the setup scripts and
> runs the same test gate), but assumes `main` and pushes there. Use it only when
> releasing from `main`; otherwise use the manual flow above.

### Option 2 — `workflow_dispatch`

Run the **Release** workflow from the GitHub Actions UI (or
`gh workflow run release.yml`) with:

- `version` — the release version (required for a real release).
- `dry_run` — `true` to build every artifact but skip all bumping, tagging,
  pushing, and publishing (useful to validate matrices).

On a real dispatch, `prepare-tag` bumps manifests, stamps setup scripts,
regenerates the lockfile, commits to the dispatch branch, and creates + pushes the
tag — which then drives the rest of the workflow. Tag creation is idempotent for
republish: if the tag already points at `HEAD`, it is left alone; if it points
elsewhere, the job refuses to move it.

### Republish / re-cut safety

`release.yml` is built to be re-runnable for the same tag:

- Docker, CLI, and Electron build matrices are `fail-fast: false`, so one flaky
  leg can be re-run without cancelling its siblings.
- The **Publish GitHub release** job deletes any existing release for the tag
  first (preserving the git tag), then recreates it — avoiding
  `softprops/action-gh-release` leaving a zero-asset release on a re-cut.
- Every npm publish job treats "version already published" as success.

---

## Publishing a channel adapter (Track B)

Channel adapters publish to **npm only** and reach users **without an image
rebuild**. The `openpalm/channel` image bundles the `@openpalm/channels-sdk`
framework; the adapter itself is installed at container start by
[`core/channel/start.sh`](../../core/channel/start.sh) via
`bun add --exact "$CHANNEL_PACKAGE"`.

### How to publish one adapter

Two triggers feed `publish-npm-package.yml`:

1. **Automatic** — push to `main` that touches `packages/channel-<name>/**`. The
   workflow auto-bumps the patch (or prerelease segment) if the current version is
   already on npm, publishes, then commits the bump back.
2. **Manual** — run the matching workflow (`Publish @openpalm/channel-<name>`)
   via `workflow_dispatch` with a `version` input: an explicit version
   (`1.2.0`), or a bump keyword (`major` / `minor` / `patch` / `prerelease`).

Prerelease versions (containing `-`) publish under the npm `next` tag.

### How an adapter update reaches users

`CHANNEL_PACKAGE` in
[`.openpalm/config/stack/channels.compose.yml`](../../.openpalm/config/stack/channels.compose.yml)
carries a dist-tag, e.g. `@openpalm/channel-discord@next`. On container restart,
`start.sh` re-resolves that tag, so a freshly published `next` adapter rolls out
automatically — no image rebuild, no platform release.

### Why adapters must declare channels-sdk as an OPTIONAL peer

Adapters declare:

```jsonc
{
  "peerDependencies":     { "@openpalm/channels-sdk": ">=0.8.0 <1.0.0" },
  "peerDependenciesMeta": { "@openpalm/channels-sdk": { "optional": true } }
}
```

Without `optional: true`, `bun add <adapter>` resolves the peer to the latest
**stable** channels-sdk (semver ranges exclude prereleases) and installs it
**over** the framework bundled in the image — breaking the running entrypoint
during a beta line. Optional tells the installer "the host already provides the
framework." See [`core/channel/README.md`](../../core/channel/README.md) and
[`docs/channels/community-channels.md`](../channels/community-channels.md).

The entrypoint imports the adapter by its **bare package name**, stripping any
trailing `@<version>` / `@<tag>` from `CHANNEL_PACKAGE`
([`channel-entrypoint.ts`](../../packages/channels-sdk/src/channel-entrypoint.ts)).

---

## Publishing the UI (Track C)

`@openpalm/ui` publishes to **npm only** (no Docker image, no GitHub release
asset). The published artifact is the adapter-node SvelteKit bundle
(`files: ["build"]`, self-contained, zero runtime deps). At runtime,
`packages/lib/src/control-plane/ui-assets.ts` fetches the tarball from the npm
registry and verifies its integrity before installing it.

### How to publish the UI

Two triggers feed `publish-npm-package.yml` (via `publish-ui.yml`):

1. **Automatic** — push to `main` that touches `packages/ui/**`. The workflow
   auto-bumps the patch (or prerelease segment) if the current version is already
   on npm, runs `bun run build` to produce the bundle, publishes, then commits
   the bump back.
2. **Manual** — run the **Publish @openpalm/ui** workflow
   (`gh workflow run publish-ui.yml`) with an optional `version` input: an
   explicit version (`1.2.0`) or a bump keyword
   (`major` / `minor` / `patch` / `prerelease`).

> **Dispatch only works from `main`.** `workflow_dispatch` is only available when
> the workflow file exists on the repository's default branch (`main`). If you
> need to publish a UI build from a release branch, cherry-pick or merge the UI
> changes to `main` first, or trigger via a `packages/ui/**` push to `main`.

### OIDC trusted publishing

`publish-ui.yml` (and every caller of `publish-npm-package.yml`) requests
`id-token: write` so that `npm publish --provenance` works without a stored
`NPM_TOKEN`. Provenance attestations appear on the npm package page.

### Why the UI is NOT in the platform release

The UI can be updated independently of Docker images and CLI binaries — an
operator's running stack picks up a new UI version without an image restart. This
mirrors the channel adapter model. The `release.yml` workflow still builds the UI
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
- [ ] **Publish a stable `@openpalm/ui` version (Track C)** so `@latest` on npm
      resolves to the current UI. Either merge the UI changes to `main` (auto-trigger
      via `packages/ui/**` push) or dispatch `publish-ui.yml` with an explicit
      version. Without this step, any fresh install that fetches `@openpalm/ui@latest`
      would pull the previous stable line's UI.
- [ ] Publish stable versions of the three channel adapters (Track B) so a
      `@latest` adapter actually exists.
- [ ] **Flip `CHANNEL_PACKAGE` from `@next` to `@latest`** (or a pinned stable
      version) in
      [`.openpalm/config/stack/channels.compose.yml`](../../.openpalm/config/stack/channels.compose.yml).
      Leaving it `@next` would keep pulling prerelease adapters; leaving it bare /
      `@latest` *before* stable adapters exist pulls the old `0.10.x` line and the
      channel crashes.
- [ ] Verify `scripts/setup.sh` / `scripts/setup.ps1` `SCRIPT_VERSION` equals the
      stable version (the tag-push guard enforces this).
- [ ] Update `CHANGELOG.md`.

---

## 0.11.0 stable — outstanding cleanup & work

Concrete items deferred during the `0.11.0-beta` line that must be handled when
cutting stable `0.11.0` (captured 2026-06-02 at `beta.15`):

**Required for a correct stable cut**

- [x] **Move `akm-cli` off the `next` prerelease tag.** Done — `core/assistant/Dockerfile`
      pins `ARG AKM_CLI_VERSION=0.8.0` (stable). The guardian no longer installs
      akm-cli (its OpenCode is a pure moderator), so there is no second pin to keep
      in lockstep; CI validates the assistant pin and only compares the guardian if
      it ever reintroduces one. NOTE: the `akm-opencode` OpenCode plugin
      (`.openpalm/config/assistant/opencode.jsonc`) is still `@latest` (0.7.6) — no
      stable 0.8.0 plugin is published yet (0.8.0 line is on `@next`); 0.7.6 works
      against the 0.8.0 CLI (the plugin shells to stable CLI commands). Revisit when
      a stable `akm-opencode` 0.8.0 ships.
- [ ] **Publish a stable `@openpalm/ui` version** (Track C, via `publish-ui.yml`).
      During the `0.11.x` beta line, `@openpalm/ui` has only been published with
      prerelease versions (→ `next` dist-tag). A fresh install on the stable release
      must be able to resolve `@openpalm/ui@latest`. Merge the current `packages/ui`
      state to `main` (or dispatch `publish-ui.yml` with an explicit stable version)
      to create the first `latest` UI tag.
- [ ] **Republish the three channel adapters as a stable (non-prerelease) version**
      so they land on npm `@latest`. Today `@latest` for `channel-*` is still the
      old `0.10.x` line; `@next` holds `0.11.x`. Until stable adapters exist,
      `CHANNEL_PACKAGE@latest` resolves to the broken `0.10.x` (env-secret) adapter.
- [ ] **Then flip `CHANNEL_PACKAGE` `@next` → `@latest`** in
      `.openpalm/config/stack/channels.compose.yml` (4 occurrences).
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
| `.github/workflows/release.yml` | Platform release pipeline (Track A) |
| `.github/workflows/publish-ui.yml` | UI publish trigger (Track C); calls `publish-npm-package.yml` with `needs-build: true` |
| `.github/workflows/publish-npm-package.yml` | Reusable npm publish used by the UI (Track C) and channel-adapter (Track B) workflows |
| `.github/workflows/publish-channel-{api,discord,slack}.yml` | Per-adapter publish triggers (Track B) |
| `core/channel/README.md` | Channel runtime architecture (image bundles framework, adapters at runtime) |
| `docs/channels/community-channels.md` | Channel adapter authoring guide |
| `docs/technical/package-management.md` | Single-lockfile policy and cross-package reference rules |
