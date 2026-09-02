# Artifact Delivery Pattern

> As built for the 0.13.0 release line.

## Rule

Every first-party release artifact — container image, CLI binary, desktop app —
is complete at build time. None of them performs a runtime content download,
and container startup must not depend on installing ordinary runtime content
from npm. The retained runtime package paths are Guardian's explicit thin-host
override and Paperclip's bounded first-agent-use install of exact-pinned
OpenCode config dependencies into a regenerable cache. Paperclip is a
digest-pinned third-party image that OpenPalm deliberately does not rebuild;
its dependency bootstrap is verified before use and is not a startup install.

## Delivery Paths

| Artifact | Delivery | Version source | Runtime behavior |
|---|---|---|---|
| Host UI + skeleton | Embedded in the CLI binary and in the Electron app bundle | Artifact build version | Materialized into `OP_HOME/data/ui` (and skeleton into `OP_HOME`) from the artifact's own embedded copy; no download, no verification step — the artifact is the trust boundary |
| Assistant UI | Baked into `/opt/openpalm/ui` during image build | `PLATFORM_VERSION` build arg | Entrypoint supervises the baked build; no runtime install or version override |
| Assistant tools | Baked from `containers/assistant/tools/package.json` | Exact manifest pins | No boot-time update |
| Guardian package | Baked into `/opt/openpalm/guardian-pkg` | `GUARDIAN_VERSION` build arg | No runtime override exists: the entrypoint runs the baked package unconditionally |
| Guardian tools | Baked from `containers/guardian/tools/package.json` | Exact manifest pins | No boot-time update |
| Portal adapters | Candidate-local SDK and adapter workspaces packed during image build | Candidate source versions | No runtime adapter install |
| Paperclip OpenCode config dependencies | Managed exact manifest beside the digest-pinned third-party image | Exact AKM pins plus the image's OpenCode version | Installed on first agent use into regenerable cache; bounded, CLI- and tool-hook-checked, and fail-closed |

Changing either baked assistant artifact requires a new assistant image.

## Host Skeleton Resolution

Host install code resolves skeleton source in this order:

1. `OPENPALM_REPO_ROOT` for a source checkout
2. the artifact's own embedded/bundled skeleton (packed into the CLI binary or
   the Electron app bundle)

There is no remote fallback: every artifact carries its own skeleton copy, so
resolution never leaves local disk.

## Guardian Thin Host

The Guardian image bakes candidate-local `@openpalm/guardian`, so default boot
is offline. Its entrypoint still supports downstream distributions:


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

- Materialized under `OP_HOME/data/ui` from the CLI binary's or Electron
  bundle's own embedded copy
- Served by `openpalm app`, `openpalm admin`, or Electron
- Defaults to host port `3880`
- Updated by updating the artifact itself (a new CLI binary, or a new
  electron-updater release); there is no separate in-place UI update

### Assistant UI

- Served from the image-baked `/opt/openpalm/ui/node_modules/@openpalm/ui/build`
- Runs as a supervised adapter-node child on container port `3000`
- Published on host port `3800` by default
- Seeds one locked local connection to the same-origin `/oc` path

### PWA

- Uses the same `@openpalm/ui` build
- Caches only hashed/static assets; navigation, API, auth, and SSE stay network-only
- Installs from any origin the browser treats as secure: the local `openpalm app`
  origin, `http://localhost`, or an operator-provided HTTPS origin. Every process
  advertises `pwa:install`, including the assistant container's UI child; a
  plain-HTTP LAN address is not a secure context, so the browser offers no
  install there and the settings affordance says so rather than staying silent

## Failure Policy

- A release build without the version needed to bake an artifact must fail or
  be explicitly identified as an unversioned local/dev build.
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
| `packages/lib/src/control-plane/ui-assets.ts` | Local seeding/materialization of the embedded host UI and skeleton into `OP_HOME` |
| `scripts/set-version.mjs` | Shared manifest version stamping |
| `scripts/bump-unit.mjs` | Release-unit stamping |
| `.github/workflows/release.yml` | Publish/build DAG |
