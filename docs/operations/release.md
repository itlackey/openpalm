# Releasing OpenPalm

One document for the product release: architecture, commands, and checklist.
Extensions (guardian + portals) release separately at the end.

## Architecture

`.github/workflows/release.yml` is the product release authority. From one
dispatched version it prepares one candidate commit, tests that candidate,
builds the UI once, builds images and native assets from the candidate-local
source tree, and validates one complete asset manifest. There are no release
units, no per-unit GitHub Releases, and no deploy bundle.

**Invariant: every published release ships the complete product, or it does
not publish.** That means the CLI binary for every platform, the desktop app
for every platform electron-builder targets, and the electron-updater feed
files for the release's channel — all in one GitHub Release, together. CLI-only
releases are not a supported outcome: that gap is exactly how the project's
last stable release (0.12.52) shipped with zero desktop assets while the
README told users to download the desktop app from it
(`docs/reviews/onboarding-setup-review.md`, D1/D4). Two scripts enforce this
and both must pass before anything publishes:

- `scripts/validate-release-assets.mjs` — fails closed unless every CLI
  binary, every desktop artifact `packages/electron/electron-builder.yml`
  configures (macOS arm64 + x64 zips, the Windows NSIS installer and portable
  zip, Linux x64 + arm64 AppImages), and the channel's updater feed files are
  all present in the asset set *and* checksummed in `checksums-sha256.txt`.
  Desktop artifact names are derived from the dispatched version and
  electron-builder.yml's own `productName` (not hand-typed), so this does not
  need updating when the version changes.
- `scripts/validate-updater-feed.mjs` — fails closed unless the release's
  `latest.yml`/`beta.yml` (+ `-linux` variant) parses, names the release
  version, and references only assets actually being uploaded — and fails if
  a macOS feed appears at all, since macOS stays on the manual-download path
  until it is signed and notarized.

This is a different thing from `scripts/setup.sh`/`setup.ps1`'s `--cli-only`
flag: that flag lets a **user** install just the CLI on their own machine
(e.g. a headless server) and is unaffected by any of this — it just skips
*downloading* the desktop app that this workflow already published. What is
gone is a *release* that never had a desktop app to download in the first
place.

Product user assets are published once on the summary GitHub Release named by
the bare product version: the five CLI binaries, the Electron artifacts for
every platform, `release-assets-manifest.json`, and `checksums-sha256.txt`.
The CLI binaries embed the UI build directly, so there is no separate
host-assets tarball to publish or download.

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

Record the candidate SHA, platform and artifact used, observed result, and a
link to logs or screenshots for every manual check. Mark checks that could not
run as `BLOCKED_PLATFORM`, `BLOCKED_CREDENTIAL`, or `N/A` with the exact reason;
an unexecuted check is not a pass. Never include credential values in evidence.

### Automated gates

- [ ] `bun run lint` passes.
- [ ] `bun run test:t1`, `bun run test:t2`, `bun run test:t3`, and
      `bun run test:t4` pass.
- [ ] `bun run test:t5` passes for stack or onboarding changes.
- [ ] `bun run ui:test:pwa` passes for UI, PWA, or release candidates.
- [ ] `bun run --cwd packages/electron typecheck` and
      `bun run --cwd packages/electron test` pass.

### Onboarding and runtime acceptance

- [ ] On a host with no existing `OP_HOME`, Docker preflight failures leave no
      partial install, and rerunning install after fixing Docker succeeds.
- [ ] A fresh browser-wizard run with no deployed assistant loads the provider
      catalog from its temporary OpenCode instance.
- [ ] Browser-redirect OAuth completes, persists the credential to
      `OP_HOME/knowledge/secrets/auth.json`, survives deployment, and can send a
      model-backed message from the assistant UI.
- [ ] Authorization-code OAuth keeps its code input available until submission,
      persists the credential, survives deployment, and can send a model-backed
      message.
- [ ] Host credential import persists imported credentials into `OP_HOME` and
      the deployed assistant can use them without reopening the wizard.
- [ ] A blocking port conflict remains visible on System Check and prevents
      continuing until the conflict is resolved.
- [ ] Clicking Install reaches `writing-config`, `pulling-images`, `starting`,
      and `ready`; an optional-service failure terminates with a warning rather
      than polling forever.
- [ ] Retry resumes status polling after a failed deploy, and reopening a failed
      deploy still permits returning to Review and editing configuration.
- [ ] Setup completion signs into the host UI, the assistant UI uses its
      independent session cookie, and logging into either surface does not log
      the other out.
