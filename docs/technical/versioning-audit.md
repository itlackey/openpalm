# Versioning End-to-End Audit — Reviewed Implementation Plan

**Date:** 2026-06-17  
**Status:** Findings verified by Opus architectural review. Implementation plan is signed off and ready to execute.

---

## Background

OpenPalm moved to independently versioned units (platform, portals, assistant, guardian) with unit-prefixed git tags (`platform-X.Y.Z`) in 0.12.4. This introduced a three-way version concept that was not previously necessary:

1. **npm version** — what `PLATFORM_VERSION` is baked to at build time (e.g., `0.12.6`)
2. **Docker image tag** — what lives on Docker Hub, what `OP_IMAGE_TAG` is set to (e.g., `v0.12.6`)
3. **Git release tag** — GitHub tag used for asset downloads (e.g., `platform-0.12.6` or legacy `v0.12.6`)

---

## Verified Findings

### CRITICAL-1 — Two upgrade paths pass different tag formats to `applyUpgrade` ✅ CONFIRMED

`packages/lib/src/control-plane/lifecycle.ts`

- `applyTagChange` (UI path, line ~720): passes `resolvedTag` — can be `platform-0.12.6` ✓
- `performUpgrade` (CLI path, line ~640): passes `confirmedImageTag` — always `v0.12.6` (Docker tag)

`applyUpgrade` calls `refreshCoreAssets(version)` which builds a raw.githubusercontent.com URL from that ref. Both `platform-0.12.6` and `v0.12.6` are valid git tags today, but the paths are inconsistent.

**Fix:** In `performUpgrade`, convert the Docker tag to the canonical release tag before passing to `applyUpgrade`:
```ts
applyUpgrade(state, 'platform-' + normalizeVersion(confirmedImageTag))
```
Keep as a 1-line inline — do not introduce a new exported helper function.

---

### CRITICAL-2 — `hasElectronBuild` regex false-positive on CLI `.exe` ✅ CONFIRMED (partially fixed)

`packages/ui/src/routes/admin/versions/releases/+server.ts`

The `.exe` extension was removed in commit `94e2ebad`. However, the Opus review identifies that:
1. The Windows Electron installer ships as `.zip` (not `.exe`) — pattern should include `.zip`
2. The pattern should be anchored to the Electron installer filename prefix to avoid future false positives

**Fix (replaces the partial fix already shipped):**
```ts
const electronAssetPattern = /^OpenPalm-.*\.(dmg|AppImage|zip|deb|rpm|pkg)$/i;
```
This correctly includes `OpenPalm-0.12.4-win.zip` (Windows Electron) and excludes `openpalm-platform-0.12.6-deploy-bundle.tar.gz` and CLI binaries.

---

### CRITICAL-3 — Unit version anchors drift after platform CI ✅ CONFIRMED — Option B recommended

`containers/assistant/VERSION` = 0.12.5, `containers/guardian/package.json` = 0.12.5 while platform = 0.12.6.

The drift is **cosmetic** — Docker push tags in `release.yml` come from `v${PLATFORM_VERSION}`, not from the unit anchors. Anchors are only read by `bump-unit.mjs` to compute the next version for an independent unit release.

**Fix (Option B — documentation + guard, no anchor stamping):**
- Add a comment block in `bump-unit.mjs` at the `UNITS` definition explaining that anchors track each unit's *own* last independent release, not the platform version
- In `release.yml`, add a `docker manifest inspect` guard before unit image push to fail loudly if the computed `v${VERSION}` image tag already exists on Docker Hub for that unit (prevents the double-push scenario)

Do NOT stamp assistant/guardian anchors on platform CI (Option A) — that couples independent units and creates noisy no-op commits.

---

### HIGH-1 — Release download URL is structurally dead for compose assets ✅ CONFIRMED — more severe than originally stated

`packages/lib/src/control-plane/core-assets.ts`

URL #1 in `downloadAsset` (`releases/download/{version}/{filename}`) has `filename = '.openpalm/config/stack/core.compose.yml'` — a repo path with slashes. GitHub release assets are flat filenames. The compose files are only bundled inside `deploy-bundle.tar.gz`, never as standalone release assets. This URL **structurally cannot resolve** for compose assets, under any tag, for any release format.

