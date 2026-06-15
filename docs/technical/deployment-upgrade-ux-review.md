# Deployment / Upgrade / Migration UX Review

**Scope:** install · update · migrate · version-management across all four host surfaces —
Electron desktop app, web/admin UI, CLI, and the shared `@openpalm/lib` control plane.
**Branch:** `release/0.12.0` · **Version of record:** `0.12.0-rc.1` (all four packages pinned, verified
in `package.json`, `packages/{lib,cli,electron}/package.json`).
**Audience for the product:** non-technical self-hosters.
**Status:** review-only. No code was modified.

> **Audit note (orchestrator, 2026-06-15).** This report was produced by a deployment specialist and then
> independently audited against the code. Load-bearing claims were re-verified: the missing host-vs-target
> guard (P0), the Electron launch-time Docker gap (P0), the CLI rc auto-jump vs. the channel-aware UI card
> (P1), and the `migrate --dry-run` blind spot (P1) all hold. **One substantive correction was applied:**
> the draft's "auto-prune backups after upgrade" recommendation was removed — automatic backup pruning is
> *forbidden by a recorded owner decision* (`implementation-plan.md:164,450`) and the
> never-auto-delete-user-data rule; it was replaced with prevention (free-space check) + visibility. An
> urgency flag was added to the rc auto-jump (it is live as of `v0.12.0-rc.1`).

---

## 1. Executive summary

For a non-technical self-hoster the **happy path is genuinely good**: the web UI's "Update now"
card is a single, plain-English button ("Your settings are backed up first, then your assistant
restarts… Your data is kept" — `UpdatesTab.svelte:200`), and the migration engine is conservative by
design (full backup first, copy-only changes, version-stamp committed last, idempotent re-runs). The
trouble starts the moment a user steps off that one path — and the UI actively invites them to, via an
"Advanced options" disclosure that is one click away from a dropdown of every prerelease.

The single most dangerous issue is the **prerelease bootstrap trap**: the migrations that a release
needs live inside the *host's own copy* of `@openpalm/lib`, but nothing stops a user on an older host
(0.11.x app) from pointing the *stack* at a newer tag (`v0.12.0-rc.1`) through the version picker. That
path (`applyTagChange`) calls `ensureReleaseMigrated` against the **old** lib, whose migration array
does not contain the new release's migrations, so the new images come up against half-migrated files —
with no warning, no block, and no host-vs-target version check anywhere in the codebase (confirmed:
`lifecycle.ts` has no comparison of `libPkg.version` to the target tag).

Layered on top of that are several smaller-but-real friction points: a plain `openpalm update` can
**auto-jump to an rc prerelease** while the desktop app's own update check deliberately *never* offers
one (two surfaces disagree about what "latest" means); the desktop app does **no Docker check at
launch**, so the first error a brand-new user sees is a cryptic `503 docker_unavailable` 60 seconds in;
each layout migration copies the *entire* home including multi-gigabyte `data/` with **no free-space
guard**, so disks can fill silently (backups are deliberately never auto-pruned per owner decision — the
fix is a pre-copy space check + UI visibility, not auto-deletion); and **`migrate --dry-run` cannot preview an upgrade's
file changes** because it reads the target from the *current* stack.env, not from the version you're
about to move to. None of these are visible until they bite, which is exactly the wrong property for a
non-technical audience. The good news: the engine underneath is sound, so most fixes are guards,
warnings, and copy changes rather than rewrites.

---

## 2. Severity-ranked findings

### P0 — Prerelease / cross-version bootstrap trap (no host-vs-target guard)
**Surfaces:** Web UI · CLI · control plane.
**Symptom:** A non-technical user on a 0.11.x app opens **Advanced options → "Install a specific
version"**, sees `0.12.0-rc.1 (pre-release)` in the dropdown (`UpdatesTab.svelte:302–319`,
populated from `versions/releases/+server.ts` which returns **all** releases including prereleases with
no filter), selects it, and clicks apply. The stack pulls 0.12.0 images and rewrites stack.env — but
**none of the 0.12.0 migrations run**, leaving secrets named `channel_<name>_secret` instead of the
`portal_<name>_secret` files the new `portals.compose.yml` requires → portal containers fail Compose
secret lookup, and non-sensitive addon config never lands in stack.env.
**Root cause:** `applyTagChange` (`lifecycle.ts:561–602`) calls
`ensureReleaseMigrated({ targetVersion: resolvedTag })` at `lifecycle.ts:590`. But `RELEASE_MIGRATIONS`
(`migrations.ts:594–653`) is a *compiled-in array* — the 0.12.0 migrations only exist in a lib built at
0.12.0+. A 0.11.x host runs its own old array, `selectPendingReleaseMigrations` finds nothing to do
(`migrations.ts:110–124`), and the function returns "migrated: nothing." There is **no check** that
`libPkg.version` (the only host-version anchor, `lifecycle.ts:3,251`) is ≥ the target tag. The same gap
exists on `performUpgrade` (`lifecycle.ts:512–555`) and at every API/CLI entry point
(`upgrade/+server.ts`, `stack-version/+server.ts:13–48` — "No host version check"; `update.ts`).
**Proposed fix:**
1. In `applyTagChange` and `performUpgrade`, before writing stack.env, compare the resolved target tag
   to `libPkg.version` via the existing `compareComparableVersions`. If `target > host`, **throw** a
   plain-language error: *"This version (0.12.0-rc.1) is newer than the OpenPalm app you're running
   (0.11.5). Update the OpenPalm app first, then update the stack. Nothing was changed."* This is the
   one place a hard block (not a warning) is justified — proceeding corrupts state.
