# Release recovery — uninstallable 0.13.0-beta.1 portal packages (C1)

> Written 2026-07-11 as part of the release-DAG fix for the PR #559
> post-merge review (`docs/reviews/ui-admin-migration-review-2026-07-10.md`,
> finding **C1**). This doc cannot be executed from the sandbox this fix was
> authored in — no npm publish credentials, no network egress to the
> registry. It documents the exact manual commands a maintainer with npm
> publish access needs to run to unbreak the already-published beta. Delete
> this file (or move it to a changelog) once the recovery has actually been
> performed and verified.

## What's broken

`@openpalm/portal-sdk` was never added to the release publish DAG
(`.github/workflows/release.yml`). The already-published
`@openpalm/discord-portal@0.13.0-beta.1` and
`@openpalm/slack-portal@0.13.0-beta.1` both declare
`"@openpalm/portal-sdk": "workspace:*"` under `dependencies` (a real runtime
dependency, not a devDependency) — `bun pm pack` resolves that `workspace:*`
protocol reference to the on-disk version of `packages/portal-sdk` **at pack
time**, so the packed/published tarballs pin `@openpalm/portal-sdk@0.12.52`
exactly. `@openpalm/portal-sdk` itself was never published at any version.

Net effect: `npm install @openpalm/discord-portal@0.13.0-beta.1` (or
`@openpalm/slack-portal@0.13.0-beta.1`) fails outright, because its own
declared dependency 404s. This is the exact failure the portal container hits
on cold start (`containers/portal/start.sh:26-29` — cold start hard-fails
when `node_modules` is absent and the install errors).

### Verify the breakage (read-only, safe to run any time)

```bash
# Confirms @openpalm/portal-sdk has never been published (expect E404).
npm view @openpalm/portal-sdk versions --json

# Confirms the shipped adapters pin the unpublished exact version.
npm view @openpalm/discord-portal@0.13.0-beta.1 dependencies
npm view @openpalm/slack-portal@0.13.0-beta.1 dependencies
# Expect: { "@openpalm/portal-sdk": "0.12.52", ... }
```

## The in-repo fix (already applied on this branch)

- `.github/workflows/release.yml` gained an `npm-portal-sdk` job (mirrors the
  other `npm-*` jobs; `exact-version: true`), needs-ed by both
  `npm-discord-portal` and `npm-slack-portal`, and added to `tag-release`'s
  `needs`.
- `.github/release-package-groups.json`'s `units.portals` and
  `scripts/bump-unit.mjs`'s `UNITS.portals.stamp` now include
  `packages/portal-sdk/package.json`, so every future `unit=portals` (or
  `unit=all`) release stamps and publishes portal-sdk in lockstep with the
  adapters.
- `scripts/bump-unit.mjs`'s portals stamp also advances the operator-managed
  seed's caret ranges (`packages/skeleton/data/portal/tools/package.json`,
  `^0.12.0` → `^<new version>`) — caret ranges on a 0.x version only float the
  patch digit, so without this the seed would never reach a 0.13.x+ adapter
  for any existing `OP_HOME` install.
- `scripts/release-publish-dag.test.ts` gained a generic regression test:
  every published package's **runtime** (`dependencies`, not
  `devDependencies`) `workspace:*` reference must itself be a published DAG
  node. This fails on the unfixed workflow and is the test that should catch
  the next version of this bug class before it reaches npm.

None of this retroactively fixes the packages **already published** at
`0.13.0-beta.1` — that requires one of the two manual recovery paths below,
run by someone with npm publish rights to the `@openpalm` org.

## Recovery path A (recommended) — cut 0.13.0-beta.2 through the fixed DAG

This is the safest path: it goes through CI (OIDC trusted publishing, the
regression guard, the new DAG-completeness test) instead of a local ad-hoc
publish, and supersedes the broken beta with a real, fully-dependency-closed
release.

1. Merge this branch's `release.yml`/`release-package-groups.json`/
   `bump-unit.mjs` changes to the branch the Release workflow runs from
   (typically `main`).
2. Dispatch the `Release` workflow with `unit=portals`, `version=0.13.0-beta.2`,
   `dry_run=true` first to confirm the plan:
   ```bash
   gh workflow run release.yml \
     -f unit=portals \
     -f version=0.13.0-beta.2 \
     -f dry_run=true
   ```