URL #2 (raw.githubusercontent.com) is the only one that can work and always has.

**Fix:** Remove the release URL attempt from `downloadAsset` entirely. Keep only the raw URL, which needs a valid git ref. This is the complementary fix to CRITICAL-1: Task 2+3 must land together — once `performUpgrade` passes `platform-{version}`, the raw URL always resolves cleanly.

**Answers Q5 (v* tag long-term):** Once Tasks 2+3 ship and become the floor, the `v{VERSION}` git tag in the platform release workflow can be removed. Until then, keep creating it — older installs in the field still have code that passes `v{version}` to the raw URL.

---

### HIGH-2 — Inconsistent v-prefix across data sources ✅ CONFIRMED

| Source | Format |
|---|---|
| `latestImageTag` (Docker Hub) | `v0.12.6` (v-prefixed) |
| `releases[].tag` (GitHub releases endpoint) | `0.12.6` (v stripped) |
| `platformVersion` (UI endpoints) | `0.12.6` (v stripped) |
| `services[].version` (env vars) | `v0.12.6` (v-prefixed) |

**Fix:** Strip v-prefix from `latestImageTag` at the `versions/+server.ts` boundary (wrap lines 69 and 71 results in `formatForDisplay(...)`). All internal comparisons then operate on bare semver. Pairs with MEDIUM-2 fix.

---

### MEDIUM-1 — `platformVersion` redundantly returned by both version endpoints ✅ CONFIRMED

`+page.svelte` sets `platformVersion` from `/admin/versions` (line ~276), then overrides it from `/admin/versions/releases` (line ~290). Both return `formatForDisplay(PLATFORM_VERSION)` — the same value.

**Fix:** Remove `platformVersion` from the releases endpoint response and the `if (releaseData.platformVersion)` override in `+page.svelte`.

---

### MEDIUM-2 — Upgrade card label shows `platformVersion`; button targets Docker Hub ✅ CONFIRMED — worse than originally stated

UpdatesTab "Your services are on 0.12.5 — update to **0.12.6**" uses `platformVersion` (baked at build) for the label. But the "Update now" button calls `/admin/upgrade` → `performUpgrade` which resolves its target from **Docker Hub** (`resolveLatestPlatformTagForCurrentMajor`), not `platformVersion`. The label and the button's actual behavior are already inconsistent.

**Fix:** Pass `latestImageTag` as a prop into `UpdatesTab`. Use it for the "update to X" label in the card. Keep `platformVersion` only for `serviceStatus()` ("is this service behind the control plane" comparison). Now label matches what the button actually does.

Note from Q3 review: there is no "Docker ahead of control plane" risk introduced — `performUpgrade` already pulls the newest published image for the current major via `*ForCurrentMajor`. Making the label honest does not change behavior.

---

### LOW-1 — `resolveLatestPlatformTag` export ❌ FINDING IS WRONG — DO NOT REMOVE

`resolveLatestPlatformTag` **is** imported by `packages/ui/src/routes/admin/versions/+server.ts:71`. Removing it from the lib export would break the UI build. Reject this finding.

---

### LOW-2 — `electron/admin-tools/package.json` stamped without existence check ✅ CONFIRMED (low priority)

**Fix:** Assert each file path exists in `bump-unit.mjs` before stamping; fail loudly if missing.

---

## Implementation Plan (Ordered)

### Task 1 — Tighten `hasElectronBuild` regex (standalone)
**File:** `packages/ui/src/routes/admin/versions/releases/+server.ts:46`  
**Change:**
```ts
// Before (partially fixed in 94e2ebad):
const electronAssetPattern = /\.(dmg|AppImage|deb|rpm|pkg)$/i;
// After:
const electronAssetPattern = /^OpenPalm-.*\.(dmg|AppImage|zip|deb|rpm|pkg)$/i;
```
Includes Windows `.zip` Electron installer; excludes deploy bundles and CLI binaries by anchoring on `^OpenPalm-`.  
**Requires platform release:** Yes (UI bundle change).

---

### Tasks 2+3 — Unify upgrade paths + drop dead release URL (coupled pair, one PR)
**File A:** `packages/lib/src/control-plane/lifecycle.ts` (~line 640 in `performUpgrade`)  
**Change A:** Replace `applyUpgrade(state, confirmedImageTag)` with:
```ts
applyUpgrade(state, 'platform-' + normalizeVersion(confirmedImageTag))
```