2. In the UI, **filter the stack version dropdown to tags ≤ the host version** (and label the host
   version), so the trap is not even reachable from the picker.

---

### P0 — Desktop app does no Docker check at launch; first failure is opaque
**Surfaces:** Electron.
**Symptom:** A non-technical user installs the desktop app on a machine without Docker, launches it,
watches the splash cycle "Starting… / Still starting… / Almost there…" (`main.ts:525–528`), reaches a
UI, clicks **Update now**, waits, and only then gets `503 docker_unavailable` from
`upgrade/+server.ts:51–55`. Nothing earlier told them Docker is a hard prerequisite.
**Root cause:** `app.whenReady()` (`main.ts:820–860`) and `startUIServer()` (`main.ts:337–482`) never
probe for Docker; the only Docker guard is inside the upgrade endpoint. The CLI, by contrast, has good
messages (`install.ts:136–138`: *"Docker is not installed. Install Docker first:
https://docs.docker.com/get-docker/"*) — the desktop app simply doesn't run them.
**Proposed fix:** At `app.whenReady()`, run the same `requireDocker()` preflight the CLI uses. If Docker
is missing/stopped, replace the spinner with a friendly screen: *"OpenPalm needs Docker Desktop to run
your assistant. [Install Docker] [I've installed it — retry]"* with the get-docker link. Fail early and
legibly instead of 60 seconds into a spinner.

---

### P1 — `openpalm update` auto-jumps to an rc prerelease; desktop never does (inconsistent semantics)
**Surfaces:** CLI · control plane · Electron (by contrast).
**⚠️ Live now:** with `v0.12.0-rc.1` published (2026-06-14), this is *active today* — any stable `0.11.5`
user who runs `openpalm update` is moved onto the rc with no opt-in. Treat the `resolveNewestDockerTag`
prerelease filter (change-list item 4) as near-term, not someday. (The UI *card* is safe — `latestForChannel`
gates stable users away from prereleases — but the CLI `update` and the API `/admin/upgrade` →
`performUpgrade` path do not.)
**Symptom:** A user on stable `0.11.5` runs `openpalm update` expecting a stable update and is silently
moved onto `0.12.0-rc.1` — a prerelease they never opted into. The *same* user's desktop app, checking
GitHub `/releases/latest`, will **never** offer that rc (`update-check.ts:50`, and GitHub's
`/releases/latest` excludes prereleases by design). So the two surfaces disagree about what an "update"
is.
**Root cause:** `performUpgrade` → `resolveLatestPlatformTagForCurrentMajor` →
`resolveNewestDockerTag` (`lifecycle.ts:211–244`) has **no prerelease filter**. It returns the newest
semver tag in the same major; `0.12.0-rc.1` sorts above `0.11.5` (`versioning.ts:43–55`,
`compareComparableVersions`), and *all* `0.x` count as the same major
(`isSameMajorVersion`, `versioning.ts:62–66`), so the rc is eligible. The web UI's *card* path is safer
because `latestForChannel` (`version-compare.ts:85–93`) sets `wantPre` from whether the *current*
version is a prerelease — but the **CLI does not use that gate at all.**
**Proposed fix:** In `resolveNewestDockerTag`, when the base/current tag is a *stable* release, **skip
prerelease tags** (mirror `version-compare.ts:85–93`). Add an explicit `openpalm update --pre` opt-in
for users who want rc's. This makes CLI, UI card, and desktop agree: stable users get stable, and a
prerelease is always a deliberate choice.

---

### P1 — `migrate --dry-run` cannot preview an upgrade's file changes
**Surfaces:** CLI.
**Symptom:** A cautious user runs `openpalm migrate --dry-run` to "see what an update will change to my
files" before committing — and it shows only the *layout* migration (or "Already on the current layout…
Nothing to do.", `migrate.ts:21`). It never previews the 0.12.0 release migrations (portal-secret
rename, addon-config copy, `channel_lan` rewrite) because there is no way to tell it the target.
**Root cause:** `migrate.ts:19` calls `ensureMigrated({ dryRun, log })` with **no target version**.
Inside `ensureMigrated`, the release target is read from the *current* stack.env
(`migrations.ts:719–723`: `readReleaseVersion` → `OP_RELEASE_VERSION` ?? `OP_IMAGE_TAG`), i.e. where the
user already *is*, not where they're going. `selectPendingReleaseMigrations` therefore finds nothing
new. The release-aware entry point `ensureReleaseMigrated(targetVersion)` exists (`migrations.ts:823`)
but the `migrate` command never calls it.
**Proposed fix:** Add `openpalm migrate --dry-run --to <version>` (default the newest published tag for
the current major). Route it through `ensureReleaseMigrated({ targetVersion, dryRun: true })` so the
user sees the exact copy-only operations (the migrations already log `[dry-run]` lines). Surface the
same preview in the UI's "Advanced options" before an apply.

---

### P1 — Backups never auto-pruned; full home (incl. multi-GB `data/`) copied each layout migration
**Surfaces:** control plane · CLI · UI (absence of).
**Symptom:** After several upgrades the user's disk silently fills. Each layout migration copies the
**entire** OP_HOME — including `data/` (AKM databases, logs, OpenCode caches), which can be gigabytes —
into `data/backups/<timestamp>/` (`backup.ts:14–40`; it copies every top-level entry and all of `data/`
except the backups dir itself). Nothing ever deletes old snapshots automatically.
**Root cause:** `pruneBackupDirs` (`backup.ts:52–62`) exists but is called **only** by the manual
`openpalm backups prune` command (`backups.ts:81`) — never by install/update/migrate. There is no
pre-backup free-space check and no UI affordance to see or manage backups.

> **⚠️ Reviewer correction (orchestrator).** The original draft proposed *auto-pruning* backups after an
> upgrade. That is **explicitly forbidden by a recorded owner decision** — *"pruning deletes user data …
> No automatic pruning in 0.12.0 … explicit command only, owner-approved"*
> (`.github/roadmap/0.12.0/implementation-plan.md:164,450`) — and it violates the project's
> never-auto-delete-user-data safety rule. Backups must stay recoverable across the **last major version
> to the current version** (owner policy: keep one major + all intermediate minors), so a blind
> "keep 3" is also wrong. Do **not** auto-delete. The real fixes are *prevention + visibility*, below.

**Proposed fix (revised — no automatic deletion):**
1. **Pre-backup free-space check.** Before the migration copies the home, estimate the backup size and
   compare to free disk; if it would exceed a safe threshold (e.g. 80% of free space), **warn and ask to
   confirm** (or offer to point backups at another disk) rather than silently filling the disk. This is
   prevention, not deletion.
2. **Don't copy `data/` into the layout backup by default.** The multi-GB `data/` (AKM dbs, logs,
   OpenCode caches) is the bulk of the size and the *least* migration-relevant; consider a config/secrets/
   stack-only safety copy with `data/` opt-in. (Verify against `backup.ts:14–40` before changing — the
   current full copy is the conservative default and must not silently lose anything users rely on.)
