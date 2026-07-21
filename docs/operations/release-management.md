# Release Management

> **Last updated 2026-07-07** against the live codebase at 0.12.52. This supersedes the pre-0.12 `platform-release.yml` documentation.

---

## Release system overview

All releases run through `.github/workflows/release.yml` (manual `workflow_dispatch` only). Version computation and file stamping are handled by `scripts/bump-unit.mjs`. npm publishing flows through the reusable `.github/workflows/publish-npm-package.yml` (OIDC provenance, single trusted publisher).

For an operator-grade, repeatable RC procedure with merge gates, exact commands,
evidence capture, and post-publish verification, use the
[RC release runbook](release-rc-runbook.md).

**TAG-LAST:** The git tag and GitHub release are created as the very last step. "Tag exists = fully published." This makes releases safe to retry — re-running a failed release replays only the failed jobs.

**Always dry-run first:** `dry_run=true` (the default) validates the entire plan, builds every artifact, and runs the test gate without publishing, committing, or tagging.

---

## Units

| Unit | What it publishes | Version anchor |
|---|---|---|
| `platform` | @openpalm/lib, openpalm (CLI), @openpalm/ui, @openpalm/skeleton, @openpalm/guardian (all npm) + CLI binaries + optional Electron | root `package.json` |
| `portals` | `openpalm/portal` Docker image | `portals/discord/package.json` |
| `assistant` | `openpalm/assistant` Docker image | `containers/assistant/VERSION` |
| `guardian` | @openpalm/guardian + @openpalm/skeleton (npm) + optional Docker image | `packages/guardian/package.json` |
| `images` | All Docker images (no npm, no stamp) | root `package.json` (current, no bump) |
| `electron` | Electron installers (mac/linux/win). No npm. | `packages/electron/package.json` |
| `all` | Every unit simultaneously | root `package.json` |

See `docs/technical/release-architecture.md` for detailed per-unit job structure.

---

## Cutting a release

### Step 1 — dry run

```bash
gh workflow run release.yml \
  -f unit=<unit> \
  -f bump=patch \
  -f dry_run=true
```

Or with an explicit version:

```bash
gh workflow run release.yml \
  -f unit=platform \
  -f version=0.12.23-rc.1 \
  -f dry_run=true
```

Review the workflow output. Verify the computed version, the files that will be stamped, and the npm regression guard output. For `platform` and `all`, confirm the stamp includes `packages/cli/package.json` and rewrites its exact `@openpalm/skeleton` pin to the release version.

### Step 2 — real release

Change `dry_run=false`. Everything else is the same.

```bash
gh workflow run release.yml \
  -f unit=platform \
  -f bump=patch \
  -f dry_run=false
```

### Recovery

If a release fails partway through, re-run only the failed jobs:

```bash
gh run rerun <run-id> --failed
```

This preserves passed jobs (including preflight and npm publishes that succeeded) and re-runs only the failed legs. Do NOT dispatch a fresh release for the same version — npm `allow-existing` makes re-runs safe, but a fresh dispatch creates a second bump commit.

---

## Common release scenarios

### Routine platform patch (npm + CLI binaries)

```bash
gh workflow run release.yml -f unit=platform -f bump=patch -f dry_run=false
```

### Platform with Electron bundled

```bash
gh workflow run release.yml -f unit=platform -f bump=minor -f include_electron=true -f dry_run=false
```

### Electron-only release (installers only, no npm republish)

Use this when only `packages/electron/` changed (harness contract, IPC fixes, etc.) and the npm packages are already published at the right version.

```bash
gh workflow run release.yml -f unit=electron -f version=0.12.22 -f dry_run=false
```

### Guardian npm packages (thin-host update without a platform cut)

```bash
gh workflow run release.yml -f unit=guardian -f bump=patch -f dry_run=false
```

This publishes @openpalm/guardian and @openpalm/skeleton. The thin-host guardian container downloads these at startup via `npm install`.

### Docker images only (no npm)

```bash
# Rebuild all images at the current version
gh workflow run release.yml -f unit=images -f dry_run=false

# Rebuild images at a new version
gh workflow run release.yml -f unit=images -f version=0.12.23 -f dry_run=false

# Assistant image only (e.g. OpenCode version bump)
gh workflow run release.yml -f unit=assistant -f bump=patch -f dry_run=false
```

### All units simultaneously (coordinated release)

Replaces the old `unit=major`. Accepts any bump type or an explicit version.

```bash
# Major version bump
gh workflow run release.yml -f unit=all -f bump=major -f dry_run=false

# Specific version (coordinated point release)
gh workflow run release.yml -f unit=all -f version=1.0.0 -f dry_run=false
```

---

## Dist-tag rules

| Version kind | Detection | npm dist-tag | Docker `latest` |
|---|---|---|---|
| Prerelease (`0.12.0-rc.1`) | version contains `-` | `next` | NOT created |
| Stable (`0.12.22`) | no `-` | `latest` | created |

---

## npm OIDC trusted publishing

All npm publishes flow through `publish-npm-package.yml` as the single OIDC trusted publisher. npm validates the **calling workflow** (not the reusable child), so every package's trusted publisher must be configured at npmjs.com as:

- Repository: `itlackey/openpalm`
- Workflow: `release.yml`
- Environment: (none)

