# Install & Update — Rebuild Plan

> Implementation plan to rebuild install/update to match
> [`install-update-constitution.md`](install-update-constitution.md). The
> constitution is the *what/why*; this is the *how/in-what-order*. Every phase
> cites the constitution section it satisfies; nothing here may reintroduce a §8
> forbidden item.
>
> **Reviewed and corrected** by three specialists (codebase accuracy, constitution
> compliance, software-design). Their must-fixes are folded in: test-first
> sequencing (Phase 0), a read-only/backed-up transition, the real consumer list,
> and corrected file targets. See "Review corrections applied" at the end.
>
> **Foundation assumptions empirically verified (throwaway-home spikes):**
> overwrite-managed-preserves-user, copy-out-is-source-safe/idempotent/abort-on-doubt,
> running-image-by-digest exposes the pin lie, missing-tag-pull-fails-loudly. And
> the `config/assistant` blocker is resolved against **OpenCode 1.17.4**: XDG-split
> dirs + config merge confirmed; plugins install into the config dir (the pollution
> cause); `OPENCODE_CONFIG` (single file) loads the user override without polluting
> its dir. The ownership model below reflects the verified four-tree split.

---

## Guiding shape

The whole rebuild is downstream of **one** change: **separate managed files from
user/state files by location.** Once ownership is unambiguous, the machinery that
exists only to cope with the tangle — drift detection, version-stamped seeding,
the release-migration framework, "non-destructive reconcile" — has nothing to do
and is deleted.

Two principles govern the order:
1. **Tests first.** The integration tests that prove the constitution's invariants
   are written *before* the code changes, against real `docker compose`, and start
   red. A phase is "done" only when its stubs go green — never on mocks.
2. **Never destroy user data.** The one-time layout transition is **read-only on
   the user's files** (copy-out, never rewrite-in-place), backed up, idempotent,
   verified, and reversible. This is absolute.

| Phase | Outcome | Scope |
|---|---|---|
| 0 | Integration test harness + failing stubs (real `docker compose`) | test scaffold |
| 1a | Dual-read state from old `stack.env` **and** new `state/` — additive, zero user impact | small |
| 1b | One-time **copy-out** transition (backed up) + skeleton strip | the last migration |
| 2 | Unified `apply()` for files; delete migration/drift/reconcile framework + rework its CLI/UI consumers | **−≈1500+ lines** |
| 3 | Docker layer tells the truth and fails loudly; collapse the endpoints | medium |
| 4 | Runtime npm hot-swap (UI build + skeleton) + atomic swap + supervisor restart | **large (not "refactor")** |
| 5 | Versions/pinning data model (relocate `versions.ts`) + truthful-state endpoint | medium |
| 6 | Full updates-UX rebuild (UpdatesTab + splash) | **large (not "rewrite a file")** |
| 7 | Verify all stubs green, delete dead mocks, §8 grep + §9 litmus pass | cleanup |

---

## Phase 0 — Integration test harness + failing stubs (test-first)

**Satisfies:** the "tests are worthless" gap; gates every later phase.

Mocked unit tests structurally cannot catch the real bugs (pin-vs-running,
stale-cache success, managed-overwrite-vs-user-preserve). So the real tests come
**first** and start red — they document exactly what each phase must make true.