3. **Surface backups in the UI** (count, total size, last-backup time, **"restore"** button, and a
   **"prune…" affordance that drives the existing confirm-gated `backups prune` command** — never a
   silent auto-prune). Makes the recovery net discoverable *and* the owner-approved cleanup path usable
   without a terminal.

---

### P1 — No "an update is available" signal anywhere except the desktop title bar
**Surfaces:** CLI · Web UI · Electron.
**Symptom:** A non-technical user has no idea an update exists. The CLI never announces availability
(confirmed: `update.ts`/`status.ts` emit nothing of the sort — `status.ts` is pure JSON). In the web
UI the only cues are an amber chip border and a ⬆️ emoji (`UpdatesTab.svelte:145–149,608–612`) plus the
"Update to the latest version" card — easy to miss if you aren't on that tab. The desktop app's only
proactive cue is the window title `"OpenPalm — Update available (vX)"` (`main.ts:561–563`).
**Root cause:** No global "update available" surface; status is computed per-tab/per-window and never
pushed.
**Proposed fix:** Compute update-availability once on the server (reuse `updateStatus` /
`latestForChannel`, `version-compare.ts:74–93`) and expose a small persistent banner/badge in the UI
shell ("An update is ready — review it") and a one-line note at the end of `openpalm status`
("An update is available: run `openpalm update`."). One signal, one obvious next action.

