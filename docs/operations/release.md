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
VERSION=0.14.0-beta.1 node scripts/bump-release.mjs
VERSION=0.14.0-beta.1 STAMP=true node scripts/bump-release.mjs
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
all three images for amd64 and arm64, asserts non-root image users, and runs image startup/security
smokes. Trivy rejects every critical runtime image advisory, including those
without an upstream fix, and every fixable high advisory. Unfixed high upstream
issues are reported and are not silently described as fixed. Review that output
before approving a candidate.

## Workflow

Dispatch `.github/workflows/release.yml` with:

- `version`: the already-stamped semantic version;
- `dry_run: true` first.

Gitea (`https://code.lab.fwdslsh.dev/founder3/openpalm`) is the source of truth
and canonical release/download location. GitHub (`itlackey/openpalm`) mirrors
the candidate commit and runs the cross-platform Actions builds. The workflow
rejects execution on other Actions hosts; it never derives the Gitea API origin
or repository from the build host. Desktop artifacts retain the existing
unsigned release practice; this refactor adds no signing prerequisite.
Each runner launches its native CLI binary and packaged Admin with an isolated
temporary home. Packaged Admin must load its actual renderer and preload bridge
and exit successfully; this startup smoke is not a substitute for the separate
Docker/provider setup walkthrough. Cross-compiled secondary architectures are
checksummed and packaged, not falsely reported as natively executed.

The workflow validates stamps, calls the shared gate, builds every artifact,
creates checksums and `release-assets-manifest.json`, and runs the same asset
validator for dry and live releases. The required set is five CLI binaries,
five updater-free Admin artifacts, the versioned MCPB, and checksums.
A live dispatch from `main` or `release/*` (or `refactor/lean-stack` for
prereleases only) additionally pushes
SBOM/provenance-enabled images, signs immutable image digests with Cosign,
stages a draft Gitea release, downloads each attachment to verify its SHA-256,
and only then makes the complete release public. Interrupted draft uploads can
be resumed for the same commit and identical assets. Existing public releases
are verified without modification; conflicting commits, assets, and unexpected
attachments fail closed and require a new version. No cleanup deletes releases.
Published versioned image tags are reused only if their revision label matches
the same candidate commit; another revision fails instead of replacing a tag.

Configure GitHub repository secrets `GITEA_TOKEN` (release-write access to the
canonical Gitea repository), `DOCKERHUB_USERNAME`, and `DOCKERHUB_TOKEN`.
Ensure the candidate commit is present in Gitea before dispatching. npm uses
the existing GitHub trusted-publisher configuration for `itlackey/openpalm`
and `release.yml`, with OIDC and provenance; it does not require an npm token.
Configure that exact publisher in npm before a live run. npm publication occurs
only after the canonical complete public release is verified. A retry compares
the packed npm integrity with an existing version and rejects differences.
The published CLI package's `repository.url` names the GitHub build mirror,
as [npm provenance requires](https://docs.npmjs.com/generating-provenance-statements/).
Its homepage and binary downloads still point to canonical Gitea. This is a
build-provenance declaration, not a second release destination.

`0.14.0-beta.1` is a Gitea prerelease and publishes to npm's `beta` tag;
`*-rc.*` uses `rc`, other prereleases use `next`, and stable uses `latest`.
Beta testing precedes the release candidate and final stable dispatch. A dry
run never publishes images, releases, or npm packages. CI runs on the lean
branch as well as pull requests, `main`, and `release/*`.

The workflow never publishes the private Guardian, Portal, Lib, Skeleton, or
Admin packages to npm.

## Beta.1 verification record

The 2026-09-30 Linux x64 walkthrough used a fresh private home and the real
OpenCode Go provider. Setup readiness, default-provider persistence, visible
startup recovery, timezone/memory preferences, client recipes, and credential
mapping passed. The final packaged Linux x64 Admin started with its sandbox
enabled. Other desktop targets still require their native Actions checks;
the locally cross-built ARM64 artifact was not natively executed.

Real runtime acceptance passed automatic trusted-local memory, natural-language
task creation, timer-triggered completed history, pause/resume, recall after
container recreation, MCP policy filtering and workspace containment, resumable
jobs, credential isolation, explicit permission approval, and key rotation.
Terminating the disposable scheduler also produced an automatic healthy
container restart without model calls.

Discord gateway login and the actual Portal-to-Guardian MCP bootstrap passed
using the approved Fwdslsh bot, with no Discord messages sent. Interactive
Discord message delivery, Slack, provider OAuth sign-in, and public HTTPS/OAuth
connector acceptance remain separate external-system checks; unit protocol
coverage is not a claim that these were exercised live.

All three rebuilt images passed startup/security smoke and had zero fixable
high/critical findings, zero critical findings, and zero Node/Go findings in
Trivy 0.74. Unfixed Debian high findings remained: Assistant 62, Guardian 51,
Portal 51. CI reports them and rejects newly fixable findings. These counts
describe this scan, not a permanent security guarantee.
