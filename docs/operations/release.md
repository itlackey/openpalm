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

Codex and Claude Code native remote access remain explicitly experimental
in 0.14.0, including its stable release. They remain optional and default-off.
Their documented host/account limitations and unverified vendor-client paths
must not be advertised as stable capabilities. Promotion is a separate future
release decision after real sign-in, tool execution, approvals, and reconnect
acceptance. Their failure isolation and normal security gates remain required.

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

## Beta.2 published-artifact verification

On 2026-10-01, `0.14.0-beta.2` was published from the frozen
`release/0.14.0-beta.2` candidate
`a6300cd83857961812b84116f3921b2887052761`. Concurrent naming/fork documentation
continued on the lean branch; it did not change the tested release commit.
The complete [dry run](https://github.com/itlackey/openpalm/actions/runs/36928384003)
and [live publication](https://github.com/itlackey/openpalm/actions/runs/36930442528)
passed. GitHub built and verified the entire release; Gitea received source only.

The first live attempt failed while exporting the Guardian AMD64 build cache:
GitHub's backing blob returned `404 BlobNotFound`. Publication was blocked.
Rerunning only failed jobs and their dependents on the identical commit resolved
the infrastructure failure. No code, security gate, image tag, or package version
was changed to work around it.

The public [beta.2 release](https://github.com/itlackey/openpalm/releases/tag/0.14.0-beta.2)
contains all 13 expected assets. GitHub downloaded and checksum-validated the
uploaded set before publication. Independent Linux x64 CLI and MCPB downloads
matched their published checksums; the CLI reported `0.14.0-beta.2`, exposed
native history recovery, and retained experimental remote-access warnings.
Initial restricted-shell stream-descriptor warnings disappeared when the same
verified CLI ran with normal host permissions; version/help commands were clean.

Independent registry inspection verified AMD64 and ARM64 configurations for all
three public images, with non-root users and the exact candidate revision label.
The workflow published SBOM/provenance and signed the immutable image manifests.
Native image gates covered startup/security, all three AKM harnesses, failure
isolation, and real-engine native history recovery. Image scans reported unfixed
upstream OS high advisories; these remain visible, not described as repaired.
All critical and fixable-high gates passed.

Public npm checks confirmed `openpalm@beta` resolves to `0.14.0-beta.2`; `latest`
remains `0.13.6`. The first metadata read briefly returned the old beta tag while
the new version was already available; a subsequent read confirmed propagation
without republishing or a local registry write.

The UI changes had already passed the real Electron/Docker walkthrough and a
three-reviewer panel. Their management fixture does not claim successful native
subscription sign-in or a new live-provider acceptance. Codex/Claude remote
access remain experimental and default-off. The 0.13 fresh-install/import boundary
is unchanged, with separate history/external-data recovery rather than a claim
that portable copying is complete migration. No production instance, including
Splinter, was updated during publication.

## Beta.1 candidate verification record

The beta includes guided native Codex recall approval, policy-aware shared
Assistant instructions, and explicit experimental labeling of both Codex and
Claude Code remote access. Local package tests, type checks, lint, CLI/Admin
builds, real three-harness recall, and Electron/Docker native-approval persistence
passed. The real Discord owner mapping was checked through the same portal MCP
client and a completed `remote-full` tool invocation; the operator also confirmed
that the Discord conversation worked afterward. Default chat policy and the
operator's portal allowlist stayed unchanged. Private user mappings are not
part of the release or repository.

These checks do not claim authenticated vendor remote-session acceptance. That
feature remains experimental and default-off, with the documented Codex
host-sandbox limitation.

### Beta.1 published-artifact verification

On 2026-10-01, the exact candidate
`bc58bddc9d176ccd79ec1aa1f034cf702f8d753c` passed GitHub's complete
[dry run](https://github.com/itlackey/openpalm/actions/runs/36877653074)
and [live publication](https://github.com/itlackey/openpalm/actions/runs/36880456607).
The public [0.14.0-beta.1 release](https://github.com/itlackey/openpalm/releases/tag/0.14.0-beta.1)
contains all 13 expected assets. The live workflow downloaded and validated the
complete uploaded asset set before publication. Independent Linux x64 CLI and
MCPB downloads matched their published SHA-256 checksums; the native CLI reported
the beta version and retained both experimental remote-access warnings.

All three public image tags were pulled and matched the candidate's revision
label. Their manifests include Linux AMD64 and ARM64; the release workflow
published SBOM/provenance and signed their immutable digests. The published
Assistant passed real OpenCode, Claude Code, and Codex AKM recall smokes, including
native Codex approval persistence, changed-definition review, stale-approval
rejection, and opt-out persistence. No vendor account or production instance was
used for these disposable-fixture tests.

The npm bootstrap was published through GitHub OIDC. Independent public registry
checks confirmed `openpalm@beta` resolves to `0.14.0-beta.1`; `latest` remains
`0.13.6`. The initial registry metadata briefly returned the previous beta tag
and a missing-version response while publication propagated; both resolved
without a republish or local registry write.

This remains a testing prerelease with the fresh-install/allowlisted-import
boundary for 0.13 homes. Splinter was not upgraded as part of cutting this beta.

### Splinter alpha.4-to-beta.1 verification

After separate operator approval on 2026-10-01, Splinter updated using the public
checksum-verified Linux x64 CLI and the three published beta.1 images. All image
revision labels matched `bc58bddc9d176ccd79ec1aa1f034cf702f8d753c`. Before
installing the CLI, only Splinter was stopped and its complete home was archived;
the cold archive was compared against its source and its checksum retained
privately for rollback.

Assistant, Guardian, and Discord were healthy afterward. Stack intent and all
32 protected configuration, credential, provider-secret, task-definition, and
delegated-keyring files stayed unchanged. Six unrelated running containers were
preserved. OpenCode retained its explicit authenticated LAN binding, Guardian
remained loopback-published, and real no-tool provider readiness passed before
and after the update. All services retained their non-root, capability-dropped
boundaries; no delegated credential or Docker socket reached Assistant.

Live checks rejected anonymous native/MCP access, listed sessions, retained the
Discord owner-only allowlist and owner-to-`full` mapping, and confirmed the
default Discord credential remained `chat`. The same portal client completed
a harmless directory tool call in a real `remote-full` session. Cross-credential
session access and workspace traversal were rejected. No Discord messages were
posted. Bun 1.4.2, Node 24.21.0, and both enabled native AKM plugin registrations
at 0.9.20202610010250 were verified in the upgraded Assistant.

No product upgrade issue was encountered. One verification assertion initially
looked for raw tool parts in Guardian's sanitized message summaries; the corrected
check verified native tool evidence through the authenticated OpenCode API.
Codex recall review now works on the installed beta image and reports two hooks
with `approval-needed`. No native approval was granted or changed. Codex/Claude
remote switches and login state were preserved; authenticated vendor remote
acceptance was not tested and remains experimental.

## Alpha.4 candidate verification record

The 2026-10-01 local Linux x64 candidate passed the full package/security suite,
type checks, lint, frozen install, dependency audit (no advisories), CLI/MCPB/Admin
builds, all-profile Compose validation, and startup smokes for all three images.
Assistant smokes exercised real OpenCode, Claude Code, and Codex session/prompt
hooks with AKM 0.9.20 and plugin 0.9.20202610010250. Each recalled the same
isolated knowledge asset. No vendor accounts or model responses were used for
that lane; Codex trust was granted only in a disposable fixture after confirming
the production defaults were untrusted. Restart checks preserved user settings
and refreshed untouched native plugin registrations. Missing vendor logins
still failed independently without degrading Assistant/scheduler health.

The real Electron 44.5.1 setup walkthrough passed twice: without a provider it
truthfully retained incomplete setup, and with approved OpenCode Go credentials
it completed actual readiness and a live MCP response after restart. Both
verified startup recovery, policy-filtered MCP, credential/portal mapping,
preference persistence, native-setup consent/sandbox controls, layout reflow,
and keyboard focus. The design reviewer approved all ten border-fix screenshots;
the provider-backed run retained eleven screenshots including the ready state.
These are local candidate checks, not yet proof of published artifacts or
authenticated Claude/Codex remote sessions.

Real-provider acceptance also passed automatic knowledge capture, an actual
recurring timer execution, pause/resume, update/restart recall, resumable MCP
jobs, cross-identity rejection, explicit permission approval, workspace
containment, and credential rotation. Five direct model requests were used;
background capture and the real scheduler were exercised separately. The
disposable stack was stopped and its private home/report retained afterward.

The initial GitHub dry run passed all quality/security gates and the native
AMD64 harness checks, but OpenCode recall timed out under ARM64 QEMU emulation.
No failed candidate was published. Runtime image gates now use standard native
AMD64/ARM64 GitHub runners and assert the runner architecture, rather than
weakening hook deadlines or adding emulation-specific plugin behavior.

The native-runner dry run passed completely. The first live dispatch then
stopped before publication when the CLI update integration test exceeded Bun's
default five-second test deadline. Its test deadline now matches the existing
30-second Compose subprocess budget, without removing assertions. Twenty
consecutive repetitions passed using the exact image/CI Bun 1.4.2 runtime.

### Alpha.4 published-artifact and Splinter verification

The final GitHub dry run and live publication passed for commit
`2f664287493025c1eb802a853039bbfdf85f39c6`. GitHub built the release, signed
all three multi-architecture images, verified the public assets/checksums, and
published the npm bootstrap. Both development remotes contain the changes.

Splinter updated from alpha.3 using the public checksum-verified Linux x64 CLI
and published images with matching revision labels. A verified cold backup
was retained before replacing its CLI or recreating containers. Assistant,
Guardian, and Discord were healthy afterward. Stack intent and all 17 protected
configuration/credential/provider-secret files remained unchanged; OpenCode
retained its explicit LAN bind at `192.168.0.201:3810`. Real no-tool provider
readiness passed before and after the update. Live Guardian MCP rejected
anonymous access with 401 and returned all eleven owner-policy tools.

All three published images passed local startup/security smoke. The published
Assistant also passed real session/prompt-hook recall in OpenCode, Claude Code,
and Codex, using AKM 0.9.20 and plugin 0.9.20202610010250. The upgraded instance
reported Bun 1.4.2, real Node 24.21.0, enabled native Claude/Codex registrations,
and the effective `workspace-write` sandbox default.

One host-verification assertion initially expected the update to persist the new
sandbox field in existing stack intent. The updater correctly preserved intent
and derived the default; correcting that assertion completed verification
without changing product code or operator configuration. Neither native vendor
account is signed in, so authenticated Claude/Codex remote-client connectivity
and Codex sandboxed tool execution remain unverified on this host. Codex hooks
remain subject to normal native approval; disposable test trust is not copied
into Splinter.

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
