# Rootless branch — code-review follow-ups (R1–R10 COMPLETE)

Status: 2026-07-02. A high-effort review of `feature/rootless` (vs `main`) was run with
`--fix` (the "Applied" list below), then all ten remaining follow-ups (R1–R10) were
implemented across four parallel agents and reconciled. Everything is in the working
tree (uncommitted), verified green:
`bun run test` 1177 pass / 0 fail · `bun run check` 0 errors 0 warnings ·
`cd packages/cli && bun run typecheck` clean · `./scripts/validate-rootless-guardrails.sh`
passing · `bash -n` clean on all entrypoints and smoke scripts.

**R1** — `resolveSessionIdentity()` (live process uid when non-root; disk-owner only under
sudo) replaces the tautological disk-owner detection, so a real drive move is now caught;
null-uid sessions (sudo-over-root-home, win32) degrade to `match` instead of a spurious block.
**R2** — one shared `reconcileHostOwnership(state, {adoptHost, services})` + `HostSwapBlockedError`
in lib, called by CLI start AND the lib lifecycle/UI `containers/up`+`restart` routes (which
return `409 host_swap_blocked` with an actionable message). **R3** — deep (recursive) repair on
the drift path, not just `--adopt-host`. **R4** — `state/ownership-repaired.json` marker gates the
recursive chown to once per session-uid. **R6** — Dockerfiles use `chmod g=u` (+ correct chown)
instead of world-writable `a+rwX`, and the assistant chmod no longer recurses the baked tools
tree (giant-layer fix). **R7** — assistant caches moved to persistent HOME; nss_wrapper lookup
uses a fixed glob, not a full `/usr` walk (portal cache stays on `/tmp` by deliberate decision —
`portal-cache` is now in the named-volume repair map). **R8** — idempotent `pruneRemovedAddonState()`
strips stale `ssh`/`OPENCODE_ENABLE_SSH`, wired into `applyHome()`; disable path tolerates removed
addons. **R9** — guardrail drops the evadable `chown|chmod` token grep (behavior smoke test is the
real guard), keeps `gosu|usermod|groupmod`, fixes the phantom-allowlist message; brittle string
tests slimmed. **R10** — migration-plan doc corrected against shipped code + release-note sign-off added.

Both previously-deferred items are now also done (explicitly requested):
- **CI "build once"** — `.github/workflows/ci.yml` builds the UI + assistant/guardian/portal
  images ONCE (`smoke_build_images` in `scripts/rootless-smoke-fixture.sh`), then runs all three
  rootless smokes with `OP_ROOTLESS_SMOKE_SKIP_BUILD=1` so they reuse the shared `openpalm/*:dev`
  images instead of each rebuilding — ~3× less build wall-clock. The smoke scripts' CLI contract
  is unchanged; standalone runs still build themselves.
- **Docker Desktop seam** — `describeHostRuntime()` (platform-based: Docker on macOS/Windows is
  always a Linux VM). `reconcileHostOwnership` skips host-swap detection + the host-side bind-mount
  adopt on VM-mediated runtimes (where uid translation makes host-uid comparison unreliable) while
  still repairing named volumes in the VM uid namespace. One seam, no scattered `if (dockerDesktop)`
  checks, no speculative synthetic-uid math. Detail: migration plan §2.11 "Resolution (SHIPPED)".

The "Applied" list below is the original `--fix` review pass; the R1–R10 detail follows.

## Applied in the working tree (uncommitted)

1. **Crontab wrapper arg-forwarding bug** — `containers/assistant/entrypoint.sh` wrote
   `"\$@"` through bash `printf` (single-quoted format), baking the literal string `$@`
   into `/tmp/openpalm-bin/crontab`. Every `crontab` call (including `akm tasks sync`)
   silently failed → crond ran with an empty spool → no scheduled automation ever ran.
   Fixed to `"$@"`; string test updated and now also asserts `\$@` is absent.
2. **`--adopt-host` left stale `OP_UID`/`OP_GID` in the stack env** — repair chowned
   bind mounts to the new ids but compose still ran containers as the previous host's
   ids. `runStartAction` now patches `OP_UID`/`OP_GID` into `state/stack.state.env`
   (which overrides legacy stack.env at compose time) after a successful adopt.
3. **Named-volume ownership repair missing from the update/UI path** — only CLI
   `openpalm start` repaired `guardian-cache`; `openpalm update` / UI upgrade
   (`reconcileStack`) recreated a rootless guardian against a root-era volume →
   EACCES crash-loop. Added `repairManagedNamedVolumes(homeDir, services)` in lib
   `docker.ts` (service→volume map: guardian → guardian-cache; assistant →
   assistant-artifacts, assistant-persistent) and wired it into BOTH
   `reconcileStack` and `runStartAction`.
