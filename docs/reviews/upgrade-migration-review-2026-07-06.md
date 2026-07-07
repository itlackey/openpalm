# Upgrade / Migration Process Review — 2026-07-06

**Scope:** the complete upgrade and migration surface at `main@a946c464` (post-PR #554, pre-0.13.0): CLI update flow, lifecycle/rollback, migration system, self-update surfaces (UI build, skeleton, electron), Docker image transition semantics, and the user-facing update UX with its test/doc coverage.

**Method:** five parallel read-only review agents (one per slice), findings deduplicated and the critical claims independently re-verified against source by the orchestrator. Every `file:line` below was confirmed by reading the file at that revision.

**Headline verdict:** the upgrade path is **not ready to deliver 0.13.0 to existing installs**. The release's own updaters cannot actually move a 0.12.x install onto the 0.13.0 images (C1), and where images *do* move, the root→rootless transition repair is skipped on the primary (web UI) path (C2). Meanwhile the uncoordinated skeleton hot-swap can push the 0.13.0 compose onto 0.12.x stacks *without the user pressing update at all* (C3). Recovery from any failure mid-update is itself broken in several ways (C5, C6, M-class rollback gaps). A `0.13.0-beta.1` all-units prerelease remains safe to *publish* (no auto-update channel points at it), but the defects below gate the eventual stable promotion.

---

## Critical

### C1. The upgrade never changes images: pins don't advance and `--pull missing` never re-pulls
- `packages/lib/src/control-plane/docker.ts:969` — `pullMode = applyOpts.pull ?? "missing"`; `lifecycle.ts:296-300` — the upgrade phase calls `applyStack({kind:"all"}, composeOpts)` with no pull option; `lifecycle.ts:494-529` — `performUpgrade` never writes `OP_*_VERSION` (comment declares versions "user-managed"); `versions.ts:62-67` — defaults are the moving tag `latest`.
- A locally-cached `openpalm/assistant:latest` from 0.12.x is not "missing", so `up --pull missing --force-recreate` recreates containers **on the old image bytes under the new compose** (`user:` directive, `op_api_key` secret, `addon_net`). Old root+gosu entrypoints forced non-root → crash-loop, `--wait` fails, stack down. Exact-pin users are frozen the same way (`OP_GUARDIAN_VERSION=0.12.52` interpolates directly).
- The UI path is equally affected: `UpdatesTab.svelte:144-145` deliberately posts no target for latest-tracking components, so `POST /admin/update` also runs `--pull missing` against an unchanged tag. The only image-refresh path in the product is the manual per-container pull button (`admin/containers/pull/+server.ts:38`).
- Compounding: `packages/cli/src/commands/update.ts:9` claims "pull latest images" (false); `update.ts:34` prints `Image tag: openpalm/*:<PLATFORM_VERSION>` for images that were never pulled or referenced (`lifecycle.ts:517-519`); the planned legacy→state pin copy-out (`versions.ts:151` comment; INV2 test `iu-invariants.integration.test.ts:70-113` tests an inline reference lambda) **was never implemented**.

### C2. The web UI's "Update everything" — the non-technical user's path — skips the root→rootless ownership repair
- `lifecycle.ts:264-267` — `reconcileHostOwnership` (the only caller of `repairManagedNamedVolumes` in the lifecycle) is gated on `activating && composes`, true **only** for `kind:"upgrade"` (CLI `openpalm update`). `packages/ui/src/routes/admin/update/+server.ts:152-166` uses `applyUpdate` (`kind:"update"`) + its own `applyStack` — zero ownership reconcile in that request. `runDeploy` (deploy.ts:246-368) also never repairs.
- 0.12.x installs have root-owned `guardian-cache`/`portal-cache`/`assistant-artifacts` named-volume content (root-era entrypoints chowned at boot). New images run as uid 1000 and can never self-repair → EACCES, unhealthy, 502 — with the fix (`openpalm start --adopt-host` / `repair-ownership`) terminal-only.
- Aggravations: the repair marker can permanently skip a needed repair — drift detection samples bind-mount canaries only (`ownership-reconcile.ts:34-39,221-222`), so root files re-written into a named volume by a still-old image after the first repair are never re-detected. And the `OP_UID` backfill (`config-persistence.ts:81-91`) accepts a stale hardcoded `1000` (`operator-ids.ts:116-121`), so on non-1000 hosts repair chowns to the session uid while compose runs the container as 1000 — guaranteed EACCES that the marker then records as "repaired".
- A stale comment (`lifecycle.ts:218-221`) claims an "admin upgrade route" consumes `performUpgrade`; none exists.

### C3. The skeleton hot-swap is uncoordinated: it can break running 0.12.x installs the moment `@openpalm/skeleton@0.13.0` publishes
- `packages/cli/src/lib/ui-server.ts:47` and `packages/electron/src/main.ts:330` run `checkAndUpdateSkeleton` on **every** UI-server boot; it atomically replaces `OP_HOME/system/` with the channel-newest skeleton (`ui-assets.ts:679-688`), gated only by major version (0.12→0.13 passes).
- It does **not** run `ensureSecrets` (`op_api_key` is minted only inside `applyHome` — `secrets.ts:160`), does not pull images, does not reconcile ownership, and takes no install lock. The new `portals.compose.yml:197-198` declares `op_api_key: file: ${OP_HOME}/knowledge/secrets/op_api_key`; compose fails hard on a missing secret file.
- Failure sequence for any 0.12.52 install with a portal enabled: UI server restarts after skeleton publish → `system/` silently becomes 0.13.0 → user (or autostart) runs `openpalm start` / clicks container restart → `docker compose up` errors on the missing secret. The 0.12.52 CLI cannot mint the secret (its bundled `ensureSecrets` predates it), and its `applyHomeSeed` overwrites `system/` back to the *bundled* 0.12.x skeleton — the tree **flip-flops** between two owners at different versions.
- Longer-term: there is no "skeleton not newer than the running platform" clamp (`ui-assets.ts:727-754` blocks only major crossings, which can never fire at 0.x) — every future release that adds a compose-referenced secret/env recreates this window.

### C4. The skeleton an update applies is nondeterministic and can disagree with the platform version
- npm-installed CLI: `packages/cli/package.json:39` exact-pins `"@openpalm/skeleton": "0.12.18"` (stale; the workspace package is 0.12.52) and `scripts/bump-unit.mjs:161-171` never rewrites dependency ranges — a published 0.13.0 CLI would seed a **0.12.18** skeleton.
- Compiled-binary CLI: no `node_modules`, so `applyHomeSeed` → `fetchRemoteSkeleton` (`ui-assets.ts:146-162,697-703`), which ignores the requested ref beyond channel derivation and installs channel-newest — a 0.12.x binary can seed a 0.13.0 skeleton and vice versa. Both contradict `performUpgrade`'s "PLATFORM_VERSION is authoritative" invariant (`lifecycle.ts:500-506`).

### C5. A failed post-update UI health check on initial start never restores the backup — boot-brick loop on both harnesses
- `packages/electron/src/main.ts:391-407` — boot-time `waitForReady` failure shows an error dialog and `app.quit()`; `restoreUiBackup` is wired only into the supervisor **restart** path (`main.ts:574-581`). CLI: `packages/cli/src/lib/ui-server.ts:230-237` — `onStartFailure` exits 1; `restoreBackup` only on `onRestartFailure`.
- Since the auto-update runs at boot, a bad `@openpalm/ui` build produces: update → stamp vNew → health fail → quit → next boot reads vNew stamp → "up to date" → same broken build → quit. Infinite loop with a known-good backup sitting untouched in `data/backups/ui-<ts>`.

### C6. A failed UI-build download during update deletes the working UI
- `npm-bundle-updater.ts:209-219` — the live `data/ui` is `renameSync`'d into backups **before** the tarball download; `ui-assets.ts:595` sets `restoreOnFailure: false` for the UI (the skeleton flow correctly uses `true` at `:748`). `openpalm update` then ignores `uiResult.backupDir` and prints "Existing build still active." (`update.ts:49-50`) — it isn't.
- A transient registry timeout kills a working UI: CLI `ui serve` → "UI build not found" → exit 1; Electron silently de-routes to the older bundled build or quits.

### C7. Updates-tab per-row actions target compose services that don't exist
- `UpdatesTab.svelte:25-26` maps Portal → `service:'portal'` and Voice → `service:'voice'`; the stack's actual services are `discord`/`slack`/`guardian` (`portals.compose.yml:7,48,81`) and `voice`/`voice-cuda`/`voice-rocm`. Clicking Update (or the mislabeled Recheck, see M12) on the Portal row runs `compose up --no-deps portal` → raw "no such service" error; CUDA/ROCm voice users hit the same class. Component tests mock the API, so nothing catches it.

### C8. The admin "install UI version" route bypasses both the harness-contract gate and the backup mechanism
- `packages/ui/src/routes/admin/ui-version/+server.ts:29` calls `seedUiBuild(repoRef, dataDir, {forceRemote:true})` without the `harnessContract` argument (gate at `ui-assets.ts:483-494` therefore skipped) and `downloadNpmUiBundle` (`ui-assets.ts:425-431`) `rmSync`s the live build with **no backup**. On failure the supervisor "restores" a boot-era backup or nothing (`main.ts:362,574-581`) while the known-good pre-seed build was destroyed.

---

## Major

**M1. Crash-restore covers 4 files while `applyHome` rewrites all of `system/`** — `lifecycle.ts:400-427,452-473` restores stack.env, portals.compose.yml, custom.compose.yml, state env only; `overwriteSystemTree` rewrote core/services compose too. A failure after applyHome (e.g. Docker down — checked only afterward, `lifecycle.ts:111-118`) leaves a version-mixed compose set on disk.

**M2. Rollback doesn't remove files the failed op created** — `lifecycle.ts:453-471` and `rollback.ts:45-49,109-113` both skip when the "before" was absent; a created `state/stack.state.env` survives rollback and **wins** the env merge (`config-persistence.ts:46-54`).

**M3. `openpalm rollback` claims success without health verification and cannot restore image bytes** — `rollback.ts:75-82`: `up -d` (no `--wait`, no `--force-recreate`) then "Rollback complete."; with moving `latest` tags the old image may already be gone locally.

**M4. No non-terminal recovery for a failed update** — `restoreSnapshot`/`hasSnapshot` have no UI route; the CLI hint "run `openpalm rollback`" prints even when no snapshot exists; `HostSwapBlockedError` tells the user to re-run with `--adopt-host`, a flag `openpalm update` doesn't have (`ownership-reconcile.ts:156-158`).

**M5. The install lock provides no mutual exclusion inside the UI server process** — PID-reentrancy (`install-lock.ts:137-142`) grants a no-op handle to any same-process acquire; UI routes serialize per-route-key only, so update / setup-rerun / pull / uninstall can drive compose concurrently. Self-update surfaces (`checkAndUpdateUiBuild`/`Skeleton`/`seedUiBuild`) take **no** lock at all and share fixed staging paths (`npm-bundle-updater.ts:115-117`) that concurrent updaters `rmSync` out from under each other; `killStaleUIServer` (`main.ts:263-280`) SIGTERMs whichever healthy server owns the pid file.

**M6. Deleted migrations that are still needed on skip-version upgrades** — the migration framework (1,493 lines incl. `RELEASE_MIGRATIONS`) was deleted in the four-tree rebuild. Not replaced: (a) the C4 addon-config copy (`knowledge/secrets/<KEY>` → stack.env) — a 0.11.x→0.13.0 upgrade silently loses Discord/Slack **allowlists**, i.e. `${DISCORD_ALLOWED_GUILDS:-}` resolves empty and the portal becomes unrestricted — a security regression; (b) the `OP_IMAGE_TAG`→`OP_*_VERSION` mapping — pre-0.12.19 homes silently jump to `:latest`. Lifecycle doc-comments still describe the deleted system (`lifecycle.ts:230,351-358,479-492`).

**M7. `channel_lan` end-state is contradictory and its safety net is gone** — `core.compose.yml:133-137` says "REMOVED in 0.13.0" directly above a still-shipping definition; the promised custom-overlay scan/rewrite (`CHANGELOG.md:325-330`) was deleted with migrations.ts. Whichever release actually deletes it will hard-fail `docker compose config` for overlay users with zero warning.

**M8. Channel model vs. published dist-tags (full blast radius)** — `distTagForVersion` knows only `latest|next` (`versioning.ts:132-134`) while publishes go to `rc`/`beta`/`next`. `seedUiBuild`'s remote path fetches the **literal** tag (`ui-assets.ts:481`) — prerelease fresh installs seed an ancient `@next` UI or 404 (`resolveChannelRef` was applied to the update path but not the seed path); `resolveChannelRef`'s `next` = max over **all** dist-tags including accidental ones (`ui-assets.ts:390-398`); `OP_UI_CHANNEL=beta|rc` is silently ignored (`ui-assets.ts:337-340`); the channel derives from the frozen ASAR/binary `PLATFORM_VERSION`, never from the self-updated control plane; there is no `:next` Docker tag behind the image-channel vocabulary.

**M9. Harness-contract gate is one-directional and download-time-only** — no check at resolve/spawn time for a too-new build already on disk; no "harness requires minimum UI" direction at all (`harness-contract.ts` defines only `minHarnessContract`); C8 bypasses the one gate that exists.

**M10. The "re-download the app" signal never reaches the user** — `main.ts:350-355` logs `redownloadRequired` to main.log only; nothing in renderer/tray/banner surfaces it (zero hits in `packages/ui/src`), so a harness-contract bump silently freezes a user's platform forever. Contradicts `docs/managing-openpalm.md:280`.

**M11. Electron update check runs once per boot and the app never quits** — check only at `startUIServer` (`main.ts:320`) and the prerelease toggle; result frozen into child env at spawn; tray-resident apps go months without a check. The prerelease branch also drops the installer-asset requirement (`update-check.ts:80-99` vs `:184-185`), resurfacing the asset-less-release bug fixed for stable.

**M12. "Recheck" force-recreates a healthy container** — `UpdatesTab.svelte:437,444-448`: the no-update-available button labeled "Recheck" calls `updateService(...)` → `--force-recreate`. Checking for updates restarts the assistant mid-conversation.

**M13. UI downgrade/pin is clobbered and downgrades are offered as "Update"** — under CLI serve, every respawn re-runs `checkAndUpdateUiBuild` (`ui-server.ts:40-64`), immediately replacing an explicitly seeded older build; there is no UI-build pin. `hasUpdate` is a bare `!==` (`UpdatesTab.svelte:120-124`) so a prerelease user sees "Update" that silently downgrades; `DowngradeConfirmationRequired` (`lifecycle.ts:360-375`) is exported but thrown nowhere — the documented #501 gate does not exist.

**M14. `runDeploy` downs the stack before up** — `deploy.ts:311` best-effort `composeDown` precedes the single `up`; a pull/boot failure on a setup re-run leaves everything stopped with only `deployError` recorded (`deploy.ts:331-356`).

**M15. Voice-tag defects can fail entire upgrades** — setup rerun writes ALL FOUR pins to the wizard's one `imageTag` (`setup.ts:359-367`), pinning voice (separate release cadence) to a tag that generally doesn't exist; a legacy stored suffixed value renders `voice:0.12.0-cpu-cpu` (compose interpolates raw — `services.compose.yml:101` — while only the reader strips, `versions.ts:192-194`); `voice-rocm` references `-rocm6` which `publish-voice.yml` never builds. Any of these fails the single `up --wait` and therefore the whole deploy/upgrade.

**M16. Guardian named volume shadows the baked package — upgrades require npm at boot** — `portals.compose.yml:142` mounts `guardian-cache:/opt/openpalm` over the new image's baked tree (`containers/guardian/Dockerfile:49-54`); every **upgrading** install (volume exists) must `bun add` the new guardian at boot, 3 attempts then exit 1 (`entrypoint.sh:59-67,80`) — offline upgrade fails, defeating the S.4 no-network-boot design. Related: seed-once `data/guardian/tools/package.json` means release-time tool pins never reach existing installs.

**M17. `applyHomeSeed` never writes the skeleton stamp** — only `checkAndUpdateSkeleton.afterInstall` stamps (`ui-assets.ts:743-745` vs `:137-178`); `install.ts:256-259`'s comment claims otherwise. Every fresh install boots unstamped → forced re-download/possible downgrade of `system/` (`npm-bundle-updater.ts:207-209`); post-hot-swap lifecycle reseeds silently revert `system/` while the stamp says newer (stale tree persists until the next publish).

**M18. UI update route records the new version even when the recreate fails** — `advanceTargetVersions` writes before `applyStack` and nothing reverts on failure (`admin/update/+server.ts:113-117,158-166`); subsequent version reporting and `--pull missing` decisions build on the lie.

**M19. Backup management is unsound** — retention sorts all of `data/backups/` lexicographically across three naming families (`backup.ts:146-154`: `ui-<epoch>` > `skeleton-<epoch>` > ISO snapshots), so `pruneBackupDirs(home,3)` deletes every OP_HOME snapshot while `ui-*` grow unbounded; the prune can delete the very dir Electron holds as `pendingUiBackupDir` (restore then no-ops, `ui-supervisor.ts:120-122`); `.ui-failed-<ts>` dirs are never cleaned; `pendingUiBackupDir` is never cleared on healthy boot (`main.ts:361-362` comment lies), so a much-later restart failure "restores" an arbitrarily old build.

**M20. Splash directs non-Electron users into a redirect loop** — admin is Electron-gated (`features.ts:12-16`; `OP_ENABLE_ADMIN` set nowhere in the product) and `/admin` redirects to `/chat` (`hooks.server.ts:170-172`), yet splash's broken/offline states render "Open dashboard"/"Open diagnostics" buttons linking to `/admin` (`splash/+page.svelte:76,79`) — a dead end exactly when the stack is down. There is also no "stack behind home" indicator anywhere after a silent hot-swap (no signal in `deriveLocalStackState`/`/admin/versions`).

**M21. Zero automated coverage of the one scenario every real user will hit** — nothing creates an older install (root-owned volumes, legacy env/pins) and drives the current upgrade across it. `scripts/upgrade-test.sh` is manual-only and structurally broken against the current layout (retired `OP_IMAGE_TAG` cascade, v-prefixed versions, composes core-only so guardian never starts — lines 11-24,143-149,233-234,473-481); iu-harness compose tests hard-skip in CI (`iu-harness.ts:20-21`); no Playwright touches `/admin/update`, `/admin/versions`, or the Updates tab; `update.test.ts` asserts argument threading against a fully mocked lib.

---

## Minor / quality

- **m1.** `openpalm update --pre` is documented but a no-op end to end (`update.ts:12-16`; `lifecycle.ts:485-492`).
- **m2.** `openpalm update` silently starts a deliberately stopped stack (`lifecycle.ts:236,296-300` vs the update-kind comment at `:325-330`).
- **m3.** Non-atomic writes in the danger path: crash-restore `writeFileSync` (`lifecycle.ts:455-471`); `overwriteSystemTree` per-file plain writes (`core-assets.ts:155`) despite `fs-atomic.ts` existing; skeleton swap `rmSync`→`renameSync` window leaves OP_HOME with no `system/` at all (`ui-assets.ts:683-686`); `removeEnvKeyFromFile` plain rewrite (`addons.ts:299-306`).
- **m4.** `applyHomeSeed` copies skeleton package root files (`package.json`, `README.md`, `manifest.json`, `openpalm.sh`, `openpalm.ps1`) into OP_HOME root (`ui-assets.ts:172`).
- **m5.** State/legacy env read inconsistently: `resolveImageNamespace` (`lifecycle.ts:377-386`) and `resolveImageTag` (`deploy.ts:116-123`) read legacy only, unlike the merged view used elsewhere; `writeSystemEnv` re-asserts `OP_SETUP_COMPLETE=false` into the legacy file forever (`config-persistence.ts:73-79`).
- **m6.** `openpalm start` runs ownership repair before taking the install lock (`start.ts:52-57`).
- **m7.** Pre-0.12.52 managed compose copies remain in user-owned `config/stack/` with no breadcrumb; edits there silently do nothing.
- **m8.** Dead/misleading surfaces: phantom `openpalm migrate` + "Preview changes" in docs; `/admin/migrate-apply` in `api-spec.md:150-152` doesn't exist; `GET /admin/versions/latest|ui|releases` have zero consumers and duplicate tag-resolution with a hardcoded namespace; `OP_AUTO_UPDATE` is accepted and stored but consumed by nothing; `reconcileCore`'s un-armed snapshot branch and `UpgradeResult.warnings` are dead; `install.ts:247` references the removed `runStartupApply`.
- **m9.** Doc drift beyond the above (all in `docs/managing-openpalm.md` unless noted): §285-290 status advisory + banner copy don't exist; §297-307 migrate/preview flow removed; §338 `run.sh` never existed in code; §366-369 backups live in Recovery, not Updates; §276 button copy wrong; root `CLAUDE.md` still documents the deleted `.openpalm/` tree instead of `packages/skeleton/`; `main.ts:585-587` references the removed splash-apply flow.
- **m10.** Cosmetics/consistency: v-prefix remnants in `UpdateBanner.svelte:51-52` and the window title; terminal instructions ("run 'openpalm unlock'") and jargon ("Control plane", "Pin … latest (tracking)") surfaced verbatim to the no-terminal audience; `parseComposePsServices` copy-pasted three times (hooks.server.ts:122, splash/+page.server.ts:5, cli status.ts:5) violating the lib-SSOT rule; `bare()` re-implements `normalizeVersion`; `verifyNpmIntegrity` reports skeleton corruption as "UI bundle integrity mismatch" (`npm-bundle-updater.ts:68`); `fetchWithRetry` errors hide the HTTP status (`:49-50`); `getCachedUpdateInfo` mixes stable/prerelease cache slots for up to 6h (`update-check.ts:202-207`); `/api/electron/update-status` lacks `requireAdmin`; `main.ts:329` re-resolves a home dir already in scope.

---

## Verified sound (calibration)

- `applyStack`'s `up -d --wait` is a real health gate (`docker.ts:975,1045-1046`) — "updated" on the lifecycle paths is health-verified.
- `op_api_key` **is** seeded before compose on all lifecycle paths (`ensureSecrets` first inside `applyHome`, `lifecycle.ts:159`; `secrets.ts:160`) — the gap is exclusively the hot-swap/plain-start window (C3).
- `repairNamedVolumeOwnership`'s mechanism is correct (docker-run chown; benign-skip only on "no such volume"; failures block the marker) and covers the full 0.13.0 named-volume set — the defects are about **when it runs** (C2), not how.
- SSH-addon removal is fully and idempotently migrated (`pruneRemovedAddonState`, `addons.ts:296-350`); `OP_ENABLED_ADDONS`/`OP_SETUP_COMPLETE` reads merge state-over-legacy correctly where it matters.
- The past "restartUIServer didn't reload mainWindow" bug is genuinely fixed (`main.ts:588-593`); `/admin/update`'s lock/ordering behavior is well unit-tested at the route level.

## Recommended gating set for 0.13.0 stable

The minimum to make the upgrade *deliverable and survivable*, in dependency order:

1. **Make the upgrade move images** (C1): advance applied `OP_*_VERSION` to the release's image versions during update/upgrade (both CLI and UI paths) *or* run the upgrade `applyStack` with `pull:"always"` for latest-trackers — plus implement the legacy→state pin copy-out that INV2 pretends exists.
2. **Run `reconcileHostOwnership` on the UI update path** (C2) and re-trigger volume repair when images transition (fix the marker/canary blind spot and the stale-`OP_UID` acceptance).
3. **Coordinate the skeleton hot-swap** (C3/C4): seed required secrets before swapping (or gate the swap on lib-version ≥ skeleton-version), clamp hot-swap to the running platform version, fix the CLI's stale exact `@openpalm/skeleton` dep, and stamp from `applyHomeSeed`.
4. **Fix failure recovery** (C5/C6/M1-M4): restore the UI backup on initial-start failure; `restoreOnFailure:true` for the UI download (backup-after-download, or restore on install-phase errors); extend crash-restore to the whole `system/` tree; make rollback health-checked.
5. **Fix the Updates tab** (C7, M12, M18): real service names, Recheck ≠ recreate, don't record versions that never came up.
6. **Add the missing older-install upgrade test** (M21): seed a 0.12.x-shaped OP_HOME (root-owned volume content, legacy pins/env), run the real update path, assert healthy containers on the new images — this single test would have caught C1, C2, C3, M15, and M16.

Items M6 (lost migrations — the Discord-allowlist regression deserves attention as a security item), M8 (channel model), and M10 (invisible re-download signal) should follow close behind; the rest can ride normal cleanup.
