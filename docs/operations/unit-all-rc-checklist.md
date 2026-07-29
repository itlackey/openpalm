# Product Release Checklist

This file retains the historical filename used by internal links. The 0.13
model has one product release, not a `unit=all` DAG.

- [ ] Dispatch a dry run from `main` or `release/*`.
- [ ] Candidate is directly atop the recorded base SHA.
- [ ] Frozen-lockfile preflight passes.
- [ ] Canonical Assistant, Guardian, and Portal images build from candidate source without npm job dependencies.
- [ ] CLI binaries and Electron installers are present.
- [ ] `openpalm-host-assets-<version>.tar.gz` is present.
- [ ] `release-assets-manifest.json` lists every user asset.
- [ ] `checksums-sha256.txt` validates every required asset.
- [ ] Live source and tag are pushed atomically.
- [ ] One summary GitHub Release is publicly verified.
- [ ] `openpalm` publishes only after that verification.
- [ ] Stable image aliases move only after immutable release completion.
- [ ] Guardian and portal extensions are handled separately by `publish-extensions.yml`.
