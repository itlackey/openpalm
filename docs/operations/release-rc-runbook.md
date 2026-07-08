# RC Release Runbook

Repeatable operator runbook for cutting an OpenPalm release candidate with the
single orchestrator at `.github/workflows/release.yml`.

Use this alongside:

- [Release Management](release-management.md)
- [Unit=All RC Checklist](unit-all-rc-checklist.md)

This runbook focuses on **how** to execute the checklist in a repeatable way:
ordered steps, exact commands, evidence to capture, and go/no-go gates.

---

## Audience

This is for the maintainer or operator preparing a coordinated release such as
`0.13.0-rc.1`.

---

## Scope

This runbook assumes a coordinated `unit=all` RC release and covers:

- merge readiness
- npm trusted-publisher readiness
- workflow dry run
- local/runtime validation
- post-publish verification

It does not replace the checklist; it tells you how to drive it.

---

## Release Variables

Set these once in your shell before running the procedure.

```bash
export RELEASE_REF="main"
export RC_VERSION="0.13.0-rc.1"
export RC_UNIT="all"
export REPO="$PWD"
export RC_EVIDENCE_DIR="$REPO/.release-evidence/$RC_VERSION"
mkdir -p "$RC_EVIDENCE_DIR"
```

Recommended convention:

- `RELEASE_REF` should be the branch that actually contains the release workflow
  changes you intend to use
- for the final RC cut, that should normally be `main` after merge

---

## Go / No-Go Gates

Do not merge and do not cut `0.13.0-rc.1` until every gate here is green.

### Merge gates

- [ ] release workflow changes required for the RC are merged
- [ ] `git status --short` is clean on the merge target
- [ ] `@openpalm/client` first-publish readiness is confirmed
- [ ] all local blocker fixes are committed and pushed

### RC cut gates

- [ ] branch-correct `release.yml` dry run passes for `unit=all`
- [ ] checklist items marked required in `unit-all-rc-checklist.md` pass
- [ ] no unresolved security-boundary regressions remain
- [ ] no unresolved rootless/ownership regressions remain
- [ ] no unresolved guardian/client/skeleton artifact drift remains

---

## Step 1: Confirm Registry And Publisher Readiness

### 1.1 Check which packages already exist

```bash
npm view @openpalm/client versions --json
npm view @openpalm/guardian versions --json
npm view @openpalm/skeleton versions --json
npm view @openpalm/ui versions --json
npm view openpalm versions --json
```

Expected at time of writing:

- `@openpalm/client` may 404 if it has never been published
- `@openpalm/guardian`, `@openpalm/skeleton`, `@openpalm/ui`, and `openpalm`
  should already exist

Record:

- command output
- whether `@openpalm/client` still needs first publish

### 1.2 Confirm npm trusted publisher configuration

Required packages:

- `@openpalm/lib`
- `openpalm`
- `@openpalm/ui`
- `@openpalm/client`
- `@openpalm/skeleton`
- `@openpalm/guardian`

Required trusted publisher values:

- Repository: `itlackey/openpalm`
- Workflow: `release.yml`
- Environment: none

If `@openpalm/client` is new, this is the one package most likely to still need
explicit npm-side setup.

Pass criteria:

- [ ] every required package has a matching trusted publisher entry
- [ ] the maintainer account has publish rights to `@openpalm/client`

---

## Step 2: Confirm Merge Target Is Ready

Run this on the branch you intend to merge.

```bash
git status --short
git log --oneline -10
```

Pass criteria:

- [ ] no uncommitted changes
- [ ] intended release fixes are present

If the release workflow or release-critical Docker/runtime fixes are not yet on
the merge target, stop here and merge first.

---

## Step 3: Merge The Release Fixes

Example sequence from a feature branch:

```bash
git checkout main
git pull origin main
git merge --ff-only <release-fix-branch>
git push origin main
```

If fast-forward is not possible, use your normal reviewed merge process.

Pass criteria:

- [ ] merge target now contains the release workflow fixes
- [ ] remote `main` is updated

Important:

- if you dispatch `gh workflow run release.yml` without `--ref`, GitHub uses the
  workflow definition on the default branch
- for final RC validation, this is desirable only after merge

---

## Step 4: Run The Coordinated Dry Run

Dispatch the dry run from the merge target:

```bash
gh workflow run release.yml \
  --ref "$RELEASE_REF" \
  -f unit="$RC_UNIT" \
  -f version="$RC_VERSION" \
  -f dry_run=true
```

Then inspect the latest run:

```bash
gh run list --workflow release.yml --branch "$RELEASE_REF" --limit 5
gh run view <run-id> --json status,conclusion,url,jobs
```

What to look for:

- `Compute version (all)` success
- `Preflight (test gate)` success
- `Stamp <version>` success
- `Docker openpalm/portal` success
- `Docker openpalm/assistant` success
- `Docker openpalm/guardian` success
- npm dry-run jobs success
- CLI binary jobs success
- Electron jobs success

Pass criteria:

- [ ] entire dry run succeeds
- [ ] no guardian Docker dry-run failure
- [ ] no regression guard failure

If a single job fails:

```bash
gh run view <run-id> --job <job-id> --log-failed
```