3. Inspect the dry run's logs — confirm `npm-portal-sdk` runs and publishes
   before `npm-discord-portal`/`npm-slack-portal`, and that the "Preview
   (dry-run — no commit)" diff shows `packages/portal-sdk/package.json`,
   `portals/discord/package.json`, `portals/slack/package.json`, **and**
   `packages/skeleton/data/portal/tools/package.json` (the seed's caret range
   advancing to `^0.13.0-beta.2`... in practice you'll want the seed to track
   the eventual stable line, e.g. `^0.13.0`, so plan the real cut's version
   accordingly).
4. Re-run for real:
   ```bash
   gh workflow run release.yml \
     -f unit=portals \
     -f version=0.13.0-beta.2 \
     -f dry_run=false
   ```
5. Verify:
   ```bash
   npm view @openpalm/portal-sdk@0.13.0-beta.2 version
   npm view @openpalm/discord-portal@0.13.0-beta.2 dependencies
   npm view @openpalm/slack-portal@0.13.0-beta.2 dependencies
   # Expect discord/slack's @openpalm/portal-sdk entry to read 0.13.0-beta.2,
   # and that version to actually resolve (no E404).
   ```
6. Point operators (or the default seed shipped in future
   `packages/skeleton` releases) at the new adapter version. Existing
   `OP_HOME/data/portal/tools/package.json` seeds pinned to the old
   `^0.12.0` range will NOT pick this up automatically — see "Existing
   installs" below.

## Recovery path B (emergency) — publish `@openpalm/portal-sdk@0.12.52` as-is

Use this only if a new adapter cut (path A) isn't feasible immediately and
the already-published `0.13.0-beta.1` adapters must be made installable
without republishing them. `packages/portal-sdk`'s *source* is byte-for-byte
unchanged between the pre-migration reference commit (`455d8728`) and this
branch, but its manifest version was stamped to `0.13.0-beta.1` when it
joined the `portals` release unit (CI's per-unit version sync requires unit
members to agree) — so publishing `0.12.52` requires a one-line local
version edit that is **not committed**:

```bash
git checkout main && git pull
cd packages/portal-sdk
# Temporarily restore the version the beta-1 adapters pinned. Do NOT commit
# this — the in-repo version must stay in sync with the portals unit.
npm pkg set version=0.12.52
node -p "require('./package.json').version"   # sanity check: expect 0.12.52
bun install

# Provenance attestation (--provenance) requires GitHub Actions OIDC — it is
# not available from a local/manual publish. Drop it here; publish via the
# Release workflow (path A) instead whenever provenance matters.
npm publish --access public

# Discard the uncommitted version edit.
git checkout -- package.json ../../bun.lock
```

Verify:

```bash
npm view @openpalm/portal-sdk@0.12.52 version
npm view @openpalm/discord-portal@0.13.0-beta.1 dependencies
npm install @openpalm/discord-portal@0.13.0-beta.1 --dry-run   # in a scratch dir
```

**This path leaves `@openpalm/portal-sdk` permanently anchored at `0.12.52`
even though the adapters are at `0.13.0-beta.1`.** The next real `portals`
release (now that C1's DAG fix is in place) will publish
`@openpalm/portal-sdk` at the adapters' new version and re-close the gap —
but until then, portal-sdk's version number understates how current its
published contents are. Prefer path A when at all possible.

## Existing installs — the `^0.12.0` seed range

`OP_HOME/data/portal/tools/package.json` (seeded from
`packages/skeleton/data/portal/tools/package.json`) pins
`@openpalm/{discord,slack}-portal` with a `^0.12.0` caret range. Caret ranges
on a pre-1.0 version only float the **patch** digit — `^0.12.0` is
`>=0.12.0 <0.13.0` — so no amount of `bun update` on an existing install will
ever reach `0.13.x`, regardless of which recovery path above is taken. The
in-repo fix makes future `portals` releases advance this range automatically
(`scripts/bump-unit.mjs`'s `stampPortalToolsSeedRanges`), but that only
affects the seed shipped in a **future** `@openpalm/skeleton` publish — it
does not retroactively update files already written to existing operators'
`OP_HOME` directories.

Operators who want the fixed adapters before their next `openpalm update`
picks up a new skeleton can hand-edit their seed once:

```bash
# In OP_HOME/data/portal/tools/package.json
"@openpalm/discord-portal": "^0.13.0",
"@openpalm/slack-portal":   "^0.13.0"
```

then restart the portal container so `containers/portal/start.sh` re-runs
`bun install --cwd /opt/openpalm/tools --production`.