---

### P1 — Electron app can't self-update across a prerelease (and can't self-update at all on its own)
**Surfaces:** Electron.
**Symptom:** The desktop app is **notify-only** (`update-check.ts:1–3`): it shows a download link
(`data.html_url`, `update-check.ts:81`) and the user must manually re-download and reinstall. Because it
polls `/releases/latest`, it also never even *notices* a prerelease, so a user piloting an rc stack has
a desktop app that believes it's current. There is no in-app prerelease opt-in.
**Root cause:** `update-check.ts:46–105` compares against a single non-prerelease "latest" tag; no
channel toggle, no auto-installer.
**Proposed fix:** Short term — add a "Check for prerelease versions" toggle that switches the poll to the
full releases list and filters in-app (so rc-pilot users get notified). Medium term — adopt a signed
auto-updater (electron-updater) so the desktop app can actually install updates instead of bouncing the
user to a manual download. (Signing is a prerequisite; track separately.)

---

### P2 — `install --force` and lock-held errors give weak recovery guidance
**Surfaces:** CLI · control plane.
**Symptom:** When an install/upgrade aborts because another is in progress, the user sees *"Another
install is in progress. Wait for it to finish, or remove state/.install.lock if you're sure no install
is running."* (`setup.ts:168`) — which asks a non-technical user to `rm` a file by hand. The lock does
auto-heal after 30 minutes (`install-lock.ts:25`), but nothing tells them that. `install --force`
likewise prints no rollback hint pointing at the backup it just made.
**Root cause:** No `openpalm unlock` command and no UI affordance; the lock path is exposed as raw
recovery instructions. `install.ts` error paths don't echo the backup dir for self-rollback.
**Proposed fix:** Add an `openpalm unlock` command (and a UI "an operation seems stuck — clear it?"
action) that validates staleness via the existing `install-lock.ts` logic before removing. Append "If
something went wrong, your previous state is backed up at `<backupDir>` — run `openpalm rollback`." to
abort messages.

---