Capture the failing step and exact command/output.

---

## Step 5: Run Local Preflight Parity

```bash
bun install --frozen-lockfile
bun run client:build
bun run test
bun run ui:check
bun run ui-kit:check
bun run client:check
bun run --cwd packages/ui test:browsers
bun run ui:test:unit
bun run electron:test
bun run guardian:test
bun run cli:test
```

Guidance:

- if `packages/ui test:browsers` fails only because Playwright tries to install
  system packages with `sudo`, record it as an environment blocker rather than a
  product regression
- any real test failure in product code is a no-go

Pass criteria:

- [ ] all product tests/checks pass
- [ ] any env-only limitation is understood and documented

---

## Step 6: Run Runtime Validation

Use the dedicated checklist for exact items.

Minimum required runtime validations before RC publish:

- [ ] isolated assistant/client runtime
- [ ] guardian direct-ingress/CORS/auth
- [ ] browser-backed stack test
- [ ] rootless ownership stack smoke
- [ ] rootless portal-discord smoke
- [ ] rootless host-swap smoke
- [ ] fresh install smoke
- [ ] upgrade smoke

Reference commands and detailed pass criteria live in:

- [Unit=All RC Checklist](unit-all-rc-checklist.md)
- [Manual Compose Runbook](manual-compose-runbook.md)

Guidance:

- use unique ports/project names for every isolated stack run
- collect guardian logs whenever a direct-ingress or auth path fails
- when validating guardian behavior, prefer the actual built image/runtime over
  source-only reasoning

---

## Step 7: Make The Merge Decision

### Merge if all of these are true

- [ ] workflow dry run is green on the merge target
- [ ] no unresolved release blockers remain
- [ ] any waivers are explicit and low risk

### Do not merge if any of these are true

- [ ] guardian Docker dry run still fails
- [ ] `@openpalm/client` publish readiness is unknown
- [ ] rootless ownership is still red
- [ ] guardian direct-ingress behavior differs between source and built artifact
- [ ] upgrade/rollback behavior has not been validated

---

## Step 8: Cut `0.13.0-rc.1`

Only after merge and dry-run success:

```bash
gh workflow run release.yml \
  --ref "$RELEASE_REF" \
  -f unit="$RC_UNIT" \
  -f version="$RC_VERSION" \
  -f dry_run=false
```

Then monitor:

```bash
gh run list --workflow release.yml --branch "$RELEASE_REF" --limit 5
gh run view <run-id> --json status,conclusion,url,jobs
```

If the live release fails partway through:

```bash
gh run rerun <run-id> --failed
```

Do not start a fresh release for the same version unless you have a specific,
reviewed reason.

---

## Step 9: Post-Publish Verification

Immediately verify the real artifacts.

### npm

```bash
npm view @openpalm/lib@"$RC_VERSION" version
npm view openpalm@"$RC_VERSION" version
npm view @openpalm/ui@"$RC_VERSION" version
npm view @openpalm/client@"$RC_VERSION" version
npm view @openpalm/guardian@"$RC_VERSION" version
npm view @openpalm/skeleton@"$RC_VERSION" version
npm view @openpalm/discord-portal@"$RC_VERSION" version
npm view @openpalm/slack-portal@"$RC_VERSION" version
```

### dist-tags

```bash
npm view @openpalm/client dist-tags --json
npm view @openpalm/guardian dist-tags --json
npm view @openpalm/skeleton dist-tags --json
```

### Docker

```bash
docker buildx imagetools inspect openpalm/assistant:"$RC_VERSION"
docker buildx imagetools inspect openpalm/guardian:"$RC_VERSION"
docker buildx imagetools inspect openpalm/portal:"$RC_VERSION"
```

### GitHub release and tags

Verify:

- `platform-$RC_VERSION`
- `portals-$RC_VERSION`
- `assistant-$RC_VERSION`
- `guardian-$RC_VERSION`
- `electron-$RC_VERSION`
- `$RC_VERSION`

Pass criteria:

- [ ] all expected npm versions resolve
- [ ] all expected Docker tags resolve
- [ ] all expected tags/releases exist

---

## Step 10: Final RC Signoff

Create a release note or signoff comment that includes:

- RC version
- release run URL
- checklist status
- any waivers
- known issues still accepted into RC

Recommended signoff template:

```text
OpenPalm 0.13.0-rc.1 signoff

- Merge target: main
- Release workflow run: <url>
- Checklist: pass / fail / waived items listed below
- npm verification: pass
- Docker verification: pass
- GitHub tags/release verification: pass
- Known accepted RC limitations: <none or list>
```

---

## Maintainer Notes

- Prefer `--ref "$RELEASE_REF"` for all release workflow dispatches so the
  intended workflow definition is used
- Treat a new package like `@openpalm/client` as an npm-configuration task as
  well as a code/release task
- Keep the checklist and this runbook updated together; the checklist is the
  gate list, this runbook is the operating procedure

---

## Related Docs

- [Release Management](release-management.md)
- [Unit=All RC Checklist](unit-all-rc-checklist.md)
- [Manual Compose Runbook](manual-compose-runbook.md)
- [Core Principles](../technical/core-principles.md)
