# Proposals: Simplify AKM Host Sharing, Skeleton Reseed, and UI/AppImage Delivery

> HISTORICAL: shipped in 0.12.0; kept as a design record. Current behavior is
> authoritative in [`core-principles.md`](./core-principles.md).

**Status:** APPROVED — implementing (D1 agreed, D5 agreed-for-now with forward-compat)
**Date:** 2026-06-03

**Decisions locked (2026-06-03):**
- **D1 = agreed.** Drop the symmetric personal-side write by default. Host sharing means
  *assistant reads host stash* only. "Also let my host AKM see OpenPalm's knowledge" is a
  later, explicit opt-in (not built now).
- **D5 = agreed for now, with a forward-compat constraint.** Electron prefers the bundled
  UI (fixes the stale-`data/ui` shadowing), BUT the resolver must remain forward-compatible
  with **updating the UI without shipping a new AppImage/dmg/zip**. Therefore implement a
  **version-aware** resolver: a `data/ui` build that is *newer than* the bundled build wins;
  otherwise the bundled build wins. This fixes shadowing today and is the exact hook future
  UI-only updates will use. Do NOT delete `seedUiBuild`/`checkAndUpdateUiBuild` — they are
  the future UI-update channel.
**Trigger:** Local testing of host-akm sharing surfaced three brittle/over-complex
mechanisms. This document gives the root cause of each and a concrete, simpler design.
Verified against the working tree + akm 0.8.0-rc.13.

---

## Cross-cutting insight

The three problems are entangled by one anti-pattern: **putting optional, env-dependent
runtime state into the bundled asset skeleton and gating it by file presence.** The
host-akm overlay (P1) is materialized into the skeleton, the skeleton is re-seeded every
Electron launch (P2), and the same "ship it in the bundle, resolve at runtime by
existence" thinking drives the UI/data-dir shadowing (P3). Fixing P1 with an
always-present mount removes the file that P2 kept resurrecting, but P2 and P3 are real
independent defects worth fixing on their own.

---

## P1 — AKM host sharing: replace the opt-in overlay with an always-present mount

### Root cause
The current design materializes `host-akm.compose.yml` into `OP_HOME/config/stack/` only
"when enabled", references `${OP_HOST_AKM_STASH}` with **no default**, and gates inclusion
on either file-presence (original, buggy) or `OP_HOST_AKM_STASH` being set (current patch,
`config-persistence.ts:158-195`). Three moving parts (overlay file + env var + config
source entry) must stay in lockstep, and the skeleton reseed (P2) keeps re-creating the
overlay file. Brittle by construction.

### Verified facts (from akm + repo)
- akm **silently skips** a configured source whose path is empty or missing —
  `resolveSourceEntries` → `isValidDirectory` (akm `search-source.ts:85,282`) and
  `walkStashFlat` returns `[]` for a missing root (akm `walker.ts:73`). So a mounted-but-
  unconfigured `/host-stash` (or an empty dir) costs nothing.
- A writable secondary never receives automatic writes — they resolve to the primary
  unless an explicit `--target` is given and `defaultWriteTarget` is unset
  (akm `write-source.ts`).
- `entrypoint.sh:43-50` already never chowns `/stash` or `/host-stash`; an always-present
  mount reintroduces no chown hazard.
- Today's detection is weak: `host-status/+server.ts:14` only checks `existsSync(~/akm)`.

### Proposed design
1. **Always mount `/host-stash`** in `core.compose.yml` (delete the overlay entirely):
   `- ${OP_HOST_AKM_STASH}:/host-stash`. `OP_HOST_AKM_STASH` is **always written to
   stack.env** by install/setup — to the real host stash when AKM is detected, otherwise
   to a guaranteed-present empty dir (`OP_HOME/data/akm/empty-host-stash`, created by
   `ensureHomeDirs`). Prefer an always-set env var over a compose nested default
   (`${A:-${B}}`) — nested defaults are fragile in Compose and the explicit write is clearer.
