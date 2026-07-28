# Artifact Delivery Pattern

> As built for the 0.13.0 release line.

## Rule

Release images are complete at build time. Container startup must not depend on
installing ordinary runtime content from npm. The one retained runtime package
installer is Guardian's explicit thin-host override path.

## Delivery Paths

| Artifact | Delivery | Version source | Runtime behavior |
|---|---|---|---|
| Host UI | GitHub Release `openpalm-host-assets-<version>.tar.gz` into `OP_HOME/data/ui` | Coordinated platform release/channel resolution | SHA-256-verified and atomically swapped by the host control plane |
| Assistant UI | Baked into `/opt/openpalm/ui` during image build | `PLATFORM_VERSION` build arg | Entrypoint supervises the baked build; no runtime install or version override |
| Assistant tools | Baked from `containers/assistant/tools/package.json` | Exact manifest pins | No boot-time update |
| Guardian package | Baked into `/opt/openpalm/guardian-pkg` | `GUARDIAN_VERSION` build arg | Existing-version check is normally a no-op; `OP_GUARDIAN_NPM_VERSION` enables an explicit override install |
| Guardian tools | Baked from `containers/guardian/tools/package.json` | Exact manifest pins | No boot-time update |
| Portal adapters | Candidate-local SDK and adapter workspaces packed during image build | Candidate source versions | No runtime adapter install |

Changing either baked assistant artifact requires a new assistant image.

## Host Skeleton Resolution

Host install/update code resolves skeleton source in this order:

1. `OPENPALM_REPO_ROOT` for a source checkout
2. `OPENPALM_SKELETON_DIR` for Electron bundled resources
3. the source-relative repository fallback
4. an integrity-checked GitHub host-assets release when no local source is available

The Electron bundle keeps an offline skeleton seed for a fresh desktop install.

## Guardian Thin Host

The Guardian image bakes candidate-local `@openpalm/guardian`, so default boot
is offline. Its entrypoint still supports downstream distributions:

- `OP_GUARDIAN_NPM_VERSION` overrides the Guardian npm version or semver range.
- `OP_GUARDIAN_PACKAGE` can select a compatible composition package.

These are Guardian-only override paths. They do not restore runtime package
installation to the assistant.

## Release Contract

The platform release stamps root, skeleton, lib, CLI, and UI source manifests in
lockstep. Only the zero-dependency `openpalm` bootstrap publishes to npm;
skeleton, lib, and UI remain private source workspaces. Guardian is an
independent package unit, and Electron plus admin tools are an independent
harness unit.

The portal SDK and the Discord/Slack adapters form the `portals` release unit.
They are stamped and published together, with `@openpalm/portal-sdk` published
before the adapters. Product portal images pack all three candidate-local
workspaces directly and do not wait for extension publication.

Internal workspace references intentionally use `workspace:*` where local
workspace coupling is desired. `bun pm pack` resolves those references to the
on-disk package version in the published tarball.

## Runtime Surfaces

### Host UI

- Installed under `OP_HOME/data/ui`
- Served by `openpalm app`, `openpalm admin`, or Electron
- Defaults to host port `3880`
- Updated by the host control plane with registry integrity verification

### Assistant UI

- Served from the image-baked `/opt/openpalm/ui/node_modules/@openpalm/ui/build`
- Runs as a supervised adapter-node child on container port `3000`
- Published on host port `3800` by default
- Seeds one locked local connection to the same-origin `/oc` path

### PWA

- Uses the same `@openpalm/ui` build
- Caches only hashed/static assets; navigation, API, auth, and SSE stay network-only
- Installs from the local `openpalm app` origin or an operator-provided HTTPS origin

## Failure Policy

- A release build without the version needed to bake an artifact must fail or
  be explicitly identified as an unversioned local/dev build.
- Host asset downloads verify the GitHub release checksum and manifest before activation.
- Guardian override installation failure is fatal after bounded retries.
- No production runtime silently substitutes `latest` for a missing exact
  artifact version.

## Related Files

| File | Role |
|---|---|
| `containers/assistant/Dockerfile` | Bakes candidate-local assistant UI and tools |
| `containers/assistant/entrypoint.sh` | Supervises baked assistant artifacts |
| `containers/guardian/Dockerfile` | Bakes candidate-local Guardian and tools |
| `containers/guardian/entrypoint.sh` | Guardian thin-host override path |
| `containers/portal/Dockerfile` | Packs candidate-local portal SDK and adapters |
| `packages/lib/src/control-plane/ui-assets.ts` | Host UI and skeleton delivery |
| `scripts/set-version.mjs` | Shared manifest version stamping |
| `scripts/bump-unit.mjs` | Release-unit stamping |
| `.github/workflows/release.yml` | Publish/build DAG |
