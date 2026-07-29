# Release Management

Run a coordinated product dry run before any live publication:

```bash
gh workflow run release.yml --ref main -f version=0.13.0 -f dry_run=true
```

Require a clean candidate test, candidate-local image builds, all CLI and
Electron assets, `openpalm-host-assets-0.13.0.tar.gz`, a complete
`release-assets-manifest.json`, and matching checksums. Dry runs must not push
source, images, tags, releases, or npm packages.

After the dispatch ref is confirmed unchanged, run the live workflow:

```bash
gh workflow run release.yml --ref main -f version=0.13.0 -f dry_run=false
```

The workflow creates one bare `0.13.0` tag and one summary GitHub Release.
Only after its public assets verify does it publish the `openpalm` bootstrap.
The 0.13 workflow publishes exact image tags only; it does not move `latest`.

Extensions are independent:

```bash
gh workflow run publish-extensions.yml --ref main -f version=0.13.0 -f dry_run=true
```

Verify npm, GitHub, and Docker registries directly after publication. Never
reuse a version after an immutable artifact has been published.