2. **Detection** = AKM is "available on host" when `~/.config/akm/config.json` exists
   (the real signal akm is initialized) — optionally also `~/akm`. Reported by
   `host-status` and a small `/admin/akm/host-sharing` GET.
3. **"Sharing" is now just one akm-config edit**: add/remove a writable secondary source
   named `host-akm` → `/host-stash` in `OP_HOME/config/akm/config.json`. No compose
   change, no env change, no overlay at enable/disable time.
4. **If AKM not available:** empty dir is mounted, no source entry added, the UI toggle is
   shown disabled ("Host AKM not detected").
5. **If AKM available:** auto-enable by default — add the `host-akm` writable secondary at
   setup; the UI toggle lets the user turn it off (removes the source entry).

### What this deletes / simplifies
- **Delete** `.openpalm/config/stack/host-akm.compose.yml`.
- **Delete** `isHostAkmSharingEnabled()` and the overlay branch in `discoverStackOverlays`
  (`config-persistence.ts:150-195`) → back to the plain 4-file list.
- **Gut** `host-akm-sharing.ts`: drop the env write + overlay materialize/remove; enable =
  `addHostStashToOpenpalmConfig`, disable = `removeHostAkmSources` (container side).
  `getHostAkmSharingStatus` becomes "is the `host-akm` source present in config?".
- **Simplify** the admin endpoint and the AkmTab panel accordingly.
- Net: 3 coordinated mechanisms → 1 (a source-list edit).

