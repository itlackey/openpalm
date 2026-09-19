# Releasing the stack

The release surface is deliberately small:

- `openpalm/assistant`, `openpalm/guardian`, and `openpalm/portal`
  multi-architecture images;
- five standalone CLI binaries;
- optional macOS, Linux, and Windows Admin artifacts;
- an optional versioned Claude Desktop `.mcpb` extension; and
- the zero-dependency `openpalm` npm bootstrap.

## Versioning

One product version covers the root, Skeleton, Lib, CLI, Guardian, Portal,
Admin, and Claude Desktop manifests. Image defaults are stamped in the same
operation.

Preview or stamp the release:

```bash
VERSION=0.14.0 node scripts/bump-release.mjs
VERSION=0.14.0 STAMP=true node scripts/bump-release.mjs
bun install
```

Review all changed manifests, Compose defaults, and `bun.lock` before a release.

0.14 is a fresh-install boundary. Guided provider sign-in/readiness, the
previewable allowlisted importer, and restricted durable recurring tasks are
implemented and covered by unit/security gates. No release artifact may
interpret a 0.13 home as the new control plane or silently activate an imported
schedule.

## Gate

Run locally:

```bash
bun install --frozen-lockfile
bun run check
bun run test
bun run lint
bun run --cwd packages/cli build
bun run --cwd packages/claude-desktop pack
bun run --cwd packages/electron bundle
```

CI uses the same commands through `.github/workflows/gates.yml`, runs the
complete deterministic acceptance lane, validates all Compose profiles, builds
all three images, asserts non-root image users, and runs image startup/security
smokes.

## Workflow

Dispatch `.github/workflows/release.yml` with:

- `version`: the already-stamped semantic version;
- `dry_run: true` first.

The workflow validates stamps, calls the shared gate, builds every artifact,
creates checksums and `release-assets-manifest.json`, and runs the same asset validator for dry and live releases. The required set is five CLI
binaries, five updater-free Admin artifacts, the versioned MCPB, and checksums.
A live dispatch from `main` or `release/*` additionally pushes
SBOM/provenance-enabled images, signs immutable image digests with Cosign,
creates the Gitea release, and publishes the npm bootstrap with provenance.
Configure a repository Actions secret named `GITEA_TOKEN` with release-write
access before a live dispatch.

The workflow never publishes the private Guardian, Portal, Lib, Skeleton, or
Admin packages to npm.
