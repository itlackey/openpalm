# akm 0.9.x integration — issues found, 2026-08-30

Found while upgrading the stack to akm-cli 0.9.4 and testing a live instance.
Each entry says who owns it and whether it is already fixed. Written so the
open ones can be filed as issues without re-deriving anything.

---

## FIXED in this repo

### 1. Duplicate primary bundle broke `akm migrate` on every boot
`/stash` was registered as two bundles — `stash` (written by akm when
`AKM_BUNDLE_DIR` matches no configured bundle) and `openpalm` (our
`PRIMARY_BUNDLE_ID`) — and `stash` had become `defaultBundle`. akm enumerated
every task file twice and failed with
`duplicate task migration file path: /stash/tasks/akm-improve.yml`, exit 70.
The entrypoint downgraded it to a warning ("akm commands may fail until it
succeeds"), so every health check passed while akm's durable-state migration
was permanently blocked.

Fixed by `reconcileDuplicateBundles` (`akm-sources.ts`), wired into
`applyHomeAssets`. Compares the RESOLVED content root
(`path.resolve(entry.path, component.root ?? ".")`) rather than the bare
`path`, because two entries at `/stash` with component roots `.` and `docs`
are genuinely different directories.

### 2. Shipped tasks were task-source v2; akm 0.9.4 requires v4 to schedule
akm's scheduler sync rejects the ENTIRE desired source set if any task fails
to validate, so one bad file stops every scheduled job. Converted the four
shipped tasks to v4 (`run:` + `shell:` instead of a `command:` argv array).

### 3. Three retired task files were never actually removed
`migrateRetiredSkeletonFiles` deletes them but is gated `since: 6`, so any home
stamped 10 — every home upgraded during 0.13.0 development — skipped it
forever. Those files carry no `version:` key at all and blocked akm with
`unsupported-task-version`. Fixed with schema 10 → 11 and a new sweep.

### 4. OpenPalm's own task reader was v2-only
Converting the shipped tasks to v4 would have emptied the Automations tab and
404'd "Run now", because `markdown-task.ts` required a string `schedule:` and
only recognised `command`/`prompt`/`workflow`. Verified empirically before
shipping: the real reader returned 0 tasks for the v4 directory and 4 for v2.
`markdown-task.ts` now parses v4 while keeping the v2/v3 path.

### 5. New skeleton files never reach an existing home
`applyHomeSeed` seeds add-only (`copyTree(..., skipExisting)`), so the v4 task
files would never have replaced the v2 copies on an upgraded install — the fix
would have worked only on fresh installs. Stale pre-v4 copies of files we ship
are now RENAMED to `<name>.yml.pre-v4` (never deleted) and reseeded.

---

## OPEN — candidates to file against akm

### A. `akm task sync` refuses a package-local invocation without `--rebind`
```
Refusing to reconcile native scheduler bindings from an ineligible
package-local invocation (/usr/local/bin/node .../akm-cli/dist/akm).
```
OpenPalm bakes akm into the image at `/opt/openpalm/tools` rather than
installing it npm-global, which is deliberate (pinned, immutable, no runtime
npm). `--rebind` works but emits a warning on every sync calling our pinned
binary "a mutable, unproven binary" — the opposite of what an image-baked pin
is. Worth asking akm for a supported way to declare an immutable local
install, so the eligible path does not require a flag that self-describes as
unsafe.

### B. `migrate apply` is all-or-nothing across every configured bundle
One unconvertible file anywhere — including in a SECONDARY bundle the operator
owns — blocks conversion of every other file. On this install, eight task files
in `/host-stash` (the user's personal stash, mounted as a second bundle) stopped
the four OpenPalm-shipped files in `/stash` from converting. Per-bundle or
per-file progress would let a host fix its own tasks without waiting on an
unrelated bundle.

### C. Scheduler rejection names the file but not the operator's next move
`TASK_SCHEMA_VERSION_UNSUPPORTED` tells you to run `akm migrate apply`, but
when that is itself blocked (see B) the advice is a dead end. The message does
not distinguish "this file is convertible, run migrate" from "this file needs a
human decision".

---

## OPEN — ours

### D. `wiki-ingestion.yml` and the operator's `/host-stash` tasks
`wiki-ingestion.yml` was converted to v4 on this instance (v2 preserved as
`.pre-v4`). Eight task files under `~/akm/tasks/` are still v2 and blocked
`shell-command-resolution-changes-v2-literal-argv-semantics` — akm is warning
that a shell string would resolve DIFFERENTLY under v4 literal-argv semantics,
so each needs a human to confirm intent. They do not block the assistant's own
cron (different bundle) but they do block `akm migrate apply` completing.

### E. The upgrade guide needs a task-migration section
`docs/operations/upgrade-0.12-to-0.13.md` does not mention that an upgrading
operator's own `knowledge/tasks/*.yml` must move to v4, or that one bad file
silently stops ALL scheduled jobs. That is the single most likely post-upgrade
support question.

---

## Testing notes worth keeping

- The assistant image has NO `crontab` binary by design. `entrypoint.sh` writes
  a shim at `/tmp/openpalm-bin/crontab` that reads/writes
  `/tmp/openpalm-crontabs/$(id -un)`, which supercronic watches with
  `-inotify`. Any `docker exec` that does not put `/tmp/openpalm-bin` on PATH
  will report `crontab: not found` and look like a bug. It is not.
- `docker logs --since <duration>` spans container restarts. Use
  `--since "$(docker inspect --format '{{.State.StartedAt}}' <container>)"`
  when checking whether an error occurred on THIS boot.