**File B:** `packages/lib/src/control-plane/core-assets.ts` (`downloadAsset`)  
**Change B:** Remove the `releaseUrl` attempt. Keep only the raw.githubusercontent.com URL. The raw URL takes a git ref; `platform-{version}` always exists as a git tag and carries the full repo tree.

These must land together: Task 2 ensures a valid `platform-*` ref is passed; Task 3 makes the raw URL the single download strategy. Requires platform release.

---

### Task 4 — Tighten `extractDockerTagFromReleaseTag` regex (standalone)
**File:** `packages/lib/src/control-plane/lifecycle.ts:331`  
**Change:**
```ts
// Before:
const unitPrefixMatch = tag.match(/^[a-z]+-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?)$/);
// After:
const unitPrefixMatch = tag.match(/^(?:platform|portals|assistant|guardian)-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?)$/);
```
Add/extend test in `upgrade-path.test.ts` to cover all four unit prefixes and a bare `v*` tag.  
**Requires platform release:** Yes.

---

### Tasks 5+7 — Normalize `latestImageTag` + fix card label (coupled pair, one PR)
**File A:** `packages/ui/src/routes/admin/versions/+server.ts` (lines 69, 71, 89)  
**Change A:** Wrap Docker Hub result in `formatForDisplay(...)` before returning so `latestImageTag` is bare semver (`0.12.6` not `v0.12.6`).

**File B:** `packages/ui/src/routes/admin/+page.svelte`  
**Change B:** Pass `latestImageTag` as a prop to `<UpdatesTab>`.

**File C:** `packages/ui/src/lib/components/admin/updates/UpdatesTab.svelte`  
**Change C:** Add `latestImageTag` prop. Replace `platformVersion` with `latestImageTag` in the card's "update to X" label (lines ~439, ~504). Keep `platformVersion` only in `serviceStatus()` comparison at line ~143.

Land together so both label and format are consistent. Requires platform release.

---

### Task 6 — Remove redundant `platformVersion` from releases endpoint (standalone)
**File A:** `packages/ui/src/routes/admin/versions/releases/+server.ts`  
**Change A:** Remove `const platformVersion = formatForDisplay(PLATFORM_VERSION)` and drop `platformVersion` from the `json({...})` return.

**File B:** `packages/ui/src/routes/admin/+page.svelte`  
**Change B:** Delete `if (releaseData.platformVersion) platformVersion = releaseData.platformVersion;`

Safe standalone — `platformVersion` is already set authoritatively from `/admin/versions`. Requires platform release.

---

### Task 8 — Document anchor drift + add no-double-push guard (CI only, no platform release needed)
**File A:** `scripts/bump-unit.mjs` — add comment block at `UNITS` explaining anchors track each unit's own last independent release, not the platform version.

**File B:** `.github/workflows/release.yml` — in the non-major per-unit branch, before the docker push jobs, add a `docker manifest inspect openpalm/{service}:v${VERSION}` check. Fail the job if the image already exists at that tag (prevents accidentally re-pushing over an existing release).

Takes effect on next CI run.

---

### Task 9 — Harden bump script file-existence assertions (CI only)
**File:** `scripts/bump-unit.mjs`  
**Change:** In `stampJsonFiles` and `stampVersionFile`, assert each path exists with a clear error message before attempting to stamp.

---

## Dependency Graph

```
Task 1  (standalone)
Tasks 2+3  (coupled — land together)
Task 4  (standalone)
Tasks 5+7  (coupled — land after Task 5 normalizes format)
Task 6  (standalone)
Task 8  (standalone, CI only)
Task 9  (standalone, CI only)

Drop v* git tag creation  (do AFTER Tasks 2+3 have been the floor for one release cycle)
```

---

## What NOT to do

- Do NOT remove `resolveLatestPlatformTag` from lib exports — it is used by `versions/+server.ts`
- Do NOT stamp assistant/guardian version anchors on platform CI runs — this couples independent units
- Do NOT create a `v{VERSION}` GitHub release for platform releases — this was the cause of the duplicate-key crash
- Do NOT drop `v{VERSION}` git tag creation yet — older installs still need it as a raw URL fallback until Tasks 2+3 are the field floor