Set this for: `@openpalm/lib`, `openpalm`, `@openpalm/ui`, `@openpalm/skeleton`, `@openpalm/guardian`.

---

## Beta → stable cutover checklist

When promoting a `0.X.Y-rc.N` or `0.X.Y-beta.N` line to stable `0.X.Y`:

- [ ] Cut the stable platform release (no `-` suffix) — publishes npm under `latest`, creates Docker `latest` tags
- [ ] Verify `@openpalm/ui@latest` resolves to the current UI (it ships with `platform`)
- [ ] Verify guardian and skeleton `latest` dist-tags are current
- [ ] Confirm Docker `latest` tags exist for all images (first ever `latest` for a new major line)
- [ ] Update `CHANGELOG.md`

## Runtime artifact env pins

These non-secret `stack.env` vars control the exact npm artifacts the running platform installs or serves:

| Variable | Used by | Resolution | Notes |
|---|---|---|---|
| `OP_UI_VERSION` | Host UI updater / seeding path **and** the assistant container entrypoint | Host: `OP_UI_VERSION` -> channel/default logic in the host control plane. Container: `OP_UI_VERSION` -> image `PLATFORM_VERSION` -> hard error | Exact-pins the single `@openpalm/ui` build served everywhere (host process, Electron, container co-process); no `latest` fallback in the container |
| `OP_SKELETON_VERSION` | Assistant + guardian entrypoints | Assistant: `OP_SKELETON_VERSION` -> image `PLATFORM_VERSION` -> hard error. Guardian: `OP_SKELETON_VERSION` -> guardian package version. | Exact-pins `@openpalm/skeleton`; keep equal to the platform version in normal releases |

`OP_UI_PORT` and `OP_UI_BIND_ADDRESS` control the assistant container's published `@openpalm/ui` co-process listener (`127.0.0.1:3800` by default), separate from OpenCode (`OP_ASSISTANT_PORT`, default `3810`) and the host-local UI/dev origin (`OP_HOST_UI_PORT`, default `3880`).

## Release Smoke Checklist

For a full coordinated release candidate, use the dedicated
[`unit=all` RC checklist](unit-all-rc-checklist.md). It expands this smoke list
into a pre-publish and post-publish worksheet covering packaging, deployment,
permissions, upgrade, rootless ownership, browser-backed flows, and shipped
artifact verification.

For the ordered execution procedure that drives that checklist, use the
[RC release runbook](release-rc-runbook.md).

- [ ] `Electron (admin)`: launch Electron against a seeded install; verify the window lands on the UI chat at `http://127.0.0.1:${OP_HOST_UI_PORT:-3880}/chat`, and host routes remain available.
- [ ] `openpalm admin (browser)`: run `openpalm admin`; verify the browser opens on the loopback host UI and `/host`, `/connections`, and `/chat` all load.
- [ ] `assistant-container`: boot the assistant with `OP_UI_VERSION` and `OP_SKELETON_VERSION` overrides; verify the container installs those exact versions, serves `@openpalm/ui` on the assistant's published UI port, and chat reaches the locked default assistant connection.
- [ ] `localhost PWA install`: from the host-served UI origin `http://127.0.0.1:${OP_HOST_UI_PORT:-3880}`, verify installability and that the installed app reopens on the same origin.
- [ ] `hosted PWA install`: from the hosted UI origin (currently `https://app.openpalm.dev` in tests/docs), verify installability, `/api/runtime` compatibility, and that remote connections require HTTPS guardians plus the expected guardian CORS allowlist.

---

## Skeleton seeding

`packages/skeleton/` is the template that seeds OP_HOME on install/upgrade. Published as `@openpalm/skeleton`. Seeded by `seedOpenPalmDir()` — once per version (`.skeleton-version` stamp guards re-seeding). Existing user files are never overwritten.

Resolution order at runtime:
1. `OPENPALM_REPO_ROOT` env (dev override)
2. `OPENPALM_SKELETON_DIR` env (set by Electron from `process.resourcesPath/openpalm-skeleton`)
3. `require.resolve('@openpalm/skeleton/package.json')` (CLI dep)
4. Source-relative fallback (`packages/skeleton/` relative to lib source)

---

## Migrations

Two systems in `packages/lib/src/control-plane/migrations.ts`:

**Layout migrations** — numbered integer steps that restructure OP_HOME on-disk layout. Run at install and upgrade.

**Release migrations** — version-gated operations. Each is pinned to the rc of the release that introduces it. Fires once for any user upgrading past that version. Added by appending to `RELEASE_MIGRATIONS`.

Version pin rule: pin to the rc of the upcoming release, not the prior stable. `v0.12.19-rc.1` was chosen instead of `v0.12.18-rc.1` because v0.12.18 stable was already published before the migration landed — stable > rc in semver, so users on stable would have skipped a rc-pinned migration.

---

## Related files

| File | Role |
|---|---|
| `.github/workflows/release.yml` | Single release orchestrator |
| `.github/workflows/publish-npm-package.yml` | Reusable OIDC npm publish child |
| `scripts/bump-unit.mjs` | Version computation + file stamping |
| `scripts/set-version.mjs` | Stamps a single package.json to a given version |
| `packages/skeleton/` | OP_HOME template, published as @openpalm/skeleton |
| `packages/lib/src/control-plane/migrations.ts` | Layout + release migration harness |
| `docs/technical/release-architecture.md` | Full per-unit job structure and design |
