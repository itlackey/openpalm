# Release Candidate Runbook

Use the product workflow for a release candidate. There are no release units or
product npm DAG to coordinate.

```bash
export RELEASE_REF=main
export RC_VERSION=0.13.0-rc.1
gh workflow run release.yml --ref "$RELEASE_REF" \
  -f version="$RC_VERSION" -f dry_run=true
```

The dry run must restore and test one candidate, build all three canonical
images from candidate-local source, build all CLI and Electron assets, invoke
`scripts/build-host-assets.mjs`, and validate the complete
`release-assets-manifest.json` and `checksums-sha256.txt`. It must not push
source, tags, images, releases, or npm packages.

After the dry run and base-SHA review succeed:

```bash
gh workflow run release.yml --ref "$RELEASE_REF" \
  -f version="$RC_VERSION" -f dry_run=false
```

Live runs atomically push the candidate branch and bare version tag, create one
summary GitHub Release, verify its public assets, then publish only the
`openpalm` bootstrap. Prereleases do not promote mutable image aliases.

Verify the final release from public sources:

```bash
gh release view "$RC_VERSION" --json tagName,isPrerelease,assets,url
npm view "openpalm@${RC_VERSION}" version
docker buildx imagetools inspect "openpalm/assistant:${RC_VERSION}"
docker buildx imagetools inspect "openpalm/guardian:${RC_VERSION}"
docker buildx imagetools inspect "openpalm/portal:${RC_VERSION}"
```
