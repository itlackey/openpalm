# Release Management

All platform releases are manually dispatched through
`.github/workflows/release.yml`. Read
[`release-architecture.md`](../technical/release-architecture.md) before using a
partial unit.

## Preconditions

1. Commit and push every intended source change.
2. Record the exact target-branch SHA and keep the branch unchanged until the
   live source gate completes.
3. Run the full local verification matrix.
4. Confirm all eight npm packages authorize trusted publisher workflow
   `release.yml` for repository `itlackey/openpalm`.
5. Confirm the target npm versions, Docker tags, and Git tags are unused.

The workflow repeats registry and tag checks and fails closed on query errors.

## Units

| Unit | Use |
|---|---|
| `all` | Normal coordinated release |
| `platform` | Skeleton/lib/CLI/UI plus CLI binaries and assistant image |
| `portals` | Portal SDK/adapters plus portal image |
| `guardian` | Guardian package plus Guardian image |
| `assistant` | Assistant image-only change |
| `electron` | Native harness/installers only |
| `images` | Rebuild all standard images at a required explicit version |

`include_images` defaults to true for platform, portals, and Guardian. Untick it
only for a deliberate npm-only partial release. Voice is always independent.

## Coordinated Dry Run

Use the exact version intended for the live release:

```bash
gh workflow run release.yml \
  --ref main \
  -f unit=all \
  -f version=0.13.0 \
  -f dry_run=true
```

Record the run URL, base SHA, candidate SHA, and computed version. Require:

- one candidate commit directly atop the base
- frozen-lockfile preflight on that candidate
- all eight npm package packs
- candidate-backed Assistant, Guardian, and portal image builds
- CLI binaries and Electron installers
- no source, registry, tag, or release mutation

## Coordinated Live Release

After the dry run succeeds and the branch still points at the recorded base:

```bash
gh workflow run release.yml \
  --ref main \
  -f unit=all \
  -f version=0.13.0 \
  -f dry_run=false
```

The source gate refuses a moved branch rather than rebasing. Standard Docker
images publish immutable tags first; stable `latest` aliases move only in the
final job after every required artifact succeeds, using the signed build digests
rather than mutable version-tag lookups.

## Voice Release

Voice is released separately and requires an immutable base version:

```bash
gh workflow run publish-voice.yml \
  --ref main \
  -f version=0.13.0
```

Both CPU and CUDA variants must succeed and verify signatures before a stable
release moves `latest-cpu` or `latest-cu121` from their recorded digests.
Prerelease Voice versions do not move either alias.

## Failure Recovery

If the base lease fails, no artifact publication has started. Review the new
branch head and dispatch a new dry run/live pair from the intended source.

If a job fails after any npm package or immutable Docker image was published,
do not dispatch or rerun publication for the same version. Immutable image
guards and npm's immutable versions intentionally reject reuse. Record what
published, correct the cause, and cut a new version.

`gh run rerun <run-id> --failed` is safe only when evidence shows no immutable
registry artifact was created. GitHub release asset retries are idempotent, but
that does not make npm or Docker publication transactional.

## Post-Publish Verification

```bash
for package in \
  '@openpalm/lib' \
  'openpalm' \
  '@openpalm/ui' \
  '@openpalm/skeleton' \
  '@openpalm/guardian' \
  '@openpalm/portal-sdk' \
  '@openpalm/discord-portal' \
  '@openpalm/slack-portal'
do
  npm view "${package}@0.13.0" version
  npm view "$package" dist-tags --json
done

docker buildx imagetools inspect openpalm/assistant:0.13.0
docker buildx imagetools inspect openpalm/guardian:0.13.0
docker buildx imagetools inspect openpalm/portal:0.13.0
```

For stable releases, verify each standard `latest` alias resolves to the same
manifest as its immutable tag. For prereleases, verify no Docker `latest` alias
moved. Confirm all expected Git tags point to the tested candidate and every
GitHub release exposes checksums and expected assets.

## Local Baseline

```bash
bun install --frozen-lockfile
bun run test:t1
bun run test:t2
bun run test:t3
bun run test:t4
bun run test:t5
bun run ui:test:pwa
```

Use the [RC runbook](release-rc-runbook.md) and
[`unit=all` checklist](unit-all-rc-checklist.md) for evidence capture.