### P2 — `writeSystemEnv` silently strips secret-like keys from stack.env (no warning)
**Surfaces:** control plane.
**Symptom:** A user (or a how-to blog) puts `OPENAI_API_KEY=…` into stack.env; on the next config write
it silently vanishes and the provider stops working, with no message explaining why.
**Root cause:** `stripSecretLikeEnvKeys` (`config-persistence.ts:103–114`) removes any
`_API_KEY|_TOKEN|_SECRET|_PASSWORD` key on every `writeSystemEnv` (`config-persistence.ts:91–100`).
This is *correct* per the secret-boundary contract (secrets belong in `knowledge/secrets/`), but it's
invisible.
**Proposed fix:** When keys are stripped, log a structured note and surface a one-time UI notice:
*"Secret-looking values were removed from stack.env (they belong in Connections / secrets). Re-add them
via the Connections tab."* Don't change the behavior — just stop doing it silently.

---

### P2 — Version-semantics maze: `v`-prefix, npm `latest`/`next`, `OP_IMAGE_TAG` drift
**Surfaces:** all.
**Symptom:** The same release is spelled four ways — Docker tags are `v`-prefixed (`v0.12.0-rc.1`), npm
versions aren't (`0.12.0-rc.1`), npm rc's live on the `next` dist-tag while stable lives on `latest`,
and the UI build channel is silently chosen from the *app* version at server start
(`main.ts:387`, `uiUpdateChannel(version)`) with no user-visible indication of which channel is active.
A user comparing "what version am I on?" across the App row, Assistant row, and UI row
(`UpdatesTab.svelte:222–293`) sees three differently-formatted numbers.
**Root cause:** Heterogeneous version vocabularies normalized ad hoc (`versioning.ts:14–21` strips the
`v`; `version-compare.ts:19–22` re-derives prerelease) and no single "you are on X; latest stable is Y;
latest prerelease is Z" presentation.
**Proposed fix:** Normalize display to one canonical form everywhere (drop the `v` in UI labels), and add
a one-line channel indicator in the UI ("You're on the **stable** channel"). Keep the internal tag
formats; only unify what the user reads.

---

### P2 — Downgrades via the version picker have no confirmation or data-safety warning
**Surfaces:** Web UI · control plane.
**Symptom:** The "Install a specific version" dropdown lists older releases too; selecting one is treated
exactly like an upgrade — no "this is a downgrade; migrations are forward-only and your data may not be
compatible" warning. `applyTagChange` happily writes the older tag.
**Root cause:** `applyTagChange` (`lifecycle.ts:561`) does not compare target to current; the UI offers
no downgrade-specific confirmation.
**Proposed fix:** Detect `target < current` and require an explicit confirmation with a plain warning
that release migrations don't run backward and a restore-from-backup pointer.

---

## 3. Cross-cutting themes

- **Host-bootstrap problem (the root theme).** Migrations are compiled into the host's `@openpalm/lib`,
  but the host and the stack version are independently selectable on three surfaces. Every "the stack is
  newer than the host" path is unguarded. *The host must always be upgraded first, and the code must
  enforce that.* This is the through-line behind the P0 trap, the rc auto-jump, and the desktop
  notify-only gap.
- **Two definitions of "latest."** The CLI/control-plane resolver includes prereleases; the desktop
  GitHub check and the UI *card* exclude them. Pick one rule (stable users get stable; prereleases are
  opt-in) and apply it in `resolveNewestDockerTag` so all surfaces agree.
- **Version-semantics confusion.** `v`-prefix vs none, npm `latest`/`next`, per-image `OP_*_IMAGE_TAG`
  fallbacks, and a silently-chosen UI channel. The engine handles these fine; the *user-facing
  presentation* doesn't unify them.
- **Backup / rollback visibility.** The safety net is real (full backup, armed rollback snapshot,
  `openpalm rollback`) but **invisible and never size-checked** — never surfaced in the UI, no pre-copy
  free-space guard. (It is *deliberately* never auto-pruned — owner decision; cleanup is the explicit
  `backups prune` command only. The gap is visibility + a free-space guard, not the absence of
  auto-deletion.)
- **Error-message quality.** Excellent and specific in the CLI's Docker preflight; weak or absent for
  lock contention, silent secret-stripping, downgrades, and desktop Docker-missing. Recovery guidance
  rarely points at the backup that was just made.
- **Discoverability.** No proactive "update available, here's the one safe button" outside the desktop
  title bar, and a confusing spread of verbs (`update` vs `migrate` vs `pin` vs `self-update` vs the UI
  picker) with no in-product map of which to use when.

