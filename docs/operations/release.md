# Releasing the lean stack

The release surface is deliberately small:

- `openpalm/assistant`, `openpalm/guardian`, and `openpalm/portal`
  multi-architecture images;
- five standalone CLI binaries;
- optional macOS, Linux, and Windows Admin artifacts;
- an optional versioned Claude Desktop `.mcpb` extension; and
- the zero-dependency `openpalm` npm bootstrap.

## Versioning

The platform release unit contains the root, Skeleton, Lib, CLI, Guardian,
Portal, and Claude Desktop extension manifests. Admin is a separate version unit. Image defaults are stamped
only in `packages/skeleton/system/stack/stack.compose.yml`.

Preview or stamp a unit:

```bash
UNIT=platform VERSION=0.14.0 node scripts/bump-unit.mjs
UNIT=platform VERSION=0.14.0 STAMP=true node scripts/bump-unit.mjs
UNIT=electron VERSION=0.14.0 STAMP=true node scripts/bump-unit.mjs
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

CI uses the same commands through `.github/workflows/gates.yml`, validates all
Compose profiles, builds all three images, and asserts non-root image users.

## Workflow

Dispatch `.github/workflows/release.yml` with:

- `version`: the already-stamped semantic version;
- `dry_run: true` first.

The workflow validates stamps, calls the shared gate, builds every artifact,
and collects checksums. A live dispatch from `main` or `release/*` additionally
pushes SBOM/provenance-enabled images, signs immutable image digests with
Cosign, creates the GitHub release, and publishes the npm bootstrap with
provenance.

The workflow never publishes the private Guardian, Portal, Lib, Skeleton, or
Admin packages to npm.
