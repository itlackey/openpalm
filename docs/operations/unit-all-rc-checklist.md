# Unit=All RC Checklist

Concise gate list for a coordinated `unit=all` release candidate. Use the
[RC runbook](release-rc-runbook.md) for commands and evidence capture.

## Shipped Inventory

The standard coordinated release contains:

- npm: `@openpalm/lib`, `openpalm`, `@openpalm/ui`,
  `@openpalm/skeleton`, `@openpalm/guardian`, `@openpalm/portal-sdk`,
  `@openpalm/discord-portal`, and `@openpalm/slack-portal`
- Docker: `openpalm/assistant`, `openpalm/guardian`, and `openpalm/portal`
- CLI binaries and macOS/Linux/Windows Electron installers
- platform, portals, assistant, guardian, Electron, and summary tags/releases

Voice is released independently and is not part of `unit=all`.

## Source And Publisher Readiness

- [ ] All intended changes are committed and pushed to the dispatch branch.
- [ ] The exact remote base SHA has been reviewed and recorded.
- [ ] The branch will remain at that SHA until the live source gate completes.
- [ ] All eight npm packages have a trusted publisher for
      `itlackey/openpalm`, workflow `release.yml`, with no environment.
- [ ] The target version is greater than every relevant published version.
- [ ] No unresolved security, rootless-ownership, or packaging blocker remains.

## Automated Local Gates

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

- [ ] All five tiers pass.
- [ ] The mocked browser suite passes.
- [ ] The production PWA lane passes.
- [ ] Tier 5 creates an isolated current-layout home using
      `system/stack/*.compose.yml`, `config/stack/custom.compose.yml`, and
      `state/stack.env`.
- [ ] Tier 5 places delegated service secrets under `private/secrets/`, while
      the shared OpenCode provider file remains the
      `knowledge/secrets/auth.json` exception.
- [ ] Tier 5 enables the API addon, starts profile-gated Guardian, validates
      current `/api/auth/*` and `/api/host/*` routes, checks assistant isolation,
      and runs the `*.stack.ts` Playwright suite.

Tier 5 is not evidence for model inference, voice, or real external channel
credentials; those are not coordinated-release gates.

## Exact-Candidate Dry Run

```bash
gh workflow run release.yml \
  --ref main \
  -f unit=all \
  -f version="$RC_VERSION" \
  -f dry_run=true
```

- [ ] One candidate commit is created directly atop the recorded base.
- [ ] The candidate includes every unit stamp and the refreshed `bun.lock`.
- [ ] The candidate bundle verifies and reports the expected candidate SHA.
- [ ] Preflight restores and tests that SHA with the frozen lockfile.
- [ ] Every artifact job restores the same candidate, rather than checking out a
      moving branch.
- [ ] Every coordinated npm package packs at the exact candidate version.
- [ ] Assistant dry-run smoke overlays the candidate UI and skeleton tarballs
      into the local image; no boot-time package install is assumed.
- [ ] Portal SDK completes before Discord and Slack, and the portal image waits
      for all three candidate package jobs.
- [ ] Assistant, guardian, and portal local Docker builds pass.
- [ ] No branch, registry, tag, GitHub release, or voice artifact is changed.

## Live Release

```bash
gh workflow run release.yml \
  --ref main \
  -f unit=all \
  -f version="$RC_VERSION" \
  -f dry_run=false
```

- [ ] The source gate pushes only after preflight.
- [ ] The push uses the recorded base-SHA lease and the remote branch resolves
      to the tested candidate afterward.
- [ ] All required npm, Docker, CLI, and Electron jobs pass.
- [ ] Tags and GitHub releases run last.

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
  npm view "${package}@${RC_VERSION}" version
  npm view "$package" dist-tags --json
done

docker buildx imagetools inspect "openpalm/assistant:$RC_VERSION"
docker buildx imagetools inspect "openpalm/guardian:$RC_VERSION"
docker buildx imagetools inspect "openpalm/portal:$RC_VERSION"
```

- [ ] All eight npm versions resolve.
- [ ] Dist-tags are correct: `rc`, `beta`, `next` for other prereleases, or
      `latest` for stable.
- [ ] All three standard image tags resolve; prereleases did not move Docker
       `latest`.
- [ ] Stable Docker `latest` aliases match the immutable tags and were promoted
      only by the final release job.
- [ ] All six expected `unit=all` tags point to the tested candidate SHA.
- [ ] Every GitHub release exists with downloadable assets and checksums.
- [ ] A retry refreshed existing assets rather than duplicating or silently
      skipping them.
- [ ] Any GitHub release create/upload error failed visibly.

## Signoff

- [ ] Workflow URL, base SHA, candidate SHA, version, and unit are recorded.
- [ ] Local, dry-run, and post-publish evidence is attached.
- [ ] Any reviewed waivers are explicit.

## Related Documents

- [Release Management](release-management.md)
- [RC Release Runbook](release-rc-runbook.md)
- [Testing Workflow](../technical/testing-workflow.md)
- [Release Architecture](../technical/release-architecture.md)
- [Core Principles](../technical/core-principles.md)