1. Build a disposable harness: a throwaway compose project under a **unique
   project name** (never the user's `openpalm` project), a `mkdtemp` `OP_HOME`,
   tiny throwaway images where a real one isn't needed, real `docker compose`.
   Gated `RUN_DOCKER_STACK_TESTS=1` per repo convention.
2. Write **failing stubs** for the invariants:
   - overwriting managed files leaves every user/state file byte-identical;
   - the one-time transition preserves all pins and never mutates `stack.env`;
   - `apply()` is idempotent and never touches user/state;
   - a pin to a non-existent tag **fails loudly** (`manifest unknown` + the tag),
     never a stale-cache success;
   - `getRunningImages()` reports the running container's **digest**; stopped/absent
     is reported as such;
   - hot-swap + supervisor restart lands on the new build.
3. CI runs them; red is the baseline. Each later phase turns its stubs green.

**Acceptance:** harness runs; every stub present and red for a documented reason.

---

## Phase 1a — Dual-read (additive, zero user impact)

**Satisfies:** §1, §4.2; de-risks the transition (design review P0-3).

Introduce the new state location **without** moving anything yet, so the new path
is proven against real installs before the transition runs.

1. Create `OP_HOME/state/` and define `state/stack.state.env` (pins,
   `OP_ENABLED_ADDONS`, channel, any port/namespace override) and `state/setup.json`
   (setup-complete, owner, choices).
2. **Relocate the version data model** — `versions.ts`
   (`readVersions`/`writeVersions`/`SERVICE_VERSION_KEYS`/`VERSION_DEFAULTS`) and
   the `OP_ENABLED_ADDONS` reader/writer — to **read from `state/stack.state.env`
   if present, else fall back to the legacy `stack.env`**. Writes go to the new
   state file only.
3. **Env-file order** (edit `buildEnvFiles` in **`config-persistence.ts`**, not
   `compose-args.ts`): compose loads `defaults.env` (managed) → `state/stack.state.env`
   (state); later wins. **`user.env` stays OUT of compose `--env-file`** — it is
   entrypoint-sourced (the secret-boundary contract); do not route it through compose.

**Acceptance:** on an install with only legacy `stack.env`, versions/addons resolve
unchanged (dual-read fallback). On one with a state file, the state file wins. No
user file is written.

---

## Phase 1b — One-time copy-out transition + skeleton strip

**Satisfies:** §1, §1.3, §4.1; the absolute no-data-loss rule.

### The transition (read-only on user files)
A single idempotent **copy-out** step, run once:
- **Reads** `OP_*_VERSION`, `OP_ENABLED_ADDONS`, channel, and any port/namespace
  override from the existing `stack.env`; **writes** them (atomically: temp +
  rename) into `state/stack.state.env`.
- **Never edits, truncates, or deletes `stack.env`.** The source is left
  byte-for-byte; it simply becomes redundant under env-file ordering. Unrecognised
  keys/comments/blanks are ignored, never carried-then-dropped.
- **Migration-safety protocol** (design review P0-2): write a timestamped backup
  (`state/migrate-backup-<ts>/stack.env.bak`) first; **idempotency guard** — skip
  if `state/stack.state.env` already holds `OP_ENABLED_ADDONS`; a `--dry-run` that
  prints the intended copy without writing; **verify** the new file parses and
  compose resolves the three-file chain; **restore from backup + abort** on any
  doubt (malformed/missing/unexpected source); **structured logs** of every read
  and write. Fail-fast, never partial.
- Because nothing user-owned is mutated, this is a non-destructive seed, not a
  rewrite — fully inside §1. It precedes the first reconcile, so a progress screen
  is appropriate (§4.1).

### Tree restructure to the four-tree model (constitution §1, verified by spike)
The skeleton becomes the **`system/` (managed)** tree; the release additionally
carries **seed-once defaults** for the user trees. Concretely:

- **→ `system/` (managed, overwritten):** the compose stack (moved out of
  `config/stack`), the **system** OpenCode config (plugin list + permissions +
  instructions), shipped defaults. `system/` *is* the skeleton.
- **→ user trees / seeds (seed-once, never overwritten):** default
  `config/assistant/*` user config (`opencode.json`, `persona.md`, themes),
  default `knowledge/` content, **built-in skills/tasks (`knowledge/skills`,
  `knowledge/tasks`)**, **tool manifests (`data/<svc>/tools/package.json`)**,
  `workspace/`, `config/stack/custom.compose.yml` (user overlay),
  `knowledge/env/user.env`. Written only where absent. (Owner directive:
  tools/skills/tasks are operator-owned seeds, NOT system-managed.)
- **→ `data/` (runtime, never written by install/update):** dbs, logs, caches, the
  OpenCode HOME and **plugin `node_modules`**. Dirs ensured; contents never copied.
- **→ `state/`:** pins, addons, channel, setup (Phase 1a/1b).

**OpenCode config split (per OpenCode config precedence — opencode.ai/docs/config):**
OpenCode MERGES config sources in precedence order; the two tiers we use are
(2) the **global config `~/.config/opencode/opencode.json`** (under HOME, user-
overridable) and (7) **managed config files / `OPENCODE_CONFIG_DIR`** (a system
directory, high precedence). Mapping:
- **USER (power-user managed):** `OP_HOME/config/{assistant,guardian}` is bind-
  mounted at the container's **`~/.config/opencode`**. The operator edits
  `config/assistant/opencode.json` (model/providers), `persona.md`, `tui.json`
  directly — it IS OpenCode's global config. Seeded once, never overwritten.
- **MANAGED (platform-enforced):** `OP_HOME/system/{assistant,guardian}` is bind-
  mounted as **`OPENCODE_CONFIG_DIR`** (plugin list/permissions/instructions),
  overwritten on update. Plugin `node_modules` install relative to
  `OPENCODE_CONFIG_DIR` / data caches — NOT into the user's `config/` tree.

Disjoint keys (plugins/permissions vs model/provider) so both apply; on any
conflict the managed system dir wins (correct — platform enforcement). NO
`OPENCODE_CONFIG` single-file and no bespoke mount path. `AGENTS.md` ships in
`system/` so the entrypoint's seed-if-absent skips → **compose env/mounts only,
no entrypoint change / no image rebuild** (verified against `assistant:0.12.42`).

**Port/namespace overrides** are **state** (carried into `state/stack.state.env`),
so overwriting the managed env defaults never reverts a user's port (compliance V2).

**Acceptance:** `config/assistant` (= `~/.config/opencode`) has **no `node_modules`**
after a real assistant boot; a power-user edit to `config/assistant/opencode.json`
(model/provider) takes effect; managed plugins/permissions from `system/assistant`
apply; same for guardian (`config/guardian` → `~/.config/opencode`, `system/guardian`
→ `OPENCODE_CONFIG_DIR`); `system/` overwrite preserves every user-tree + `data/` file.

---

## Phase 2 — Unified `apply()` for files; delete the framework

**Satisfies:** §0 (one path), §8 (delete reconcile/drift/migrations).

File side of install==update becomes one operation:
```
ensureDirs()                       // create empty data/ + user-tree dirs if missing
overwriteSystemTree()              // blind copy release → OP_HOME/system  (managed; always)
seedUserDefaults(ifMissing=true)   // write user-tree defaults only where absent (idempotent)
//                                 // data/ + state/ are never written here
```
Install = that + first-run input collection. Update = the same on a populated home
(the seed-if-missing is a no-op once the user trees exist).

### Delete / collapse (with the consumers the first draft missed)
- `migrations.ts` (**1,493 lines**) — `RELEASE_MIGRATIONS`, `ensureMigrated`,
  `MigrationError`, all layout/release migrations.
- `lifecycle.ts` — `applyHomeReconcile`, `reconcileHome`/`reconcileCore`
  seed-if-missing; merge `applyInstall`/`applyUpdate` into one `apply()`.
- `ui-assets.ts` — `isSkeletonStale`, `SKELETON_VERSION_STAMP`, the stale-detection.
- `core-assets.ts` — `refreshCoreAssetsFromSource` + managed-asset-hash bookkeeping.
- **CLI consumers (accuracy D1):** rework `packages/cli/src/commands/install.ts`
  (drops `ensureMigrated` + `seedOpenPalmDir`), `commands/update.ts` (drops
  `ensureMigrated`), **delete `commands/migrate.ts` + `migrate.test.ts`** (the
  `openpalm migrate` command), and the `seedOpenPalmDir` re-export in `lib/io.ts`
  (+ `install-flow.test.ts`).
- **UI consumers (accuracy D2):** rework/delete
  `packages/ui/src/lib/server/migration-status.ts` (`detectMigration`,
  `isMigrationBlocking`) and the migration routing in `hooks.server.ts` that forces
  `/splash`; delete `admin/migrate-apply`. The `/splash` *stale-gate* goes; `/splash`
  as a progress screen for long ops stays (§4.1).
- *(Electron is already clean — only comments reference `RELEASE_MIGRATIONS`.)*

**Rollback safety (design review P1-6):** a tagged release that still contains the
framework MUST exist and be documented **before** this phase lands, so a field
defect has a clean revert.

**Acceptance:** one `apply()`; `grep -r "RELEASE_MIGRATIONS\|ensureMigrated\|isSkeletonStale\|seedOpenPalmDir"` → 0 hits; the Phase-0 idempotency + user-preservation stubs pass.

---

## Phase 3 — Docker layer that tells the truth; collapse endpoints

**Satisfies:** §4.3, §5, §6.

In `docker.ts` / `compose-errors.ts`:

1. **`applyStack(scope)`** (the single compose driver):
   - one container → `compose pull <svc>` then `up -d --force-recreate --no-deps <svc>`
   - everything → `compose pull` then `up -d --remove-orphans`
   - always pass active `--profile` flags (voice/ollama variants).
2. **Pull failure is FATAL (corrected diagnosis, accuracy B1).** The code already
   pulls before up (`admin/update/+server.ts:77`); the real defect is the
   **non-fatal swallow** at lines 78–84 ("restarted from local cache" presented as
   success). Remove that fallthrough: a failed pull fails the update.
3. **Read the running image by digest.** Extend `inspectContainerStatus` (today
   only `.State.Status`) to also return `{{.Image}}` (digest), `{{.Config.Image}}`
   (tag), `{{.State.Health.Status}}`; add `getRunningImages()`.
4. **Success = running AND healthy**, with a **defined timeout + poll interval and a
   clear timed-out message** (design review P1-4) — "started" is not "succeeded".
5. **Named registry errors in `compose-errors.ts`** (NOT docker.ts — accuracy A1):
   extend `summarizeComposeStderr`/`mapDockerError` to map `toomanyrequests`,
   `pull access denied`, `manifest unknown`, network → specific messages with the
   offending `image:tag`. (`toomanyrequests`/`manifest unknown` are **new** mappings.)
6. **Pull the whole target set first** so a missing image fails before anything is
   recreated.
7. **Collapse the endpoints HERE, not in Phase 2** (accuracy resequence): once
   `applyStack` exists, `admin/install` and `admin/update` become thin wrappers over
   `apply()` (files) + `applyStack` (containers), absorbing the per-service failure
   attribution and the recreate-after-reconcile behavior that
   `admin/migrate-apply` did.

**Acceptance:** the Phase-0 "bad tag fails loudly" + "current = running digest" stubs pass; a stopped/absent container is reported, not inferred.

---

## Phase 4 — Runtime npm hot-swap (UI build + skeleton) [large]

**Satisfies:** §2, §4.4.

Rework `ui-assets.ts` (`seedUiBuild`/`checkAndUpdateUiBuild`; drop `seedOpenPalmDir`):

1. **Both the UI build and the skeleton are npm packages, hot-swapped at runtime.**
   The desktop shell bundles a default of each (offline/first-run); at runtime the
   npm copy replaces it and is what runs.
2. Per swap: resolve channel → exact version → **verify `dist.integrity`** (the hash
   from the **npm registry manifest**, not a self-check — design review P1-7;
   **fail closed**, with an actionable error: expected vs computed hash + retry/
   re-download) → stage → atomic rename → keep prior as on-disk backup → **stamp
   the exact version**.
3. **Restart via the supervisor** — automatic, no "apply" click. Define the
   supervisor contract **in this doc**: the Electron main process watches for the
   completed-swap signal and re-spawns the UI server; the CLI watchdog watches the
   stamp and re-spawns. **Two ~10-line implementations, NO shared abstraction
   layer** (avoid the §8 over-engineering trap — design review P1-5). A mode with no
   supervisor is unsupported (stated to the user, not discovered at runtime).
4. **Post-swap failure → restore backup** (compliance V3): if the restart onto the
   new build fails, the supervisor re-instates the on-disk backup (local rename, no
   registry) and surfaces the failure in context (§6).
5. **Gates:** never auto-cross a **major**; a **harness-contract** bump → prompt
   full app re-download, never self-apply.

### Supervisor contract (Phase 4)

The supervisor is the process that owns the UI server child and responds to the
completed-swap signal. There are exactly two implementations — no shared
abstraction (§8):

**Electron main process** (`packages/electron/src/main.ts`):
- `checkAndUpdateUiBuild` / `checkAndUpdateSkeleton` run before spawn, returning
  `backupDir` (the prior build's on-disk backup).
- After swap: the UI child or IPC/SIGUSR2 signals the parent. `restartUIServer()`
  kills the old child, re-resolves `resolveUiBuildDir()`, respawns, polls
  `waitForReady()`. On ready: reloads the renderer window. On timeout: renames the
  failed `data/ui` aside and restores `backupDir` → `data/ui` (local rename, no
  registry), logs the failure in context (§6).

**CLI watchdog** (`packages/cli/src/lib/ui-server.ts`):
- Same `checkAndUpdateUiBuild` / `checkAndUpdateSkeleton` before spawn; `spawnUiChild`
  returns `{ proc, uiBackupDir }`.
- After swap: the UI child sends SIGUSR2 (or SIGHUP) to its parent. `restartUiServer()`
  kills the old proc, calls `spawnUiChild` again (which re-runs the update check),
  polls `waitForReady()`. On timeout: restores `uiBackupDir` → `data/ui`, exits 1.

**Unsupported mode:** running the UI build directly (without either supervisor)
means a hot-swap will stage and rename successfully, but the new build does not
take effect until the next manual restart. This is stated to the user, not
discovered at runtime — `OP_UI_SUPERVISOR` is unset in direct-run mode.

**Acceptance:** hot-swap from npm + supervisor restart lands on the new build with
no manual step; corrupt integrity aborts and the prior build keeps running;
restart-failure restores the backup; cross-major/contract-bump prompt.

---

## Phase 5 — Versions/pinning data model + truthful state

**Satisfies:** §4.2, §5; §4 registry-down asymmetry.

1. **`versions.ts` on `state/stack.state.env`** (built in 1a): missing pin = track
   latest; present pin = locked; plus channel preference.
2. **`GET /admin/versions`** returns, per component: **running** (digest+tag from
   `getRunningImages()`), **pinned** (state, or null = latest), **available**
   (resolved latest on channel) — three distinct values, never collapsed.
   **Keep it backward-compatible** with the current UI for the mixed-version window
   (old shell + new UI build, or vice versa) — design review P2-9: old UI must not
   break on the new shape; document what it sees.
3. **"Up to date" by digest**, never tag strings (§5; §8).
4. **Registry-down asymmetry** (compliance G2): the background "available?" resolver
   degrades **silently** (keep running what we have); a **user-pressed** update that
   can't reach the registry **fails loudly** (§6).
5. **Voice variant on apply** (compliance G3): the stored pin is a **plain version**;
   `applyStack` appends the active-profile suffix (`-cpu`/`-cu121`/`-rocm6`); the
   control shows/stores plain versions only. On read, tolerate legacy `v` + suffix.

**Acceptance:** pin `v0.11.0` + running `v0.11.0` → "current" by digest; "current"
provably reads `docker inspect`, independent of the pin file.

---

## Phase 6 — Updates-UX rebuild (UpdatesTab + splash) [large]

**Satisfies:** §4, §4.1, §7.

Rebuild `UpdatesTab.svelte` and `/splash`:

1. **One obvious place** for versions/updates; remove stray update entry points
   (audit `grep -rn` for other update buttons).
2. **Granular plain controls:** "Update UI", "Update <container>", "Update
   everything" buttons over the Phase-3 scoped `applyStack`. No raw version-text-box
   grid as the primary surface; delete the Automatic/Manual two-mode split.
3. **Pinning as a clean control** (§4.2): pick a version from resolved options
   (variant hidden), or lock to current; channel toggle. Expert exact-tag entry is
   secondary.
4. **Proportional ceremony (§4.1):** flip-a-pin / one-line edits apply inline (no
   splash); stack recreate / pull / control-plane swap shows the splash/progress
   screen with live status.
5. **Errors located (§6):** failures render on the screen that triggered them.

**Acceptance:** updating one container doesn't touch the others; a failed pull shows
the named error in place while "current" still shows the real running image; no raw
text-box grid in the default path.

---

## Phase 7 — Verify, delete dead mocks, litmus pass

**Satisfies:** §8, §9.

1. All Phase-0 integration stubs are green.
2. Delete the §8 items now provably dead; delete mocked tests that no longer cover
   anything real.
3. **§8 grep checks return 0.**
4. **Apply the §9 litmus test** (compliance G5) to every retained/added step —
   especially Phase 4's supervisor logic and Phase 5's resolver (the most complex
   survivors). Anything failing the four questions is deleted, not shipped.
5. Regression proof: revert Phase 3's fatal-pull change and confirm an integration
   test goes red.

---

## First-run input (cross-cutting, §3 / compliance G1)

The setup wizard collects provider/credentials + password and writes them to
**user/state only**: `state/setup.json` (choices, owner, setup-complete),
`knowledge/secrets/*` (secrets, `auth.json`), `knowledge/env/user.env` (user env).
It MUST NOT write any managed file. (Named here so it isn't lost as "plus first-run
input.")

## Cross-cutting: what does NOT change

- guardian-only ingress, assistant isolation, the secret boundary (incl.
  `user.env` staying entrypoint-sourced), and LAN-first — untouched.
- The release pipeline (npm + images + tags) — unchanged; this plan is about how an
  *installed* system consumes releases.

---

## Review corrections applied

**Accuracy:** error-mapping is in `compose-errors.ts` (not `docker.ts`);
`buildEnvFiles` is in `config-persistence.ts`; the code already pulls-before-up so
the bug is the *swallowed* pull failure; `stack.env` is runtime-generated and the
data model to relocate is `versions.ts`; `user.env` must stay out of compose
`--env-file`; added the CLI (`migrate.ts`/`install.ts`/`update.ts`/`io.ts`) and UI
(`migration-status.ts`/`hooks.server.ts`) consumers; resequenced the endpoint
collapse to Phase 3; corrected the skeleton strip (managed `data/*/tools`, re-home
skills/tasks, create-if-missing `user.env`).

**Constitution:** transition is read-only/copy-out (V1); ports/namespace overrides
are state (V2); post-swap restore-from-backup (V3); first-run write locations (G1);
registry-down asymmetry (G2); voice variant appended on apply (G3); file/image
rollback explicit (G4); §9 litmus pass (G5).

**Design:** test harness first (Phase 0); migration-safety protocol
(backup/idempotency/dry-run/verify/restore/structured-logs/fail-fast); split
Phase 1 into 1a dual-read + 1b transition; health-wait timeout + message;
supervisor contract in-doc with no shared abstraction; rollback release before the
framework delete; `dist.integrity` from the npm registry; realistic scope labels;
mixed-version API compatibility.