4. **`assistant-artifacts`/`assistant-persistent` volumes were never repaired at all**,
   and the assistant entrypoint swallowed the resulting `npm install` EACCES via
   `| grep -v "^npm warn" || true` — a root-era install would silently serve stale
   `@openpalm/ui`/skeleton forever. Covered by the volume map above; entrypoint now
   captures `PIPESTATUS[0]` and logs a loud ERROR on install failure.
5. **`repairNamedVolumeOwnership` hardening** — now skips volumes that don't exist
   (no more unlabeled pre-creation → compose "not created by Docker Compose" warning;
   no pointless chown on fresh installs), uses an argv `chown` instead of an
   interpolated `sh -c` string (repo rule: no shell interpolation), and the CLI start
   call is non-strict (offline hosts without an `alpine` image no longer hard-fail
   `openpalm start` when ownership was already fine).
6. **Profile filter in `discoverHomeBindMountSources` removed** — it stopped
   pre-creating bind-mount dirs for non-active profiled services, and broke the
   branch's own `packages/cli/src/install-flow.test.ts` (failing at branch HEAD
   `bd1a8c24` before this review). Restored pre-branch behavior: all OP_HOME mounts
   are pre-created regardless of profile (issue #452 class). The two new tests
   asserting the filter were replaced with one asserting the unfiltered behavior;
   the `includeServices` option was deleted end-to-end.
7. **Smoke-script deletion guard** — `scripts/rootless-ownership-smoke.sh` ran a
   containerized root `rm -rf` on `OP_ROOTLESS_SMOKE_HOME` with no validation
   (`OP_ROOTLESS_SMOKE_HOME=$HOME` would have deleted the home dir). Added the same
   repo-root `case` guard the host-swap script already had. Also gitignored
   `/.rootless-smoke-*/` and `/.rootless-host-swap*/` (root-owned scratch trees from
   smoke runs were sitting untracked at the repo root).
8. **Dead machinery removed** — the no-op `run_as_target_user() { "$@"; }` wrapper,
   unused `TARGET_UID`/`TARGET_GID`/`IS_ROOT` vars, and the `env …​ /bin/sh -lc`
   indirection in both entrypoints (guardian install restored to the plain
   `( cd "$prefix" && bun add … )` subshell); `classifyOwnershipDecision` (an unused,
   semantically-divergent duplicate of `decideOwnershipFromCanaries`) deleted from
   `host-identity.ts`, its test, and the lib barrel. String tests updated to pin the
   simplified forms.
9. **Strict repair now bypasses the top-level stat filter** — on `--adopt-host`,
   `repairRootOwnedBindMounts` chowns every existing candidate recursively (a
   top-level owner match can hide root-owned files nested inside). Also hoisted
   `resolveOperatorIds` out of the per-candidate filter loop.

## Remaining (NOT implemented — needs decision/design)

> **Update (test-hygiene / docs pass):** R9a, R5 (scripts only), and R10 are now done.
> - **R9a** — `scripts/validate-rootless-guardrails.sh`: dropped the evadable
>   `chown|chmod` entrypoint token grep (the branch already routed around it with
>   `install -m`), kept the meaningful `gosu|usermod|groupmod` static check, and fixed the
>   phantom "assistant/guardian exceptions" error messages to describe what is actually
>   enforced. The behavior smoke tests remain the real "no root-owned files" guard.
> - **R5** — extracted `scripts/rootless-smoke-fixture.sh`, a sourced helper that
>   single-sources the seed recipe (skeleton copy, secret files incl. `discord_bot_token`,
>   stack.env skeleton, `ensureHomeDirs`, version-override compose); both smoke scripts
>   source it. CLI entry points/args are unchanged so `ci.yml` needs no edits.
>   **Deferred (needs workflow approval):** the "build images once in CI" optimization —
>   it requires editing `.github/workflows/ci.yml`, which is out of scope here.
> - **R10** — corrected the migration-plan doc against shipped code (Phase-0 status, §2.7
>   guardian runtime install retained, §5.2 busybox crond vs sleep-loop, §2.10 sudo/gosu
>   line-citations) and added the required §2.10 release-note sign-off.
> - R9's broader "slim the string tests" and all of R1–R4, R6–R8 remain open below.

### R1. Host-swap detection is tautological in the true drive-move case (HIGH — core feature)
`detectHostIdentity()` derives the "current" uid from `resolveOperatorIds()`, which
PREFERS the OP_HOME directory owner when non-root. On a real host swap (ext4 drive
moved, files still owned by old uid 501), the "current identity" therefore IS the
stale disk owner: every canary matches it, the decision is `match`, the swap gate
never fires, and `--adopt-host` would chown to the OLD uid. The shipped host-swap
smoke only passes because it leaves the OP_HOME root dir owned by the current user
while chowning subtrees to root.
**Direction:** split the two meanings of "operator" — swap *detection* and the adopt
*chown target* must use the actual session identity (`process.getuid()`; decide
behavior under sudo/root), while `resolveOperatorIds`' prefer-disk-owner semantics
can remain for the sudo-install-for-service-user case. Decide how Docker Desktop
synthetic uids fit (migration plan §2.11 already flags this as unresolved). Related:
`decideOwnershipFromCanaries` with `uid: null` (sudo start, win32) can never return
`match` → spurious swap block, and adopt then repairs nothing while still recording a
`uid: null` baseline.

### R2. Swap gate / adopt flow exists only in the CLI (control-plane-in-lib rule)
UI/electron/admin start paths (`composeUp` via lifecycle, containers/up route) get no
swap detection, no block, no `host-identity.json` writes. The named-volume and
bind-mount repairs are now shared (fix #3), but the identity gate itself belongs in a
lib-level pre-compose step with a UX story for "blocked, needs adopt" in the UI.

### R3. Nested root-owned files on the non-adopt (drift) path
`repairRootOwnedBindMounts`' mismatch filter stats only each candidate's top level.
An upgrade that left root-owned files INSIDE user-owned dirs (e.g.
`data/portal/tools/node_modules` from the old root portal) is repaired only by
`--adopt-host` (strict bypass, fix #9), not by silent drift repair — and drift may not
even trigger since canaries are also top-level stats. Decide: one-time deep repair on
upgrade (release migration), or accept adopt-host as the remedy and document it.

### R4. Named-volume chown cost on existing installs
`repairManagedNamedVolumes` now skips missing volumes, but for existing volumes it
still runs a full recursive chown on every start/update (guardian-cache +
assistant-artifacts hold node_modules trees). Consider a marker (e.g. label or
sentinel file recording the last-chowned uid) so the walk runs once per uid change.

### R5. CI additions — approval + cost
`.github/workflows/ci.yml` gained four steps. Per the standing rule ("NEVER modify
workflows without explicit approval"), confirm this was explicitly approved. The three
smoke steps each rebuild the UI and the images and boot a full stack (3× wall clock,
3× registry flake surface); the two smoke scripts also duplicate ~80 lines of fixture
seeding that has already drifted (host-swap omits `discord_bot_token`). Consolidate:
one shared fixture helper, build images once, run stack/portal/host-swap assertions
against shared artifacts.

### R6. `chmod -R a+rwX` breadth in Dockerfiles
Both guardian and assistant images ship world-writable app trees (`/opt/openpalm`,
`/home/opencode`, `/stash`, `/work`), exceeding the `g=u` "arbitrary uid" convention
the migration plan §5.1 prescribes — any in-container uid can rewrite server code that
persists via named volumes. Also, the assistant's late `chmod -R` over the populated
`/opt/openpalm/tools` tree duplicates the multi-hundred-MB layer (the tree was split
across COPY layers specifically because Docker Hub rejects giant blobs). Scope the
chmod to freshly created empty dirs and switch to `g=u`.

### R7. Entrypoint efficiency nits
- npm/bun caches moved to container-ephemeral `/tmp` defeat `--prefer-offline` across
  recreates (bun tool cache previously lived under the persistent bind-mounted HOME).
  Decide whether warm-start network independence matters more than tmp hygiene.
- `find /usr/lib /lib -name libnss_wrapper.so` walks the whole library tree on every
  boot where the uid has no passwd entry; use the Debian multiarch glob
  (`/usr/lib/*/libnss_wrapper.so`) or bake the path as ENV at build time.

### R8. Stale `ssh` addon state on upgraded installs
`ssh` was removed from `BUILTIN_ADDON_IDS`, but `setAddonEnabled()` rejects unknown
addons BEFORE the enabled-set update, so an install with `ssh` in `OP_ENABLED_ADDONS`
can never disable/remove it via CLI or UI; `resolveActiveProfiles` keeps emitting
`--profile addon.ssh` (harmless to compose but permanently stale), and
`OPENCODE_ENABLE_SSH=1` lingers in the state env. Needs a small release migration to
strip `ssh` from `OP_ENABLED_ADDONS` and drop the env key.

### R9. Guardrail/test overlap and evasion
The same rootless invariants are encoded three ways (shell guardrail script, bun
string tests, a bun meta-test of the guardrail script). The guardrail greps for the
TOKENS `chown|chmod` and this branch already routes around it with `install -m 600`;
its error message references an "assistant/guardian exceptions" allowlist that doesn't
exist. Keep the behavior smoke tests as the real guard; slim the string tests to the
few invariants not covered by `validate-rootless-guardrails.sh`.

### R10. Migration plan doc is stale against shipped code
`docs/technical/rootless-containers-migration-plan.md` (635 lines) states Phase 0 is
"limited to CI guardrails" (the branch ships full conversions + host-swap reconcile),
mandates a sleep-loop over crond (shipped code uses busybox crond), says guardian deps
should be baked at build time deleting the runtime install (still runtime, now
unconditional), and cites deleted gosu/sudo Dockerfile lines. Per §2.10 the sudo
removal also requires an explicit release-note sign-off ("agent-initiated root
operations are disabled pending redesign"). Correct the doc before merge.