### Decisions needed
- **D1.** Keep the **symmetric** personal-side write (adding `OP_HOME/knowledge` as a
  source into the user's `~/.config/akm/config.json`)? That is the invasive, fail-closed
  part (mutating the user's home config). **Recommendation:** make it OFF by default —
  default to assistant-reads-host only; offer "also let my host AKM see OpenPalm's
  knowledge" as an explicit, separate opt-in. Removes the fail-closed personal-config
  writer from the default path.
- **D2.** Empty-dir location: `OP_HOME/data/akm/empty-host-stash` (recommended) — created
  by `ensureHomeDirs`, never written to.
- **D3.** Migration for installs that already set `OP_HOST_AKM_STASH`: harmless — the
  always-mount uses it as-is; the source entry already exists. No action required.

---

## P2 — Stop re-seeding the whole OP_HOME skeleton on every Electron launch

### Root cause
`packages/electron/src/main.ts:173-184` (`startUIServer`) **unconditionally** calls
`seedOpenPalmDir(v<version>, …)` on every launch. That runs
`copyTree(skeleton, OP_HOME, { skipExisting: true })` (`ui-assets.ts:110-143,45-63`) over
the entire bundled `.openpalm/` tree (`electron-builder.yml:21-23` ships `.openpalm` as
`openpalm-skeleton`). `skipExisting` preserves edits but **re-materializes any file the
user/process deleted** — which is exactly how the host-akm overlay kept coming back. The
comment claims the goal is "refresh the registry on every launch", but the implementation
re-copies everything, and the registry refresh functions (`materializeRegistryCatalog`,
`refreshRegistryCatalog`) are **not even called here** — the registry is just part of the
copied tree.

### Proposed design (pick one; A+C recommended)
- **A. Seed once, guarded by a version stamp.** Write `OP_HOME/.skeleton-version` after
  seeding; on launch, only re-seed if the bundled app version differs. Eliminates per-launch
  I/O and accidental re-materialization within a version; still refreshes on upgrade.
- **C. Separate "refresh registry" from "seed skeleton".** The only thing that legitimately
  needs to change between versions is the **registry catalog**
  (`data/registry/{addons,automations}`). Refresh *just that* (idempotent,
  version-guarded) and seed the rest **once on first install** only.
- (Reject D — "first-install marker only" — because it never picks up new registry entries
  on upgrade. A+C gets both.)

### Decisions needed
- **D4.** Is anything besides the registry catalog expected to change between versions via
  the skeleton (e.g. updated default `opencode.jsonc`, persona)? Those already have their
  own paths (`refreshCoreAssets` hash-compares core compose; `SEEDED_ASSETS` seed-once). If
  not, C cleanly scopes the per-launch refresh to the registry.
- Note: P1 removes the host-akm overlay from the skeleton, so the specific bug is gone
  regardless — but the per-launch full-tree copy is still wasteful and can clobber
  user-removed optional files, so P2 is still worth doing.

---

## P3 — UI delivery: stop `data/ui` from shadowing the AppImage's bundled UI

### Root cause
The built UI exists in **two** places and the resolver prefers the wrong one for the
Electron case:
- It is **bundled into the AppImage** at `resources/ui-build` (`electron-builder.yml:16-18`).
- It is **also** copied/downloaded into `OP_HOME/data/ui` (`seedUiBuild`, `ui:update`,
  `checkAndUpdateUiBuild` — `ui-assets.ts:223-273,337-387`).
- `resolveUiBuildDir()` (`ui-assets.ts:187-191`) returns `data/ui` **first** whenever
  `data/ui/index.js` exists.

Result: a freshly installed AppImage (new bundled UI) is **shadowed by a stale
`data/ui`** from a prior version — the operator runs old UI against new app/backend. Plus:
first-launch hard-depends on a network download (`main.ts:210-217`) with no fallback to
the bundled copy; no completeness/version validation of `data/ui`; UI version is fully
decoupled from app/backend version (skew possible). This is also why, during testing, I had
to manually re-copy the build into `data/ui` for the running app to pick it up.

### Proposed design
Separate the two delivery channels by consumer:
- **Electron (AppImage):** always run the **bundled** UI (`resources/ui-build`). It is
  version-locked to the app, self-contained, offline-safe. Drop `data/ui` shadowing and the
  first-launch network seed for the Electron path entirely.
- **CLI host install (`openpalm ui serve`, no Electron):** keep `data/ui`, seeded/updated
  from GitHub releases (`seedUiBuild`/`checkAndUpdateUiBuild`) — this is the channel that
  genuinely needs operator-updatable, networked delivery.

Concretely: make `resolveUiBuildDir()` prefer the **bundled** build when running inside
Electron (`OP_INSIDE_ELECTRON=1`, already set — `main.ts:99`), and prefer `data/ui` only
for the CLI path. Add a `version.json` completeness/version check on `data/ui` for the CLI
path (Option 4 from the investigation) so a partial/stale extract falls back to a known-good
copy instead of failing.

### Decisions needed
- **D5.** Confirm the desired split: AppImage = bundled-only (no per-user UI updates without
  updating the app), CLI = release-seeded `data/ui`. This is the recommended, simplest
  mental model and removes the shadowing/skew class of bugs for the app.
- **D6.** For the CLI path, do you want UI auto-update pinned to the **exact** app/backend
  version (no skew) rather than `releases/latest`? Recommended: pin to the installed
  version tag.

---

## Suggested sequencing

1. **P1** (always-mount AKM) — biggest complexity win; deletes a whole overlay + gating
   path and removes the file P2 was resurrecting. Self-contained.
2. **P3** (Electron runs bundled UI) — removes the shadowing/skew brittleness and the
   manual-redeploy dance; small, well-scoped change to `resolveUiBuildDir`.
3. **P2** (skeleton reseed once + version-guarded registry refresh) — efficiency +
   stop clobbering user-removed optional files.

Each is independent and separately testable. None requires the others, but doing P1 first
makes P2 lower-stakes.

---

## Open decisions summary

| # | Decision | Recommendation |
|---|---|---|
| D1 | Keep symmetric personal-side `~/.config/akm` write? | No — default assistant-reads-host only; personal-side is explicit opt-in |
| D2 | Empty-dir fallback location | `OP_HOME/data/akm/empty-host-stash` |
| D3 | Migration for existing OP_HOST_AKM_STASH | None needed |
| D4 | Does anything but the registry change between versions via skeleton? | If no → scope per-launch refresh to registry only (P2-C) |
| D5 | AppImage bundled-only vs data/ui for Electron | AppImage runs bundled UI; data/ui is CLI-only |
| D6 | CLI UI auto-update: pin to installed version vs latest | Pin to installed version (no skew) |
