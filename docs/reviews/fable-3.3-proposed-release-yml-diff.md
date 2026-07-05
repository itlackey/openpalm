# Fable remediation 3.3 — release-unit publish coupling (proposed diff, NOT applied)

**Status: proposal only. No file under `.github/workflows/` has been modified by this change.**

Per the standing project rule (`CLAUDE.md`, "NEVER modify workflows without explicit approval")
and per the remediation plan's own instruction for this item ("no workflow edits without explicit
owner approval — this item ships as a proposed diff for review"), this document is the deliverable
for plan item 3.3. It contains the confirmed gap, the trade-off the fix runs into, and a ready-to-apply
diff for the owner to review and approve before it is merged into `.github/workflows/release.yml`.

## The gap (confirmed, with evidence)

`ui` and `electron` are already the same `platform` bump unit in
`.github/release-package-groups.json` — their version *numbers* can never diverge. The real risk is
in `release.yml`'s job gating, not group membership:

- For `unit=platform`, the Electron installer job is **optional**: it only runs when
  `include_electron=true` or the bump is non-patch (`release.yml:713-729`). Default inputs are
  `bump=patch`, `include_electron=false`, so on a typical patch release the `electron` job is
  **skipped** (not failed).
- `tag-release`'s guard is `!contains(needs.*.result, 'failure')` (`release.yml:791-796`) — a
  **skipped** `electron` job does not block it.
- For `unit=platform`, `tag-release` unconditionally creates *both* the `platform-X.Y.Z` tag/release
  *and* the bare `X.Y.Z` tag/release (`release.yml:872-875` for tags, `:910-914` for GitHub releases),
  regardless of whether `electron` ran.
- The bare `X.Y.Z` release is what **two different consumers** resolve via GitHub's
  `/releases/latest`:
  - `scripts/setup.sh:73` (`curl -sI .../releases/latest` → CLI binary download)
  - `packages/electron/src/update-check.ts:135-187` (`checkForElectronUpdate`, stable mode) — compares
    only `tag_name` vs the running app's version; it does **not** check whether the candidate release
    has any installer assets attached (contrast with `packages/ui/src/lib/server/release-units.ts:132-162`
    `selectInstallableReleases`, which already filters on `hasElectronBuild` before treating a release
    as "installable" — the desktop client's own update check lacks that same filter).

Net effect: a default-flags `unit=platform` patch release publishes `@openpalm/ui` to npm, creates a
new bare `X.Y.Z` GitHub release with **zero** Electron installer assets, and the already-installed
desktop app's auto-update check reports "update available" for a version it cannot actually download
an installer for — version limbo, matching the plan's description of R7-F5.

## Why this isn't a one-line fix — the trade-off

`release.yml`'s own header documents the competing goal directly (`release.yml:40-43`,
"Thin-host decoupling: guardian and platform npm packages can be released independently of Docker
images. npm patches deploy instantly to thin-host deployments without a docker pull."). The CLI (`cli`
job) is *not* optional for `unit=platform` — it always builds — so `setup.sh`'s use of the same bare
"latest" release is never broken by an Electron skip. Making Electron mandatory (or gating the shared
"latest" release on it) trades away the fast-patch-cadence guarantee for the desktop-installer-safety
guarantee, and does so at a real CI cost (electron job builds on 3 runners, mac/linux/win, ~20-30 min).
That's a policy decision, not a bug fix, which is exactly why the plan calls for an explicit owner
sign-off before touching `release.yml`.

## Two candidate fixes (owner picks one)

### Option A — gate the shared bare release on Electron (in `release.yml`, as the plan specifies)

Only advance the bare `X.Y.Z` "latest" tag/release when this run's `electron` job actually succeeded.
`platform-X.Y.Z` (unit-prefixed) is still created every time, so npm/thin-host consumers that read the
unit-prefixed tag directly are unaffected — only the shared "latest" endpoint stops advancing until a
release with a matching installer ships. This is the literal reading of "fix in release.yml (publish
gates, not group membership)."

**Cost:** `setup.sh`'s default `/releases/latest` resolution — which today advances on every patch
release — would stop advancing on `include_electron=false` patch releases too, since it reads the same
bare tag as the desktop updater. Thin-host users who want the very latest patch would need to pass an
explicit version/tag instead of relying on "latest". This directly narrows the "instant npm patch"
promise in the file header above.

Verified with `git apply --check` against `.github/workflows/release.yml` at this branch's HEAD — applies
cleanly (dry-run only; not applied to the tree):