- [ ] The first real chat message succeeds; invalid credentials, quota errors,
      permission waits, and idle timeouts surface actionable errors without
      abandoning a still-running server turn.
- [ ] `install --file <spec> --no-start` followed by `openpalm start` waits for
      core health and records `OP_SETUP_COMPLETE=true`.
- [ ] `openpalm doctor` exits nonzero for Docker, Compose, blocking-port, disk,
      inventory, cleanup, and database-maintenance failures that it reports.

### Tailscale and Paperclip acceptance

Run the complete
[Manual Tailscale and Paperclip Acceptance](manual-tailscale-paperclip-testing.md)
guide from the candidate SHA. Tier 5 does not replace this lane because it uses
no real tailnet, Funnel permission, upstream Paperclip runtime, or second
device.

- [ ] The guide's isolated `.cache` home, unique Compose project, and unique
      ports are used; no test container mounts `~/.openpalm`, and the captured
      production containers and `state/stack.env` remain unchanged.
- [ ] Tailscale private Serve, all three targets (`assistant`, `guardian`, and
      `both`), node-identity persistence, authenticated Guardian pairing, and
      short-lived Funnel exposure all pass, including fail-closed public-off and
      addon-disable checks.
- [ ] Paperclip Admin/CLI lifecycle, first-admin bootstrap, authenticated/private
      posture, declared local-agent toolchain, a real credential-backed local-agent
      run, persistence, port reconfiguration, backup, and network/secret isolation
      all pass.
- [ ] Paperclip's enable is verified as a COLD START: no
      `data/paperclip/instances/default/db` before it, a cluster created by that
      run after it, and the running container on the digest pinned in
      `services.compose.yml`. A re-enable, a hand-started container, a deleted
      data directory, or a locally patched image invalidates the check — that
      combination reported a pass while cold start was broken for every new
      install.
- [ ] Cleanup closes Funnel first, empties the generated Serve policy, removes
      only the isolated project/home and test tailnet node, and leaves no test
      credential or listener behind.

### Packaged desktop and installer acceptance

- [ ] Linux x64 and arm64 AppImages launch on a supported distribution; the
      documented `libfuse2` and `--appimage-extract-and-run` paths are verified.
- [ ] Windows NSIS install, update, relaunch, uninstall, launch-on-login, tray,
      and single-instance behavior are verified on a clean Windows host.
- [ ] The Windows portable archive remains portable and does not offer or apply
      an NSIS update into a second installation.
- [ ] Intel and Apple Silicon macOS archives launch through the documented
      macOS 15 approval flow and remain on the manual-update path.
- [ ] On Linux and Windows, closing with a usable tray hides the window and
      closing without a usable tray exits; a second launch focuses the primary
      instance.
- [ ] Quitting during deployment offers Keep Waiting and Quit Anyway, and a
      backgrounded completed or failed deploy produces the documented native
      notification.
- [ ] Off-origin navigation, redirects, popups, and privileged IPC cannot retain
      access to the trusted Electron window or invoke privileged actions.
- [ ] A staged Windows or Linux update installs on both explicit restart and an
      ordinary confirmed application quit.

### Release workflow and publication

- [ ] Dispatch a dry run from `main` or `release/*`.
- [ ] Candidate is directly atop the recorded base SHA.
- [ ] Frozen-lockfile preflight passes.
- [ ] Canonical Assistant, Guardian, and Portal images build from candidate
      source without npm job dependencies.
- [ ] CLI binaries (with the UI build embedded) and every desktop platform's
      installer are present — enforced by `validate-release-assets.mjs`, which
      fails the run if any platform's build did not produce its artifact.
- [ ] The updater feed for the release's channel is complete and internally
      consistent — enforced by `validate-updater-feed.mjs`.
- [ ] `release-assets-manifest.json` lists every user asset.
- [ ] `checksums-sha256.txt` validates every required asset, desktop artifacts
      included.
- [ ] Dry run pushed nothing: no source, images, tags, releases, or npm.
- [ ] Live source and tag are pushed atomically.
- [ ] One summary GitHub Release is publicly verified.
- [ ] `openpalm` publishes only after that verification.
- [ ] No mutable image aliases were published; product images use only the
      immutable release version.

## Extensions

`.github/workflows/publish-extensions.yml` independently releases
`@openpalm/guardian`, `@openpalm/portal-sdk`, `@openpalm/discord-portal`, and
`@openpalm/slack-portal`. It stamps the dispatched version into the manifests
itself (no hand-editing), has its own concurrency group, and is not a
dependency of product release or product image jobs.

```bash
gh workflow run publish-extensions.yml --ref main -f version=<version> -f dry_run=true
```
