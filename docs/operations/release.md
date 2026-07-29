# Releasing OpenPalm

One document for the product release: architecture, commands, and checklist.
Extensions (guardian + portals) release separately at the end.

## Architecture

`.github/workflows/release.yml` is the product release authority. From one
dispatched version it prepares one candidate commit, tests that candidate,
builds the UI once, builds images and native assets from the candidate-local
source tree, and validates one complete asset manifest. There are no release
units, no per-unit GitHub Releases, and no deploy bundle.

Product user assets are published once on the summary GitHub Release named by
the bare product version: the five CLI binaries, Electron artifacts,
`openpalm-host-assets-<version>.tar.gz`, `release-assets-manifest.json`, and
`checksums-sha256.txt`.

The `openpalm` npm package is only a convenience bootstrap. It is published
after the GitHub Release exists and its binary and checksum assets have been
verified through public URLs. CLI binaries never depend on npm publication.
`@openpalm/ui`, `@openpalm/skeleton`, and `@openpalm/lib` are not published by
the product workflow; historical versions remain untouched.

Images use the canonical Dockerfiles and the restored candidate-local source.
They do not depend on npm jobs. The workflow publishes immutable version tags
only and deliberately does not promote a mutable `latest` alias; prereleases
never move image aliases either.

The source branch and product tag are pushed atomically and as late as
practical. Live runs are accepted only from `main` or `release/*`; dry runs
perform the same build, pack, manifest, checksum, and validation work without
registry mutation. Setup scripts are version-neutral: without an explicit
version they resolve the public latest GitHub Release, and the product
workflow never stamps them.

## Commands

Always dry-run first (`scripts/release.sh` wraps the same dispatch):

```bash
gh workflow run release.yml --ref main -f version=<version> -f dry_run=true
```

After the dry run passes and the dispatch ref is confirmed unchanged:

```bash
gh workflow run release.yml --ref main -f version=<version> -f dry_run=false
```

Verify the final release from public sources:

```bash
gh release view "<version>" --json tagName,isPrerelease,assets,url
npm view "openpalm@<version>" version
docker buildx imagetools inspect "openpalm/assistant:<version>"
docker buildx imagetools inspect "openpalm/guardian:<version>"
docker buildx imagetools inspect "openpalm/portal:<version>"
```

Never reuse a version after an immutable artifact has been published.

## Checklist

- [ ] Dispatch a dry run from `main` or `release/*`.
- [ ] Candidate is directly atop the recorded base SHA.
- [ ] Frozen-lockfile preflight passes.
- [ ] Canonical Assistant, Guardian, and Portal images build from candidate
      source without npm job dependencies.
- [ ] CLI binaries and Electron installers are present.
- [ ] `openpalm-host-assets-<version>.tar.gz` is present.
- [ ] `release-assets-manifest.json` lists every user asset.
- [ ] `checksums-sha256.txt` validates every required asset.
- [ ] Dry run pushed nothing: no source, images, tags, releases, or npm.
- [ ] Live source and tag are pushed atomically.
- [ ] One summary GitHub Release is publicly verified.
- [ ] `openpalm` publishes only after that verification.
- [ ] Stable image aliases move only after immutable release completion.

## Extensions

`.github/workflows/publish-extensions.yml` independently releases
`@openpalm/guardian`, `@openpalm/portal-sdk`, `@openpalm/discord-portal`, and
`@openpalm/slack-portal`. It stamps the dispatched version into the manifests
itself (no hand-editing), has its own concurrency group, and is not a
dependency of product release or product image jobs.

```bash
gh workflow run publish-extensions.yml --ref main -f version=<version> -f dry_run=true
```