```diff
--- a/.github/workflows/release.yml
+++ b/.github/workflows/release.yml
@@ -837,6 +837,7 @@
         env:
           VERSION: ${{ needs.compute-version.outputs.new_version }}
           UNIT: ${{ inputs.unit }}
+          ELECTRON_OK: ${{ needs.electron.result == 'success' }}
           GH_TOKEN: ${{ github.token }}
         run: |
           git config user.name "github-actions[bot]"
@@ -870,9 +871,18 @@
             done
             create_tag "${VERSION}" "All-units release ${VERSION}"
           elif [ "${UNIT}" = 'platform' ]; then
-            # Platform releases also create the bare X.Y.Z summary — asset download URLs use this tag
+            # Platform releases also create the bare X.Y.Z summary — asset download URLs use this tag.
+            # The bare tag is what BOTH setup.sh/setup.ps1 AND the packaged Electron app's
+            # auto-update check (update-check.ts) resolve via `/releases/latest`. Only advance it
+            # when this run actually published a matching installer, or a patch release with
+            # include_electron=false would advertise "update available" with no installer to
+            # download (plan 3.3 / R7-F5).
             create_tag "platform-${VERSION}" "Release platform ${VERSION}"
-            create_tag "${VERSION}" "Platform release ${VERSION}"
+            if [ "${ELECTRON_OK}" = 'true' ]; then
+              create_tag "${VERSION}" "Platform release ${VERSION}"
+            else
+              echo "::notice::Skipping bare ${VERSION} tag — no Electron installer built this run (include_electron=false, patch bump). 'latest' stays on the previous complete release."
+            fi
           elif [ "${UNIT}" = 'images' ]; then
             # Docker-only release: tag as images-X.Y.Z (no bare X.Y.Z alias)
             create_tag "images-${VERSION}" "Release images ${VERSION}"
@@ -884,6 +894,7 @@
         env:
           VERSION: ${{ needs.compute-version.outputs.new_version }}
           UNIT: ${{ inputs.unit }}
+          ELECTRON_OK: ${{ needs.electron.result == 'success' }}
           PRERELEASE: ${{ needs.compute-version.outputs.prerelease }}
           GH_TOKEN: ${{ github.token }}
         run: |
@@ -909,9 +920,15 @@
             create_release "${VERSION}" "OpenPalm ${VERSION} (all units)"
           elif [ "${UNIT}" = 'platform' ]; then
             # Mirror the tag step: platform also publishes the bare X.Y.Z release —
-            # setup.sh / setup.ps1 download CLI assets from the bare-tag release.
+            # setup.sh / setup.ps1 download CLI assets from the bare-tag release, and the
+            # Electron auto-updater reads the same release. Only create/advance it when a
+            # matching installer was actually built this run (see tag step above).
             create_release "platform-${VERSION}" "OpenPalm platform ${VERSION}"
-            create_release "${VERSION}" "OpenPalm platform ${VERSION}"
+            if [ "${ELECTRON_OK}" = 'true' ]; then
+              create_release "${VERSION}" "OpenPalm platform ${VERSION}"
+            else
+              echo "::notice::Skipping bare ${VERSION} GitHub release — no Electron installer built this run."
+            fi
           elif [ "${UNIT}" = 'images' ]; then
             create_release "images-${VERSION}" "OpenPalm images ${VERSION}"
           else
```

### Option B — fix the consumer instead (smaller, zero CI cost, zero thin-host regression)

`packages/electron/src/update-check.ts` already has everything it needs to make this correct without
touching `release.yml` at all: switch `checkForElectronUpdate`'s stable-mode fetch from
`/releases/latest` (single object, no asset introspection) to a fetch that includes `assets`, and only
treat a release as `updateAvailable` when it has a matching installer asset for the assets pattern
already defined in `packages/ui/src/lib/server/release-units.ts:42`
(`ELECTRON_ASSET_PATTERN = /^OpenPalm-.*\.(dmg|AppImage|zip|deb|rpm|pkg)$/i`). This preserves the
"thin-host instant npm patch" guarantee exactly as documented, costs nothing in extra CI time, and is a
strictly smaller diff — but it is a fix in the Electron client, not in `release.yml`, so it does not
match the plan's literal instruction ("Fix in `release.yml`"). Flagging this back to the plan for the
owner to confirm whether the "in `release.yml`" constraint was a hard requirement or an assumption
about where the fix would have to live.

## Recommendation

Option B is the smaller, lower-risk, zero-regression fix and is recommended if the owner is open to a
client-side fix. Option A is the literal "fix in `release.yml`" reading the plan asked for, ready to
apply as-is if the owner accepts narrowing the thin-host "latest" guarantee.

Neither diff has been applied. Apply Option A to `.github/workflows/release.yml` (or implement Option B
in `packages/electron/src/update-check.ts`) only after explicit owner sign-off, per the standing
workflow-approval rule.