---

## 4. Prioritized change list (sequenced for max friction reduction first)

1. **Add a host-vs-target version guard** in `applyTagChange` + `performUpgrade`: block (with a
   plain-language message) when the target tag > `libPkg.version`. *(control plane — M)* — closes the P0
   trap.
2. **Filter the UI stack-version dropdown to tags ≤ host version**, and label the host version.
   *(Web UI — S)* — makes the trap unreachable from the picker.
3. **Add a Docker preflight at Electron `app.whenReady()`** with a friendly install/retry screen reusing
   the CLI's `requireDocker()` messages. *(Electron — M)* — kills the opaque 60s `503`.
4. **Stop prerelease auto-jump in `resolveNewestDockerTag`** for stable bases; add `openpalm update
   --pre`. *(control plane / CLI — M)* — aligns all three surfaces' "latest."
5. **Pre-backup free-space check + UI backup visibility** (count/size/restore + a button that drives the
   *existing* confirm-gated `backups prune`). **No automatic deletion** — owner-forbidden
   (`implementation-plan.md:164,450`). *(control plane + Web UI — S/M)* — stops silent disk fill without
   deleting user data.
6. **Add `openpalm migrate --dry-run --to <version>`** routed through `ensureReleaseMigrated(dryRun)`,
   and show the same preview in the UI before apply. *(CLI + Web UI — M)* — real upgrade preview.
7. **Global "update available" banner/badge** in the UI shell + a closing line in `openpalm status`.
   *(Web UI + CLI — S)* — discoverability.
8. **Surface backups in the UI** (list, size, restore, prune buttons). *(Web UI — M)* — makes the
   recovery net usable without a terminal.
9. **Append backup/rollback recovery hints** to abort/error messages, and add an `openpalm unlock`
   command + UI "operation stuck?" action. *(CLI + control plane — S/M)*.
10. **Downgrade confirmation** with a forward-only-migrations warning in `applyTagChange` + UI.
    *(control plane + Web UI — S)*.
11. **Warn (don't silently strip) secret-like keys** removed from stack.env. *(control plane — S)*.
12. **Unify version display** (canonical no-`v` labels) + show the active UI channel. *(Web UI — S)*.
13. **Electron prerelease opt-in toggle**, then **signed auto-updater** (separate, larger track).
    *(Electron — M then L)*.

---

## 5. What already works well (don't regress these)

- **The migration engine is genuinely safe.** Full-home backup taken first and the upgrade *aborts* if
  the backup fails (`migrations.ts:764–773`); migrations are **copy-only / additive**, never deleting the
  source (e.g. `copyIfAbsent`, the retained `vault/` with a written safe-removal README,
  `migratePortalSecretNames` skip-if-present); the version stamp is committed **last** so a crash just
  re-runs idempotently (`migrations.ts:792–797`). The non-destructive filesystem contract holds.
- **The web UI "Update now" card is exactly right for the audience** — one button, plain language about
  backup/restart/downtime/data safety (`UpdatesTab.svelte:197–217`). This is the model the other surfaces
  should match.
- **CLI Docker error messages are excellent** — specific, actionable, with official install links
  (`install.ts:136–138`).
- **The stack-env rollback wrapper is well-reasoned** — `withStackEnvRollback` snapshots the *pre*-upgrade
  state and arms `openpalm rollback`, and explicitly avoids capturing the broken tag
  (`lifecycle.ts:481–504`).
- **Per-image tag fallback and "refuse incomplete release" guards** prevent updating onto a tag whose
  required images aren't published (`lifecycle.ts:331–356`) — a thoughtful protection against partial
  releases.
- **`update` correctly stays within the current major** (`resolveLatestPlatformTagForCurrentMajor`) — no
  surprise major-version jumps. (The only flaw is prerelease inclusion, item 4.)
- **The install lock is correct and self-healing** (atomic `O_CREAT|O_EXCL`, dead-PID + 30-min staleness
  detection, `install-lock.ts:51–145`) — the engineering is sound; only its *user surfacing* needs work.
