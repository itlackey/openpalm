# Artifact Delivery Pattern

> **As built 2026-07-07**. This documents the current runtime delivery model used by OpenPalm artifacts.

## Rule

OpenPalm delivers updatable runtime content as npm artifacts with explicit version resolution. Runtime installs never fall back to `latest` in production.

There are two strategies:

| Strategy | Use when | Resolution |
|---|---|---|
| Exact pin | API/data compatibility or seeded-file hashes must stay in lockstep | `OP_*_VERSION` override -> `PLATFORM_VERSION`/paired image version -> hard error |
| Reviewed package manifest | Tooling that can advance independently within a managed package.json | Pinned or ranged dependency in the baked `package.json`, applied by `bun install`/`bun update` |

## Current Exact-Pin Artifacts

| Artifact | Package | Installed by | Resolution chain |
|---|---|---|---|
| Host UI build | `@openpalm/ui` | Host control plane seeding/updater | Host-side UI logic; not a container entrypoint artifact |
| Container UI co-process | `@openpalm/ui` | Assistant container entrypoint | `OP_UI_VERSION` -> `PLATFORM_VERSION` -> hard error |
| Skeleton seed | `@openpalm/skeleton` | Assistant + guardian entrypoints; CLI local dep for repo/npm installs | `OP_SKELETON_VERSION` -> `PLATFORM_VERSION` or guardian package version -> hard error/paired default |
| Guardian package | `@openpalm/guardian` | Guardian thin-host entrypoint | `OP_GUARDIAN_NPM_VERSION` -> `GUARDIAN_VERSION` -> hard error |

## Current Reviewed Tool Package Pattern

| Runtime | Source | Install action |
|---|---|---|
| Assistant tools | `/opt/openpalm/tools/package.json` with host bind overlay | `bun update --cwd /opt/openpalm/tools --production` |
| Guardian tools | `/opt/openpalm/tools/package.json` with host bind overlay | `bun install --cwd /opt/openpalm/tools --production` |

This is deliberately different from the exact-pin artifacts. Tools are governed by an editable package manifest, not by one env var per tool.

## Skeleton Resolution Chain

The shipped skeleton source resolution chain is:

1. `OPENPALM_REPO_ROOT` -> repo `packages/skeleton/`
2. `OPENPALM_SKELETON_DIR` -> Electron bundled extraResources skeleton
3. `require.resolve('@openpalm/skeleton/package.json')` -> installed package dir
4. source-relative repo fallback when running from source
5. npm download path when no local source exists

The Electron bundled skeleton remains intentional so a fresh desktop install can seed offline.

## Release Contract

The release workflow stamps versioned manifests through `scripts/set-version.mjs` and `scripts/bump-unit.mjs`.

For the platform unit this means:

- root, lib, skeleton, guardian, cli, ui, electron, and admin-tools package versions are stamped together
- `packages/cli/package.json` keeps an exact `@openpalm/skeleton` pin equal to the platform version
- the npm regression guard treats `@openpalm/skeleton` and `@openpalm/guardian` as dual-owned packages

That exact CLI skeleton pin matters because npm-installed CLI builds resolve the seeding skeleton through their own dependency tree.

## Runtime-Specific Delivery Paths

### Host UI

- Resolved into `OP_HOME/data/ui`
- Updated by the host control plane
- Served on the host-local origin `http://127.0.0.1:${OP_HOST_UI_PORT:-3880}`, opened by `openpalm app` and preferred by Electron when healthy
- Supervised by Electron or `openpalm admin`

### Assistant Container UI Co-process

- Installed into `/opt/openpalm/ui`
- Served as a supervised co-process from its adapter-node build (`node build/index.js`)
- Published on `${OP_UI_PORT:-3810}` externally and port `3000` internally
- Seeded with `runtime-config.json` containing one locked default connection

### Hosted PWA

- Same `@openpalm/ui` build
- Served from the hosted origin used by current tests/docs: `https://app.openpalm.dev`
- Requires guardian TLS + CORS for remote instance connections

## Failure Policy

- Version resolution failure is loud: missing version source is an error.
- Install failure after version resolution is tolerant only where the entrypoint already has an on-disk artifact to keep using.
- No runtime path silently substitutes `latest`.

## Related Files

| File | Role |
|---|---|
| `scripts/set-version.mjs` | Shared manifest-stamping helper |
| `scripts/bump-unit.mjs` | Release-unit version computation and stamping |
| `.github/workflows/release.yml` | Release DAG |
| `packages/lib/src/control-plane/ui-assets.ts` | Host UI artifact delivery |
| `containers/assistant/entrypoint.sh` | Assistant-container runtime install path |
| `containers/guardian/entrypoint.sh` | Guardian thin-host runtime install path |
