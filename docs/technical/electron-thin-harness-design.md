# Electron Thin-Harness Design

> Tracking issue: [#495](https://github.com/itlackey/openpalm/issues/495)
> Status: design (no code changed by this document)
> **Audit note (orchestrator, 2026-06-15):** Produced by a 5-agent analysis, then independently verified.
> The load-bearing root-cause evidence was re-confirmed against compiled output: `packages/electron/dist/main.js`
> has **0** migration references; `packages/ui/build/server/chunks/*` contain them; `vite.config.ts:59` inlines
> `@openpalm/lib` into the prod UI build; and `cli/src/lib/ui-server.ts` indeed never calls
> `checkAndUpdateUiBuild` (§6.3). One correction applied (Risk #6): upgrades **already** refresh compose/stack
> assets remotely by version via `refreshCoreAssets` — see the inline correction there.
> Companion review: [`deployment-upgrade-ux-review.md`](./deployment-upgrade-ux-review.md) — read that for the
> upgrade/migration UX findings (P0 host-vs-target guard #492, desktop Docker gap, channel semantics). This
> document does not duplicate those findings; it references them where the harness interacts.
> Authority: [`core-principles.md`](./core-principles.md) governs (never overwrite/delete user files;
> migrations are copy-only; control-plane logic lives only in `@openpalm/lib`).

---

## 1. Goal & non-goals

### Goal (owner)

The Electron desktop app is a **thin native harness**. Re-downloading the app is required **only when the
native harness itself changes** — `BrowserWindow` / `Tray` / IPC channels / preload bridge / native modules /
entitlements / PATH shims. **Everything else self-updates in place with no app re-download:**

- the Docker **stack images** (via `compose pull`, already true),
- the **admin UI** build (`@openpalm/ui`),
- the **control plane** `@openpalm/lib` — *including* `RELEASE_MIGRATIONS` and the lifecycle deploy path,
- the **CLI**'s view of the control plane.

### Non-goals

- Replacing the native binary's job: window/tray/IPC/preload/permissions/PATH/spawn genuinely require the
  native shell and legitimately gate a re-download.
- Hot-swapping `@openpalm/lib` inside the **compiled CLI binary** (it is a `bun build --compile` single file;
  its lib copy can only change by replacing the binary — see §6.7).
- Changing the migration model: migrations stay **copy-only, non-destructive, backup-first** per
  `core-principles.md`. This document changes *where the migration code loads from*, never *what it does*.
- Cross-major auto-update without coordination (today gated by `isSameMajorVersion`, `ui-assets.ts:484`).

---

## 2. Current architecture

Three execution contexts exist at runtime. Knowing which `@openpalm/lib` each one loads is the whole story.

### 2.1 Electron main process (the native harness — frozen in the asar)

`packages/electron/src/main.ts` is bundled into `dist/main.js` by `bun build src/main.ts --bundle --target=node`
(`packages/electron/package.json:12`), then shipped inside the asar (`electron-builder.yml`). The bundle
**statically inlines** the subset of `@openpalm/lib` it imports. That import set is exactly ten symbols
(`main.ts:12-23`):

```
resolveOpenPalmHome, resolveDataDir, resolveConfigDir, resolveUiBuildDir,   // read-only path resolvers
seedUiBuild, seedOpenPalmDir, checkAndUpdateUiBuild,                         // asset seeding / download
ensureHomeDirs,                                                             // mkdir-only
uiUpdateChannel,                                                           // pure channel selector
parseEnvFile                                                              // read-only
```

**None of these mutate state or run migrations.** `main.ts` never imports `ensureMigrated`,
`ensureReleaseMigrated`, `performUpgrade`, `applyTagChange`, or `RELEASE_MIGRATIONS` (verified: 0 occurrences
in `dist/main.js`). The harness's only writes at boot are:

- `seedOpenPalmDir(...)` (`main.ts:354`) — non-destructive: user files copied skip-if-exists; only
  system-managed stack/compose skeleton is refreshed (`ui-assets.ts:126-194`, `copyTree(..., {skipExisting:true})`
  at `:157/:189`); version-stamp gated (`:132-138`).
- `checkAndUpdateUiBuild(version, dataDir)` (`main.ts:373`) — downloads a newer `@openpalm/ui` npm tarball into
  `data/ui` (integrity-verified, fail-closed) **before** the UI is spawned.

The rest of `main.ts` is genuinely native: `BrowserWindow` main+splash (`:503,:566`), `Tray`+`Menu`
(`:760-816`), `session` permission handlers (`:638-656`), `systemPreferences` mic TCC (`:673-699`),
`globalShortcut` (`:707-715`), `Notification` (`:728-732,:879-887`), app lifecycle / single-instance /
before-quit (`:820-945`), `setLoginItemSettings` (`:749-756`), `dialog.showErrorBox` (`:447,:479`), the IPC
handlers (`:866-898`), and the preload `contextBridge` (`preload.ts:22-81`), plus PATH augmentation for
Finder-launched apps (`preload.ts:43-58`).

### 2.2 The spawned UI server (the updatable control plane)

The harness **spawns the UI as a separate Node child** using Electron's own bundled Node
(`process.execPath` + `ELECTRON_RUN_AS_NODE=1`) on `join(uiBuildDir, 'index.js')`, where
`uiBuildDir = resolveUiBuildDir()` (`main.ts:380-415`). The CLI does the structurally identical thing
(`packages/cli/src/lib/ui-server.ts:15` `const UI_BUILD_DIR = resolveUiBuildDir()`, spawned later).

`resolveUiBuildDir()` (`ui-assets.ts:269-287`) prefers `OP_HOME/data/ui` over the bundled build **only when
`data/ui` is strictly newer** by version stamp; otherwise it falls back to the bundled (frozen) build. So the
running control plane is the npm-downloaded `data/ui` whenever one has been seeded and stamped.

The UI production build **inlines its own full copy of `@openpalm/lib`** — `vite.config.ts:59`
`ssr.noExternal: mode === 'production' ? true`. The published `@openpalm/ui` tarball therefore has **zero
runtime dependencies** and carries its own `RELEASE_MIGRATIONS` + lifecycle. Verified: the migration symbols
are present in `packages/ui/build/server/chunks/*` and absent from `packages/electron/dist/main.js`.

**The mutating control-plane ops run only here**, in the spawned UI process, via admin routes:

- `ensureMigrated` (`packages/ui/src/routes/admin/upgrade/+server.ts:15,32`),
- `performUpgrade` (`upgrade/+server.ts:9,59`),
- `applyTagChange` (`packages/ui/src/routes/admin/stack-version/+server.ts:8,35`).

Each ultimately calls `ensureReleaseMigrated` inside `lifecycle.ts` (`:524`, `:590`).

### 2.3 The CLI binary

`packages/cli` is a `bun build --compile` single-file executable that **statically inlines its own
`@openpalm/lib`**. It self-updates by downloading a platform binary from the GitHub release and sha256-swapping
it (`packages/cli/src/commands/self-update.ts`). The CLI's deploy commands (`update.ts`, `install.ts`,
`migrate.ts`) call `ensureMigrated`/`performUpgrade` from *its own* compiled lib — but when it *serves the UI*,
it spawns `data/ui`'s `index.js` (`ui-server.ts`), so the **served UI** runs the updatable lib, even though the
CLI's *own* commands run the compiled-in lib.

### 2.4 Where migration code loads from at upgrade time (the root-cause locus)

| Upgrade entry point | Process | Which `@openpalm/lib` runs `RELEASE_MIGRATIONS` |
|---|---|---|
| UI **Upgrade** / **Stack version** buttons | spawned UI child | `data/ui` (npm, **updatable**) when stamped-newer; else bundled |
| Electron boot seeding | main process | frozen asar copy — **but it runs no migrations**, only seed/path |
| `openpalm update` / `migrate` (CLI command) | CLI binary | CLI's **compiled-in** copy (replaced only by `self-update`) |
| `openpalm ui serve` → UI admin button | spawned UI child | `data/ui` (npm, **updatable**) |

The migration code the desktop user actually hits when they click "upgrade" comes from the **npm-downloaded
`data/ui` bundle**, not the asar. That mechanism already exists and is wired into the Electron launch path
(`checkAndUpdateUiBuild` at `main.ts:373`, before `resolveUiBuildDir` at `:380`).

---

## 3. Root-cause verdict

**The migration / control-plane code that runs at upgrade time ALREADY lives in the updatable `data/ui`
build, not in the fixed Electron bundle.** This is the option-(a) finding, and it is confirmed in the compiled
output: `packages/electron/dist/main.js` contains **0** references to `ensureReleaseMigrated` /
`RELEASE_MIGRATIONS` / `performUpgrade`; `packages/ui/build/server/chunks/*` contains them.

So the owner's premise — *"a release boundary forces an app re-download because migration/control-plane code is
compiled into the host's bundled `@openpalm/lib`"* — is **false for the mutating path.** The harness's frozen
lib copy is **bootstrap-only** (path resolution + skeleton seeding + UI-build download). It never runs a
migration.

**Therefore the fix is mostly wiring, lifecycle, and policy — not a code-move:**

1. **Wiring:** guarantee the downloaded `data/ui` always wins steady-state (correct, mandatory version stamp;
   never silently fall back to the frozen bundled lib).
2. **Restart:** the running UI server holds the *old* lib in memory until the Node child is respawned — a
   downloaded build does nothing until restart. There is no "restart UI server" action today.
3. **Channel:** stable apps cannot pull a `next` UI (`uiUpdateChannel`, `ui-assets.ts:323-325`), and the
   same-major guard (`:484`) blocks cross-major auto-update. Prerelease control-plane flow needs an explicit
   channel decision.
4. **Guard interaction (#492):** the host-vs-target guard must key on the **running UI build's lib version**
   (the thing that actually runs migrations), not on the frozen harness version — see §6.5.

The **one place control-plane code is genuinely frozen** is the Electron `extraResources` *bundled UI build*
(`resolveLocalUiBuild`, `ui-assets.ts:208-213`), used only as a cold-start fallback when `data/ui` is absent or
not-newer. Keeping that a fallback-only path (always seed/update `data/ui` first) closes the gap.

The CLI is the exception: its *own* compiled lib runs `migrate`/`update`, and that copy can only change via
`self-update` (§6.7). That is an accepted, documented limit, not a regression.

---

## 4. Target architecture

```
┌──────────────────────────── Electron app (re-download ONLY on harness change) ────────────────────────────┐
│  THIN HARNESS  (dist/main.js, frozen in asar)                                                              │
│   • Native: BrowserWindow/Tray/Menu/IPC/preload/session+systemPreferences/globalShortcut/Notification     │
│   • Bootstrap-only lib (allowlist): resolve* paths · ensureHomeDirs · seedOpenPalmDir ·                    │
│     checkAndUpdateUiBuild · seedUiBuild · uiUpdateChannel · parseEnvFile                                   │
│   • Declares HARNESS_CONTRACT_VERSION; emits it to the UI (env + IPC)                                      │
│                                                                                                            │
│   boot:  ensureHomeDirs → seedOpenPalmDir(skip-if-exists) → checkAndUpdateUiBuild(channel) ──┐             │
│                                                                                              ▼             │
│                                       spawn(process.execPath, [data/ui/index.js],  ELECTRON_RUN_AS_NODE)   │
└──────────────────────────────────────────────────────────────────────────────│───────────────────────────┘
                                                                                 ▼
                       ┌─────────────── UPDATABLE CONTROL PLANE (data/ui, npm @openpalm/ui) ───────────────┐
                       │  SvelteKit adapter-node server + admin API                                        │
                       │  Inlines its OWN @openpalm/lib  ⇒  RELEASE_MIGRATIONS + lifecycle TRAVEL with it   │
                       │  Admin routes run: ensureMigrated · performUpgrade · applyTagChange               │
                       │  Drives Docker:  compose pull (stack images self-update) · compose up             │
                       └───────────────────────────────────────────────────────────────────────────────────┘
```

### Update flow (diagram-in-prose)

1. **Harness boot.** The native shell creates dirs, non-destructively seeds the skeleton, then calls
   `checkAndUpdateUiBuild(channel, dataDir)` which fetches the newest `@openpalm/ui` on the chosen dist-tag,
   verifies sha512 fail-closed, atomically swaps it into `data/ui`, and backs up the prior build.
2. **Harness spawns the control plane.** `resolveUiBuildDir()` selects the strictly-newer `data/ui`; the
   harness spawns its `index.js`. The control plane now running is the freshly downloaded lib.
3. **Control plane self-updates the rest.** From the admin UI (or CLI), the user upgrades the stack:
   `performUpgrade`/`applyTagChange` run `ensureReleaseMigrated` (copy-only, backup-first) **inside this
   updatable process**, then `compose pull` updates stack images. No app re-download.
4. **In-session UI update.** The admin "install UI version" action seeds a newer `data/ui`, then **signals the
   supervisor (harness/CLI) to kill + respawn** the UI child so the new lib loads without a full relaunch (§6.2).
5. **Harness change (rare).** Only a change to the native surface (window/tray/IPC/preload/native
   modules/entitlements/PATH) bumps `HARNESS_CONTRACT_VERSION`; the app's GitHub-release update check then
   surfaces "a new app version is required" and the user re-downloads.

The harness's frozen lib is reached **only** at step 1 (bootstrap). Every state-mutating operation runs in the
updatable control plane (steps 3–4).

---

## 5. The harness contract + independent versioning

### 5.1 The contract surface (the *only* thing whose change forces a re-download)

The harness ↔ control-plane boundary is small and slow-changing. It has three parts:

**(a) Renderer IPC bridge** (`preload.ts:22-81`, handlers `main.ts:866-898`):
- sync `updateStatus()` (reads `OP_ELECTRON_*`); `notify(title, body)` (`ipcRenderer.send 'notify'`);
- invoke: `restart()`, `launchOnLoginStatus()`, `setLaunchOnLogin(bool)`, `setTrayMicRecording(bool)`,
  `requestMicPermission()`;
- push: `global-mic-toggle` (subscribed via `onGlobalMicToggle(cb)`).

**(b) Spawn env contract** (`buildUIServerEnv`, `main.ts:174-229`): `OP_HOME`, `HOST`, `PORT`, `ORIGIN`,
`OP_INSIDE_ELECTRON=1`, `OP_ELECTRON_VERSION`, `OP_OPENCODE_URL`, optional `OPENPALM_SKELETON_DIR`, optional
`OP_ELECTRON_LATEST_VERSION`/`OP_ELECTRON_LATEST_URL`, a merge of `stack.env` minus the skipped tag keys
(`:188-194`), and `ELECTRON_RUN_AS_NODE=1`.

**(c) Filesystem/path contract:** `OP_HOME` layout, `data/ui`, the skeleton location, and the
`process.execPath`-as-Node spawn convention.

A change to a **name, argument shape, return shape, or required env key** in (a)/(b)/(c) — and **only** such a
change — is a true harness change.

### 5.2 Two independent version lines

| Line | Source | Bumped when | Forces re-download? |
|---|---|---|---|
| `HARNESS_CONTRACT_VERSION` | a single integer constant in `packages/electron` (e.g. `harness-contract.ts`, starts at `1`) | the §5.1 contract surface changes | **Yes** |
| `PLATFORM_VERSION` | `@openpalm/lib` (replacing the implicit `v${libPkg.version}` at `lifecycle.ts:251`); travels with the `data/ui` bundle | every control-plane / migration / UI release | **No** — self-updates |

Today both collapse onto `app.getVersion()`, which is why every platform release *looks* like it needs a new
app. The harness must stop feeding `app.getVersion()` into control-plane inputs (`main.ts:354` seed stamp,
`:373/:387` UI channel) and instead use the skeleton's own stamp / a declared platform channel.

### 5.3 Decision: "re-download" vs "self-update in place"

On boot and on the periodic GitHub poll, the harness compares:

- **Self-update path** (no re-download): a newer `@openpalm/ui` exists on the channel **and** its declared
  `minHarnessContract ≤ HARNESS_CONTRACT_VERSION` of the running app. `checkAndUpdateUiBuild` pulls it; the
  control plane (lib + migrations + stack pull) updates in place.
- **Re-download path** (app archive): the newest release's `minHarnessContract > HARNESS_CONTRACT_VERSION`
  (the new control plane needs an IPC/env/path the running harness does not provide). The harness shows "a new
  OpenPalm app is required" and the existing GitHub update-check (`update-check.ts`, notify-only today) links
  the download. **No silent failure** — without this gate a newer-UI-on-older-harness fails at runtime
  (undefined IPC method → `TypeError`; missing env → 503, the documented Voice case).

The UI side feature-detects: every IPC method / env read introduced after contract version *N* is guarded by
`harnessContractVersion >= N`, falling back to the HTTP path the UI already prefers
(`/api/electron/update-status`, `preload.ts:2-3`).

---

## 6. Concrete change plan (ordered, file-level)

> Effort: **S** ≈ <½ day, **M** ≈ 1–2 days, **L** ≈ multi-day. Items 6.1–6.3 are the minimum to achieve the
> owner goal for the Electron path; 6.4–6.7 harden and extend it (CLI, prerelease, guard).

### 6.1 Make `data/ui` the steady-state executor; never silently fall back to frozen lib — **M**

- `packages/lib/src/control-plane/ui-assets.ts` (`resolveUiBuildDir` `:269-287`, `readUiBuildVersion`,
  `seedUiBuild` `:431-433`): **promote the missing-stamp warning to a hard failure** for the published tarball
  in CI, and add a runtime log when `data/ui` is ignored due to a missing/unparseable stamp (so a de-routed
  install is visible, not silent). An unstamped `data/ui` currently de-routes execution back to the frozen
  bundled lib (`:281` requires both stamps).
- **CI guard test (new, lib or a `scripts/` check):** assert `packages/electron/dist/main.js` contains **0**
  occurrences of `ensureReleaseMigrated`/`RELEASE_MIGRATIONS`/`performUpgrade`/`applyTagChange`, and
  `packages/ui/build/server/chunks/*` contains them. Pins the boundary mechanically against regression. **S**
- **Lint/test (new):** assert `packages/electron/src/main.ts` imports from `@openpalm/lib` only the ten-symbol
  bootstrap allowlist; fail CI if any mutating control-plane symbol is added. **S**

### 6.2 Auto-restart the UI server after a UI-build update so the new lib loads — **M**

The downloaded build does nothing until the Node child is respawned.

- `packages/ui/src/routes/admin/ui-version/+server.ts` (`:28`, currently just `seedUiBuild` + `ok`): after a
  successful seed, signal the supervisor to restart. The cleanest signal is the **existing IPC `restart()`**
  for Electron, and a CLI-side supervisor restart for `openpalm ui serve`.
- `packages/electron/src/main.ts`: add a "restart UI server" path that kills the current `uiProcess`
  (group-kill, it already runs detached) and re-runs the `resolveUiBuildDir()` → `spawn` block (`:380-415`).
  Today `uiBuildDir` is resolved once before spawn; factor the resolve+spawn into a re-callable
  `startUIServer()` so a restart re-reads `data/ui`.
- `packages/cli/src/lib/ui-server.ts`: `UI_BUILD_DIR` is frozen at import (`:15`). Move resolution **inside**
  the spawn function and expose a restart that re-resolves + respawns. **M**

### 6.3 Always seed/update `data/ui` before spawn on every supervisor — **S**

- Electron already calls `checkAndUpdateUiBuild` before `resolveUiBuildDir` (`main.ts:373/:380`) — keep it,
  and ensure first launch seeds when absent (already at `:382-394`).
- `packages/cli/src/lib/ui-server.ts` does **not** call `checkAndUpdateUiBuild` before spawning (only
  `update.ts:55` does, and only on the `update` command). Add a `checkAndUpdateUiBuild(currentVersion,
  dataDir)` call to the CLI's pre-spawn step so `openpalm ui serve` self-updates the control plane too,
  matching Electron. **S**

### 6.4 Prerelease-capable UI-build channel — **M**

- `packages/lib/src/control-plane/ui-assets.ts` (`uiUpdateChannel` `:323-325`, `isSameMajorVersion` `:484`):
  decouple the channel from `app.getVersion()`. Introduce a declared **platform channel** input (stable→
  `latest`, prerelease→`next`) so a stable harness can opt into a `next` control plane for testing without
  faking the app version, and so the channel survives the harness/platform version split (§5.2). Decide and
  **document** whether cross-major control-plane updates may flow without a re-download, or whether a major
  bump is the intended (and only legitimate) harness-coordination point. **M**

### 6.5 Host-vs-target guard (#492) keyed on the *running control-plane* version — **M**

The deployment review's P0 #492 guard (`deployment-upgrade-ux-review.md` §"Prerelease / cross-version
bootstrap trap") is **load-bearing for this design**, with one correction the thin-harness model demands:

- The guard compares the **target stack tag** to the **lib version that runs the migrations**. In the
  thin-harness model that is the **running `data/ui` lib (`PLATFORM_VERSION`)**, *not* the frozen harness's
  `app.getVersion()`. Because §6.2/§6.3 ensure `data/ui` is current before the UI serves the upgrade request,
  the guard "target ≤ running-platform" is the correct, satisfiable invariant.
- Implement per the review: in `applyTagChange`/`performUpgrade` (`lifecycle.ts:512-555/:561-602`), before
  writing `stack.env`, throw a plain-language block if `target > PLATFORM_VERSION`; filter the UI stack-version
  dropdown to tags ≤ `PLATFORM_VERSION` (`stack-version/+server.ts`, `versions/releases/+server.ts`,
  `UpdatesTab.svelte:302-319`).
- **Interaction:** the old fear was "host (app) is older than target." The fix to that fear is *self-updating
  the control plane first* (§6.2/6.3) so the running platform is current, then the #492 guard only fires when
  the user genuinely picks a tag newer than any available control plane — which now means "wait for the UI
  channel to ship it," not "re-download the app." **M**

### 6.6 Harness-version gating — **M**

- New `packages/electron/src/harness-contract.ts`: `export const HARNESS_CONTRACT_VERSION = 1` plus a single
  enumerated description of the §5.1 surface; a snapshot test over the IPC channel + env key set fails CI until
  the integer is bumped intentionally. **S**
- `packages/electron/src/preload.ts` (`:24-35`): add `harnessContractVersion` to `updateStatus()` and as a
  dedicated `window.openpalm.harnessContractVersion` field. **S**
- `packages/electron/src/main.ts` (`buildUIServerEnv` `:199-217`): emit `OP_HARNESS_CONTRACT_VERSION`. **S**
- `@openpalm/ui` published manifest: declare `minHarnessContract`. The harness's update decision (§5.3)
  compares it before pulling. **M**
- `packages/ui/src/routes/admin/versions/+server.ts`: report `harnessVersion` (native shell) and
  `platformVersion` (running control plane) as **separate** fields with independent update-available flags, so
  the UI can tell users "platform updated automatically; app re-download only needed for harness vX." **S**

### 6.7 CLI's matching self-update story — **M**

- The CLI binary statically compiles its own lib; `migrate`/`update`/`install` run that copy. Keep
  `self-update.ts` as the CLI's lib-refresh mechanism (binary swap) and **document it as the CLI equivalent of
  the UI's automatic tarball swap**.
- Gate CLI self-update and version reporting on `PLATFORM_VERSION` (not the conflated app version).
- For the **UI it serves**, the CLI already runs the updatable `data/ui` lib (`ui-server.ts` → `resolveUiBuildDir`);
  with §6.3 it also pulls updates pre-spawn. So a CLI user gets platform updates for the *served UI* without
  re-downloading the CLI binary — they only re-download the binary when the migration code they invoke *via the
  CLI command path* changes. Make this split explicit in `openpalm --help` / docs. **M**

---

## 7. Rollout & back-compat

### 7.1 One-time bootstrap for existing 0.11.x / 0.12.0 desktop installs

Existing installs already have the launch-time `checkAndUpdateUiBuild` (`main.ts:373`). The bootstrap is:

1. Ship one harness release that (a) declares `HARNESS_CONTRACT_VERSION = 1`, (b) emits
   `OP_HARNESS_CONTRACT_VERSION`, (c) factors `startUIServer()` to be re-callable (§6.2), and (d) adds the CLI
   pre-spawn `checkAndUpdateUiBuild` (§6.3). This is the **last "forced" re-download for the foreseeable
   release line** — after it lands, control-plane + UI updates flow over npm.
2. The first such harness, on boot, pulls the current `@openpalm/ui` into `data/ui` (correctly stamped per
   §6.1), which becomes the steady-state executor. The frozen asar lib reverts to cold-start fallback only.
3. Published `@openpalm/ui` builds carry `minHarnessContract` from this point; the harness's GitHub poll
   surfaces "app re-download required" only when a future control plane raises `minHarnessContract`.

No user data migration is required — this is wiring, not a schema change. `seedOpenPalmDir` stays
skip-if-exists; nothing in this rollout writes user files.

### 7.2 Forward / backward compatibility of the harness contract

- **Newer UI on older harness:** UI feature-detects via `harnessContractVersion`; new IPC/env usage is gated
  and falls back to the HTTP path (`preload.ts:2-3`). If the UI's `minHarnessContract` exceeds the running
  harness, the self-update decision (§5.3) refuses the pull and prompts a re-download instead of failing at
  runtime.
- **Older UI on newer harness:** the harness keeps all existing channel names/env keys (additive-only
  changes); an older UI ignores fields it does not read. A harness change that *removes/renames* a contract
  member bumps `HARNESS_CONTRACT_VERSION` and is paired with a UI that no longer depends on the removed member.
- **CLI:** versions on `PLATFORM_VERSION`; the served UI floats with `data/ui`; the CLI command path floats
  with `self-update`.

---

## 8. Risks & open questions

1. **Stamp correctness is load-bearing.** If a published `@openpalm/ui` or a seeded `data/ui` lacks/garbles its
   version stamp, `resolveUiBuildDir` silently routes execution back to the **frozen** bundled lib (`:281`),
   re-introducing the exact "stale control plane" the design eliminates. Mitigation: §6.1 hard CI failure +
   runtime visibility. *Open: do we also want a startup assertion that the running lib version matches the
   `data/ui` stamp?*
2. **Restart-after-update UX.** Killing + respawning the UI child (§6.2) drops in-flight requests and resets
   server memory. *Open: do we restart immediately, on next idle, or prompt the user? How do we surface "UI
   updated — reconnecting"?*
3. **#492 guard semantics under self-update.** Keying the guard on `PLATFORM_VERSION` (running control plane)
   is correct only if `data/ui` is reliably current before the upgrade request is served (§6.3). *Open: if the
   npm pull fails (offline), the running platform may lag — does the guard then block a tag the user could
   legitimately reach once online? Need a clear offline message.*
4. **Cross-major policy.** `isSameMajorVersion` (`:484`) blocks cross-major auto-update. *Open question for the
   owner: is a major control-plane bump *allowed* to flow without a re-download, or is a major bump the one
   intended harness-coordination boundary?* §6.4 must encode whichever answer.
5. **CLI binary lib cannot hot-swap.** The CLI command path (`migrate`/`update`) runs the compiled-in lib;
   only `self-update` refreshes it (unsupported on Windows, `self-update.ts:125-127`). This is an accepted
   asymmetry vs. the UI path. *Open: should the CLI prefer running migrations *through* the served `data/ui`
   lib to unify the migration source, or keep the compiled copy for offline robustness?*
6. **Skeleton (stack/compose assets) on packaged apps.** `seedOpenPalmDir` prefers the local
   `OPENPALM_SKELETON_DIR` (`ui-assets.ts:94,144-160`; `electron-builder.yml:18-20`), so the GitHub-tarball
   *seed* fallback (`:171-193`) is dead for desktop.
   > **Reviewer correction (orchestrator).** This affects only the **first-boot seed default**, NOT updates.
   > The **upgrade path already refreshes stack/compose assets remotely by version**: `performUpgrade` →
   > `applyUpgrade` → `refreshCoreAssets(version)` (`lifecycle.ts:531`, `core-assets.ts:243`) downloads
   > `core.compose.yml`/`services.compose.yml`/`portals.compose.yml` etc. from
   > `github.com/${REPO}/releases/download/<version>/…` (`core-assets.ts:152-153`) on **every surface incl.
   > desktop**. So compose-asset changes (e.g. the portals rename, the mDNS removal) **do self-update** when a
   > user upgrades — they do *not* require an app re-download. The only residual gap is the *initial* skeleton a
   > brand-new desktop install starts with before its first upgrade. *Open (narrowed): version the first-boot
   > seed remotely too, or accept that a fresh install seeds the app-bundled skeleton and then immediately
   > self-updates on first upgrade.*
7. **Integrity & supply chain.** The control plane now self-updates code over npm. The sha512 fail-closed
   verification (`ui-assets.ts:357,379-382`) is the only gate; a registry/account compromise pushes code to
   every install. *Open: pin/notarize beyond the registry integrity hash?*
8. **Contract-version discipline.** The whole model depends on contributors bumping `HARNESS_CONTRACT_VERSION`
   when (and only when) the §5.1 surface changes. The snapshot test (§6.6) enforces *that a change was
   noticed*, not *that the bump is semantically right*. Documentation in `core-principles.md` (or an
   electron-specific doc) is required so the discipline is explicit.
