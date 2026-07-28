# Package Management

## Single Lock File

The repository has one dependency lock file: root `bun.lock`. Nested Bun locks
and `package-lock.json` files are not committed.

Rules:

1. Run dependency-changing installs from the repository root.
2. CI uses `--frozen-lockfile` to detect package manifest changes that were not
   reflected in `bun.lock`.
3. Root `.npmrc` sets `package-lock=false`; `.gitignore` is a second guard.
4. Do not introduce a package-local lock to make one workspace behave as a
   separate repository.

```bash
bun add <package>
bun add <package> --cwd packages/<workspace>
bun install --frozen-lockfile
```

## Internal Workspace References

Internal `@openpalm/*` references intentionally use `workspace:*` when a
workspace package should resolve to its local peer during development. Bun's
pack step is used for candidate-local image assembly and packages that remain
public:

```bash
bun pm pack
```

`bun pm pack` replaces `workspace:*` with the concrete on-disk workspace
version in the tarball. Packed artifacts therefore receive normal semver, not
the workspace protocol. Private platform workspaces keep `workspace:*`; they
are not registry contracts.

## Release Units

Platform manifests are stamped in lockstep for a platform release:

- root
- `@openpalm/skeleton`
- `@openpalm/lib`
- CLI `openpalm`
- `@openpalm/ui`

Guardian is its own one-manifest unit. Electron and Electron admin tools form a
separate harness unit. No manifest belongs to more than one canonical owner.

The portal SDK and adapters are one portal unit:

- `@openpalm/portal-sdk`
- `@openpalm/discord-portal`
- `@openpalm/slack-portal`

The extension publish DAG releases the SDK before either adapter. The product
release is separate: host assets and images are assembled from candidate-local
source, and only the `openpalm` bootstrap publishes after public GitHub assets
are verified.

## Docker Builds

Docker builds do not consume the monorepo's hoisted `node_modules` or root lock
as if they were runtime volumes. Each image installs from the explicit manifest
copied into its build context:

- Assistant tools use `containers/assistant/tools/package.json`.
- Guardian tools use `containers/guardian/tools/package.json`.
- Portal images copy and pack `packages/portal-sdk`, `portals/discord`, and
  `portals/slack` from candidate source.
- Guardian and portal package source/dependencies are installed during image
  build, after the required package files are copied.

The resulting images are immutable and image-baked. Assistant and portal
entrypoints do not update these dependency trees at boot. Guardian retains only
its documented explicit thin-host package override.

## Verification

After dependency or version changes, run the narrow package tests plus:

```bash
bun install --frozen-lockfile
bun run lint
bun run test
```

See [`../operations/release-management.md`](../operations/release-management.md)
for release execution.
