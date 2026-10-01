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
VERSION=0.14.0-alpha.1 node scripts/bump-release.mjs
VERSION=0.14.0-alpha.1 STAMP=true node scripts/bump-release.mjs
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

Gitea is for early/private development only. Once source is ready for public
testing or release, push that exact commit to GitHub `itlackey/openpalm`.
GitHub Actions builds and publishes the complete release. There is no Gitea
publishing API, token, artifact upload, or download dependency in the workflow.

Desktop artifacts retain the existing unsigned release practice; this
refactor adds no signing prerequisite. Each runner launches its native CLI
binary and packaged Admin with an isolated temporary home. Packaged Admin
must load its actual renderer and preload bridge and exit successfully; this
startup smoke is not a substitute for the separate Docker/provider setup
walkthrough. Cross-compiled secondary architectures are checksummed and
packaged, not falsely reported as natively executed.

The workflow validates stamps, calls the shared gate, builds every artifact,
creates checksums and `release-assets-manifest.json`, and runs the same asset
validator for dry and live releases. The required set is five CLI binaries,
five updater-free Admin artifacts, the versioned MCPB, and checksums.
A live dispatch from `main` or `release/*` (or `refactor/lean-stack` for
prereleases only) also publishes SBOM/provenance-enabled images to Docker Hub,
signs their immutable digests with Cosign, and creates a draft GitHub Release
at the candidate commit. Uploaded assets are downloaded, checksum-verified,
and validated before the release becomes public.

Existing releases are not overwritten. An interrupted upload leaves an
unpublished draft; inspect it before choosing a new version. No cleanup
deletes releases. Versioned image tags are reused only when their revision
label matches the candidate commit; another revision fails instead of
replacing the tag.

GitHub release publication uses the job's built-in `github.token` with
`contents: write`; no personal GitHub or Gitea token is required. Docker Hub
uses the existing `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository
secrets. npm uses the existing GitHub trusted-publisher configuration for
`itlackey/openpalm` and `release.yml`, with OIDC and provenance; it does
not require an npm token. The npm job verifies the complete public GitHub
release for the exact version and candidate commit before publishing.
Retrying that job compares packed npm integrity against an existing version
and rejects different contents.

Public repository metadata, installer binaries, Admin downloads, and the
Claude Desktop extension all point to GitHub. `*-alpha.*` is a GitHub
prerelease and publishes to npm's `next` tag; `*-beta.*` uses `beta`,
`*-rc.*` uses `rc`, and stable uses `latest`. Beta testing precedes
the release candidate and final stable dispatch. A dry run never publishes
images, releases, or npm packages. CI runs on the lean branch as well as pull
requests, `main`, and `release/*`.

The workflow never publishes the private Guardian, Portal, Lib, Skeleton, or
Admin packages to npm.

## Alpha.3 published-artifact verification record

The 2026-09-30 Linux x64 upgrade used the checksum-verified CLI from the public
`0.14.0-alpha.3` GitHub release and all three published images. Image revision
labels matched release commit `33276b51467f33ebf61d79315dc7e95699441c17`.
The complete dry run, live publication, and CI passed. Before publication,
verification caught and fixed a retry-test race and an image smoke test's
unnecessary dependency on host Bun; neither failed candidate was published.

The existing alpha.2 installation was stopped and cold-archived, and the archive
was compared against the source before installing the downloaded release CLI.
The update completed with Assistant, Guardian, and Discord healthy. Real
no-tool provider readiness passed before and after the update. Twelve private
configuration and credential files matched the archive afterward, including
portal maps and client keys. Explicit authenticated LAN access was preserved.
AKM 0.9.20 and Claude's enabled `akm@inline` plugin
(`0.9.20202609302253`) were verified in the published Assistant image.

Both native remote switches were initially off. Enabling them exercised the
actual vendor workers and retry reporting without stopping OpenCode or the
scheduler; disabling them stopped the workers. Neither vendor account was
signed in. Claude reported its subscription-login requirement. Codex reported a
remote connection error; a separate harmless `codex sandbox /usr/bin/true`
probe also failed because bubblewrap could not create a namespace inside the
default container, despite host user namespaces being enabled. No sandbox,
capability, or host security setting was weakened. Both switches remain off.

Native login, pairing, remote client sessions, tool approvals, and authenticated
restart continuity were **not verified**. In particular, Codex's sandbox failure
must be resolved before claiming usable remote tool execution on this host.
These limitations are not covered by successful package or process-health
checks. No new interactive Discord, Slack, or public connector acceptance was
performed in this upgrade. Private backups, logs, and host details stay outside
Git.

## Alpha.2 migration hardening

`0.14.0-alpha.2` includes the migration and portable-backup fixes discovered
during the alpha.1 walkthrough. Historical AKM configuration and prior unsafe
staging are excluded rather than exposed to the agent. Generated dependency
trees are pruned before traversal. Provider credentials, including safe native
file references, require explicit opt-in and remain private. Automatic native
configuration portability is limited to model/provider preferences; MCP,
plugin, and other custom runtime settings require deliberate manual review.
Human import previews are bounded; full plans remain available through JSON.

The fresh-install boundary, paused imported tasks, new client credentials,
explicit network intent, and default-deny portal allowlists remain intentional.
These are not compatibility bugs to reverse. Use the
[migration runbook](migration-to-0.14.md) and verify against the downloaded
release artifacts, not a locally rebuilt binary carrying the same version.

### Alpha.2 published-artifact verification record

The 2026-09-30 Linux x64 repeat migration used the checksum-verified CLI from
the public `0.14.0-alpha.2` GitHub release and the three published images. Image
revision labels matched release commit `8345c0e7`. Both the complete dry run
and live GitHub release workflow passed, including native packaging checks and
npm publication.

Importing the preserved 0.13.6 home into a fresh, distinct home copied 9,080
files (183,052,866 bytes), with zero conflicts and a 20-line human preview.
Every copied file matched its planned checksum before startup. The 29 reviewed
warnings comprised 21 generated dependency trees, six unsupported task backup
files, generated AKM metadata, and historical AKM configuration. Seven task
definitions were staged without activation. Both approved provider files were
copied privately by the importer; no missing-file copy or historical-config
quarantine workaround was needed.

Published-binary fixtures also verified default secret exclusion, opt-in
provider-file import/backup/restore, and whole-config omission for remote MCP,
local MCP environment credentials, and plugins, even with provider-auth opt-in.

First provider readiness failed with `Token refresh failed: 401`: the old
snapshot's OAuth refresh token had been invalidated during alpha.1 use. Reusing
the current preserved sign-in through OpenCode's native authentication API
restored readiness with the same provider/model. This is native token rotation,
not import corruption; ordinary users should use native provider sign-in again.
Original credentials were verified unchanged in both preserved homes. Every
other imported file still matched after startup.

Live checks passed authenticated native LAN access, guarded MCP model use,
imported AKM knowledge retrieval, credential/session isolation, policy-filtered
tools, injection blocking, workspace containment, and non-root mount boundaries.
The approved owner-only Discord chat policy connected to the real gateway.
Two timer-triggered runs retained their real model results on the host, and the
verification task was paused afterward. No Discord messages were sent;
interactive conversations, Slack, and public HTTPS/OAuth connectors were not
tested live in this walkthrough.

Complete cold archives of both previous homes were compared again after the
migration and still matched. Sparse-aware archiving saved little space for this
actual source; the separate named-volume archive's checksum was revalidated.
Both earlier installations and unrelated containers were preserved. Private
plans, logs, credentials, host details, and the comparison of all 15 prior
findings remain outside Git.

## Alpha.1 candidate verification record

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
