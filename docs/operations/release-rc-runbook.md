# RC Release Runbook

Repeatable procedure for a coordinated release candidate through
`.github/workflows/release.yml`.

Use this with [Release Management](release-management.md) and the
[`unit=all` checklist](unit-all-rc-checklist.md).

## Variables

```bash
export RELEASE_REF=main
export RC_VERSION=0.13.0-rc.1
export RC_UNIT=all
```

`RELEASE_REF` selects the remote branch used as both the immutable dispatch base
and the candidate push target. Artifact jobs use the bundled candidate SHA, not
the later state of this branch.

## 1. Confirm Registry Readiness

Confirm that every coordinated npm package is visible to the registry:

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
  npm view "$package" versions --json >/dev/null
done
```

At npmjs.com, each package must have this trusted publisher:

- Repository: `itlackey/openpalm`
- Workflow: `release.yml`
- Environment: none

Stop if any package or trusted-publisher entry is missing.

## 2. Confirm The Remote Base

All release changes must be committed and pushed before dispatch:

```bash
git fetch origin "$RELEASE_REF"
export BASE_SHA="$(git rev-parse "origin/$RELEASE_REF")"
git show --stat --oneline "$BASE_SHA"
```

Review that SHA. A live run will create one stamped candidate directly on top
of it. Do not update the target branch between live dispatch and the source
gate; the base-SHA lease intentionally rejects a moved branch.

## 3. Run Local Automated Gates

```bash
bun install --frozen-lockfile
bun run --cwd packages/ui test:browsers
bun run test:t1
bun run test:t2
bun run test:t3
bun run test:t4
bun run test:t5
bun run ui:test:pwa
```

Tier 5 runs `scripts/dev-e2e-test.sh --playwright`: it creates an isolated
current-layout home, enables the API addon so Guardian runs, checks current host
API and isolation boundaries, and runs the stack Playwright files. It does not
exercise model inference, voice, or real external credentials.

These local gates supplement the workflow. The workflow preflight remains the
authoritative test of the fully stamped candidate and its lockfile.

## 4. Dispatch The Coordinated Dry Run

```bash
gh workflow run release.yml \
  --ref "$RELEASE_REF" \
  -f unit="$RC_UNIT" \
  -f version="$RC_VERSION" \
  -f dry_run=true
```

Find and monitor the run:

```bash
gh run list --workflow release.yml --branch "$RELEASE_REF" --limit 5
gh run watch <run-id> --exit-status
gh run view <run-id> --json status,conclusion,url,jobs
```

Require all of the following:

- `Prepare candidate` stamps the complete `all` set, refreshes `bun.lock`,
  commits once, and uploads the verified git bundle
- `Preflight candidate` restores and tests the reported candidate SHA with
  `bun install --frozen-lockfile`
- `Release source gate` restores the same SHA and does not push in dry-run mode
- every npm, Docker, CLI, and Electron job restores that candidate bundle
- all eight npm jobs pack candidate tarballs without publishing
- the assistant smoke image overlays the candidate UI and skeleton tarballs
- portal SDK completes before both adapter jobs, and the portal image waits for
  all three before building from their candidate tarballs
- assistant, guardian, and portal local image builds pass
- source push, npm publish, Docker push, tags, and releases are skipped

Capture the run URL, base SHA, candidate SHA, computed version, and any waiver.

## 5. Dispatch The Live Release

After the dry run and local gates pass:

```bash
gh workflow run release.yml \
  --ref "$RELEASE_REF" \
  -f unit="$RC_UNIT" \
  -f version="$RC_VERSION" \
  -f dry_run=false
```

The live source gate restores the tested candidate, verifies the remote branch
is still at `BASE_SHA`, and pushes with an exact base lease. It does not retry by
rebasing onto newer branch content.

## 6. Handle Failures

If the base lease fails, artifact publication has not started. Review the new
branch head and dispatch a replacement run from the intended source.

If a later artifact job fails, first determine whether any npm version or
immutable Docker image was created. Do not rerun or redispatch the same version
after registry publication; correct the cause and cut a new version. A failed-job
rerun is safe only when no immutable registry artifact was created.

## 7. Verify Published Artifacts

### npm

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
  npm view "${package}@${RC_VERSION}" version
  npm view "$package" dist-tags --json
done
```

For an RC, each package should resolve the exact version and the `rc` dist-tag
should point to it. Beta releases use `beta`, other prereleases use `next`, and
stable releases use `latest`.

### Docker

```bash
docker buildx imagetools inspect "openpalm/assistant:$RC_VERSION"
docker buildx imagetools inspect "openpalm/guardian:$RC_VERSION"
docker buildx imagetools inspect "openpalm/portal:$RC_VERSION"
```

Prereleases must not move the standard Docker `latest` tags. For a stable
release, each `latest` alias must match the corresponding immutable manifest.

### Tags And GitHub Releases

For `unit=all`, verify these tags/releases:

```bash
for tag in \
  "platform-$RC_VERSION" \
  "portals-$RC_VERSION" \
  "assistant-$RC_VERSION" \
  "guardian-$RC_VERSION" \
  "electron-$RC_VERSION" \
  "$RC_VERSION"
do
  gh release view "$tag" --json tagName,isPrerelease,assets,url
done
```

All tags must point to the candidate SHA. Every expected release asset must be
downloadable. A retry updates existing assets with `--clobber`; a failed create
or upload command fails the workflow rather than being ignored.

## 8. Sign Off

Record:

- version and release unit
- workflow URL
- base and candidate SHAs
- local and dry-run gate status
- npm, Docker, tag, release, and asset verification
- reviewed waivers or known issues

## Related Docs

- [Release Management](release-management.md)
- [Unit=All RC Checklist](unit-all-rc-checklist.md)
- [Testing Workflow](../technical/testing-workflow.md)
- [Release Architecture](../technical/release-architecture.md)
- [Core Principles](../technical/core-principles.md)
