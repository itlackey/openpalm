# OpenPalm Rootless + Portable-OP_HOME Migration Plan (Final Synthesis)

## 0. Status of this document

This is the reconciled plan from four expert drafts (containers, bindmounts, portability,
migration) plus their cross-critiques. Every conflict the critiques surfaced is resolved
below with an explicit decision and rationale — nothing is left as "expert A says X, expert
B says Y."

Where a decision depends on a fact, this plan now reads the real files in this checkout
(`containers/*`, `packages/skeleton/system/stack/*.compose.yml`, and
`packages/lib/src/control-plane/*`) and calls out each verification directly (line-cited in
the affected sections), rather than leaving the assumption unresolved.

Current implementation status:
- Phase 0 landed only partially.
- The current shipped Phase 0 work is limited to rootless non-regression CI guardrails.
- The originally-implemented filesystem startup/install hard gate was intentionally removed.
- The remaining plan has been updated so filesystem handling is a cross-platform compatibility,
  warning, testing, and ownership-reconciliation concern rather than a blanket block.

## 1. Non-negotiable constraints (restated, checked against every decision below)

1. **Host-accessibility invariant** (`core-principles.md:31`): every tree that remains a
   bind mount under `OP_HOME` must be readable/writable by the operator's own host account —
   never root-owned.
2. **No flag day.** dimm-city/rhiza, fwdslsh, databasin are live installs; every phase ships
   an upgrade path, never a reinstall requirement.
3. **Thumbdrive portability is a hard requirement.** Anything that must travel with the
   user (actual data, config, secrets, conversation/task history, workspace files) stays a
   bind mount under `OP_HOME` even if no human hand-edits it. Only genuinely
   regenerate-from-scratch, host-local state may become a Docker-managed named volume.
4. **File-secret contract is untouchable.** `knowledge/secrets/*` stays `0600`,
   `knowledge/secrets/` stays `0700`, single owning UID. Option 1's group-writable *image*
   convention applies only to application/cache files baked into images or written to
   shared/cache trees — never to `knowledge/secrets/`.
5. **Zero regression tests exist today** (no `.bats`, no CI grep-guard,
   `repairRootOwnedBindMounts` only ever mocked). Closing this gap is part of the deliverable,
   scheduled into phases below, not an afterthought bolted on at the end.
6. **Subtraction bias.** Every phase must delete/simplify more entrypoint logic than it
   adds. If a phase's diff grows the entrypoint, that's a signal the approach is wrong for
   this migration, not a detail to accept.

---

## 2. Conflicts from the critique round — resolved

Each is stated as: the conflict, the decision, the reasoning, who yields.

### 2.1 Auto-rechown vs. confirmation gate on host-swap
**Conflict:** containers, bindmounts, and migration's drafts all described host-change
reconciliation as fully automatic ("re-chown whenever resolved UID/GID differs, every
start"). portability's draft required an explicit `--adopt-host` confirmation gate,
arguing silent auto-rechown on an unfamiliar host is a security bug (a stranger's local uid
could silently inherit read/write on the user's secrets tree).

**Decision: adopt portability's two-path model exactly.**
- **Same-host drift** (ownership mismatch but the recorded host fingerprint in
  `state/host-identity.json` is unchanged or absent) → auto-repair, narrow and silent, via
  the existing `repairRootOwnedBindMounts`-class mechanism. This should become rare to the
  point of near-dead code once Option 1 lands, since nothing should write as root anymore;
  if it fires often post-migration that's a signal a container still root-writes something,
  not a signal to make the repair fancier.
- **Cross-host swap** (recorded fingerprint differs from the live-resolved host) → **hard
  block**, print a diagnostic, require one explicit `openpalm start --adopt-host` (or
  `--readonly` to proceed without re-owning, accepting writes will fail). This is a single
  approval gate per swap event, not a per-file/per-boot prompt — the moral equivalent of
  SSH's host-key-changed prompt.

**Reasoning containers/bindmounts/migration yield to portability on:** a portable drive's
entire premise is "gets plugged into hosts we don't control." Treating a resolved-uid
mismatch as sufficient to *act* destructively is the wrong default specifically because the
attacker/mistake model (unfamiliar host, wrong local user) is now in scope in a way it never
was for a single-fixed-host install.

### 2.2 Comparison baseline: cached `stack.env` value vs. live on-disk ownership
**Conflict:** migration's Phase 3 compared the *recorded* `OP_UID:OP_GID` in
`state/stack.state.env` against the live `resolveOperatorIds()` result. portability's draft
required comparing the live-resolved value against **actual on-disk ownership of canary
paths** (`state/stack.state.env`, `knowledge/env/user.env`, `workspace/`), treating the
cached env value as advisory/debug-only, never authoritative.

**Decision: adopt portability's design.** `stack.env`'s `OP_UID`/`OP_GID` fields become
cache/debug-display only. The correctness decision is always: stat canary paths on disk,
compare their owning uid/gid to the freshly-resolved `resolveOperatorIds()` result for this
session. Migration's draft explicitly yields here in its own critique — comparing two
*declared* values can both be stale/wrong in the same way (e.g. if `stack.env` itself was
copied incorrectly); comparing against ground-truth file ownership is tamper- and
staleness-resistant and is a net simplification (deletes a load-bearing trust in a cached
value) rather than new machinery.

`host-identity.json` (new artifact, lives under `state/`, not a secret, needs no `0600`
treatment) records the last-seen host's kind/uid/gid purely to produce a human-readable
diff message in the block/prompt ("host changed from uid 501 (docker-desktop-macos) to
uid 1000 (linux-native)") — it is never consulted for the correctness decision itself, only
for UX.

### 2.3 `data/rollback/` vs. `data/backups/` — which stays bind-mounted
**Conflict:** bindmounts' draft classified `data/rollback/` (transient staging scratch used
*during* a rollback operation) as a named-volume candidate. migration's own Rollback Plan
section then referenced "the existing rollback data path noted under `data/rollback/`,
which is why that path stays available even after Phase 3's migration" — implying it needs
to remain bind-mounted, which contradicts migration's own classification table.

**Decision:** this was an internal error in migration's prose, not a real disagreement.
- `data/backups/` (the install system's actual pre-upgrade snapshot **content**) — **stays
  bind mount.** This is the tree a user needs after a host-swap when something breaks on
  the new host ("my upgrade broke something, restore what worked before"). Named-volume
  here would mean rollback silently stops working exactly when it's most needed.
- `data/rollback/` (transient staging/scratch used *while* a rollback is actively running —
  extracted/staged files mid-operation, not the archived snapshots) — **named volume.** A
  rollback snapshot's staging area from host A isn't meaningfully resumable on host B
  anyway (different container images/versions may be running); safe to lose, safe to
  regenerate on the next rollback attempt.
- Migration's Rollback Plan prose is corrected to cite `data/backups/` as the path that
  "stays available even after Phase 3's migration," not `data/rollback/`.

### 2.4 `data/setup/` disposition
No real conflict — bindmounts and migration both agreed named-volume, with the caveat
(made explicit here per portability's cross-critique) that this is only safe **because**
`OP_SETUP_COMPLETE` lives in `state/stack.state.env` (a bind mount). If a future change ever
decoupled setup-completion tracking from `state/`, this disposition would need revisiting —
recorded here explicitly so it isn't silently decoupled later.
**Decision: named volume** (`op_setup_scratch`).

### 2.5 Default disposition for unaudited `data/*` subtrees (portal, voice-runtime, assistant, guardian, api, ui)
**Conflict:** migration's table defaulted `data/portal/` and `data/voice/` "runtime data,
not models" to named-volume ("confirm nothing user-facing lives here first" — i.e., burden
of proof placed on discovering it's *not* safe). bindmounts and portability both defaulted
these (and `data/assistant/`, `data/guardian/`, `data/api/`, `data/ui/`) to **bind-mount,
flagged ambiguous, default preserve** — burden of proof placed on discovering it *is* safe
to discard.

**Decision: adopt bindmounts/portability's direction — conservative default is bind-mount
until Phase 0's audit proves a specific sub-path is pure regenerable scratch.** This is a
direct application of the reversal-cost test from the standing user policy: guessing
"named volume" and being wrong is silent, irreversible data loss (session/auth state,
troubleshooting history) the moment the tree is Docker-daemon-local and the drive moves
hosts; guessing "bind-mount" and being wrong costs only an unnecessary chown pass on a
cache tree. Migration's draft is corrected to match; its classification table entries for
`data/portal/` and `data/voice/` runtime-data move to the bind-mount/ambiguous bucket
pending Phase 0 audit.

Additionally: migration's separate row for `data/voice/` "runtime data, not models" implied
a subtree split (models vs. runtime) that was never named concretely by any draft. **Phase 0
must explicitly identify and name any such split** (e.g. `data/voice/models/` vs.
`data/voice/runtime/`) before Phase 3's migration script can safely move anything — moving
the wrong half here would be exactly the "guessed wrong in the destructive direction"
failure this section exists to prevent.

### 2.6 akm cache/db duplication (`OP_HOME/data/akm/` vs. container-private `/opt/akm/{cache,data}`)
**Conflict:** bindmounts asserted as settled fact that the duplicate storage path should be
eliminated (canonicalize on one copy). migration flagged this as an open Phase 0 audit
question, so the migration had called for explicit confirmation.

**Decision: direction is right, mechanics now confirmed as currently implemented.** The
current compose + entrypoint already mounts and uses both sides:
- `OP_HOME/data/akm/cache` and `OP_HOME/data/akm/data` are mounted into `/opt/akm/cache`
  and `/opt/akm/data` (`packages/skeleton/system/stack/core.compose.yml:87-88`).
- the entrypoint creates `/opt/akm/{cache,data}` and chowns only those container-private paths
  when running as root (`containers/assistant/entrypoint.sh:38-40`, `containers/assistant/entrypoint.sh:42-50`).
- compose adds `/host-stash` as a fallback mount and explicitly says it is never chowned
  (`packages/skeleton/system/stack/core.compose.yml:95-96`).

So duplicate live paths are a confirmed current state, not a hypothetical. A future
consolidation still must keep durable `akm.db` + durable indices canonical under the bind-mounted
`OP_HOME/data/akm/`, and move any cache-split artifact to one explicit side.

**akm embeddings-cache hedge removed:** bindmounts made a firm call (named volume — local
re-embedding is cheap, no external network dependency, unlike LLM/voice model downloads
which hit an external registry and are genuinely expensive to redo). migration's draft
hedged ("unless regeneration cost is high enough to warrant..."). **Decision: adopt the firm
call — named volume, full stop.** Carrying the hedge into implementation just means someone
re-litigates this later with less context than exists now.

### 2.7 Guardian-cache: fix ownership on the named volume vs. delete the runtime install entirely
**Conflict:** bindmounts proposed keeping guardian's runtime `bun install` at
`/opt/openpalm` on first boot and fixing its ownership (pre-chmod `g=u` before `VOLUME`
declaration so a fresh named volume inherits usable permissions). containers proposed going
further: bake dependencies at build time and eliminate the runtime install path entirely,
making the ownership question moot for the common case.

**Decision: adopt containers' recommendation — bake at build time, delete the runtime
install.** This is strictly less machinery (subtraction bias). Current code is not yet there:
Dockerfile forces root startup (`containers/guardian/Dockerfile:31-33`) and entrypoint does
root-time dependency install plus `gosu` re-exec (`containers/guardian/entrypoint.sh:104-123`,
`containers/guardian/entrypoint.sh:136-145`) before server start, so this remains migration
work.

**Residual case, named volume kept:** guardian still performs runtime `bun update`/install paths today
and uses `gosu` handoff (`containers/guardian/entrypoint.sh:104-123`, `136-145`), so the
dynamic-runtime case is confirmed as real today and should be tracked explicitly as a fallback
only if unavoidable.

Docker's preservation of pre-baked ownership/permission bits when initializing a fresh
named volume from an image path is flagged by containers as needing engine-by-engine
confirmation (Docker Engine does; Docker Desktop/OrbStack/Podman need verification) —
**this verification is scheduled into Phase 0's smoke-test matrix** (per portability's
critique that this is a likely failure point on the weakest target host, Docker Desktop's
VM-mediated storage), not left as a parenthetical "confirm this" with no owner.

### 2.8 Rollback mechanism: dual-path-in-one-image (`OP_LAYOUT_VERSION` flag) vs. wholesale image repoint
**Conflict:** migration's rollback plan described the previous entrypoint/compose logic as
"not deleted from git history... `OP_LAYOUT_VERSION` flag gates which entrypoint variant
runs" — implying a converted image's entrypoint still contains *both* the old root+gosu
code path and the new rootless path, runtime-selected by a flag. containers' critique
correctly identified this as a direct contradiction of the entire migration's purpose: a
root-conditional branch selected at runtime is exactly the machinery Option 1 exists to
delete, and it would force the CI grep-guard to special-case "gosu is fine if behind
`OP_LAYOUT_VERSION`," defeating the guard.

**Decision: adopt containers' correction.** Rollback of a *container conversion* means
**repoint compose at the previous image tag/digest wholesale** — never a live in-image
branch choosing between root and rootless code paths. Each converted image is single-path,
rootless-only, from the moment its conversion PR merges; "rollback" is an operations action
(redeploy old tag) not a code-path toggle.

`OP_LAYOUT_VERSION` (or equivalent state flag) is repurposed to gate only **data-layout
migration progress** (which named-volume relocations have completed, per Phase 3's
per-path resumable migration) — never entrypoint code-path selection. This distinction is
now explicit and load-bearing: `OP_LAYOUT_VERSION`/`OP_LAYOUT_MIGRATED_PATHS` = data state;
image tag = code state; the two are rolled back independently and neither ever lives inside
a runtime `if root` branch.

### 2.9 GPU supplementary-group GID portability
**New gap, not previously resolved by any draft.** containers flagged that `group_add:
video/render` may be needed for GPU device access under rootless `user:`. portability's
critique correctly noted `video`/`render` GIDs are not guaranteed stable across hosts
(assigned dynamically by udev/distro), so a hardcoded `group_add: "44"` would silently fail
to grant device access on a host where that GID differs — the same class of problem as
`OP_UID`/`OP_GID`, just unaddressed.

**Decision: in scope, but scheduled as a narrow follow-up, not blocking the five-container
conversion.** None of the four containers being converted in Phases 2/4/5 (portal, guardian,
assistant) need GPU access; only ollama-cuda/rocm do, and ollama is already on the target
pattern. Action: add a Phase 1 sub-task (alongside confirming voice/ollama are genuinely
clean) that resolves GPU group GIDs dynamically at host-side pre-create/chown time (look up
the actual `video`/`render` GID on the current host and pass it via `group_add:` templated
from resolved values, the same mechanism class as `resolveOperatorIds()`), rather than
baking a numeric GID into compose. This closes the gap without expanding the scope of the
four non-GPU container conversions.

### 2.10 Assistant's passwordless-sudo-for-agent-root-ops — interim state
**Gap surfaced by migration's critique of containers:** containers deferred designing a
replacement for the sudo mechanism to a follow-up PR/review, but never stated what happens
to the *feature* in the interim (does "agent-run root ops" just silently stop working for N
releases?).

**Decision: this cannot ship as a silent regression.** Phase 5 (assistant conversion) ships
with:
1. Passwordless sudo removed entirely from the image (no sudoers file, no `NOPASSWD` line —
   containers' draft's option 2 sub-variant, host-capability-in-image is the one property
   this migration cannot compromise on).
2. The specific "agent-run root ops" feature is explicitly disabled with a clear runtime
   message when invoked, not silently absorbed/ignored.
3. **Requires an explicit maintainer/user sign-off note in the Phase 5 PR description and
   release notes** — "this release removes host-root capability from the assistant
   container; agent-initiated root operations are disabled pending redesign (tracking
   issue: TBD)." This is a known, named, temporary regression accepted deliberately, not
   discovered by a user after the fact.
4. Its replacement (narrow sudoers allowlist vs. host-side privileged-helper socket, per
   containers' two options) is designed and reviewed as its own follow-up PR, explicitly
   out of scope for the phase that removes the blanket grant.

**Verification status (current code):** passwordless sudo is currently configured in the assistant
image at build time (`containers/assistant/Dockerfile:120-127`), and no direct `sudo` callsites
were found in the checked-in entrypoint script (`containers/assistant/entrypoint.sh`) for this checkout.

### 2.11 Filesystem compatibility guidance and Docker Desktop host-identity handling — unassigned phase homes
**Gap:** portability's original exFAT/NTFS hard-block (§4) and Docker-Desktop-synthetic-uid
handling (§5) appeared in no other draft's phase plan.

**Decision:**
- Filesystem-type detection may still be useful for diagnostics and support, but **no
  filesystem hard-block ships**. OpenPalm must support common Linux, macOS, and Windows
  filesystems rather than refusing to start on exFAT/NTFS-class media.
- The consequence is that later phases must treat filesystem behavior as a matrix to test and
  document: native Linux filesystems, macOS Docker Desktop/OrbStack storage, and Windows
  Docker Desktop/WSL2-hosted storage all need explicit validation rather than being silently
  excluded by policy.
- Docker-Desktop-aware host-identity fingerprinting (fixed synthetic uid per
  `docker_context`, so Docker Desktop restarts don't spuriously look like a host-swap) →
  **Phase 3**, alongside the on-disk canary-stat comparison logic and the `--adopt-host`
  gate, since it's the same mechanism.
- **Resolution:** `resolveOperatorIds()` currently does **not** implement Docker Desktop synthetic
  uid/gid handling. It only prefers `OP_HOME` owner (if non-root), then process ids, and returns
  null if both are root (`packages/lib/src/control-plane/operator-ids.ts:36-74`). The
  "voice/ollama already on the target pattern" claim is therefore currently validated only by
  native Linux path behavior in this function, not by any desktop-context mapping.

### 2.12 Canonical bind-mount list feeding three different consumers
**Gap:** containers' smoke tests, bindmounts' classification table, and portability's
re-chown scope each need "the list of bind-mounted OP_HOME trees" but no draft treated it
as one shared artifact.

**Decision:** the disposition table in section 3 below **is** that single canonical list.
It is the input to: (a) the Phase 0 CI smoke-test matrix (assert no root-owned files appear
under any bind-mounted path after boot), (b) the `--adopt-host` re-chown scope (only these
paths get recursively re-chowned, never named-volume paths, never container-private paths),
and (c) the data-relocation migration script's move-list. One list, three consumers — not
three independently-maintained approximations of the same list.

### 2.13 Named volumes are never touched by host-swap reconciliation
**Clarification requested by migration's critique of containers:** guardian-cache and the
opencode-state volumes are named volumes, not OP_HOME bind mounts — someone could wrongly
fold them into the host-swap re-chown sweep. **Explicit rule, stated once:** the
`--adopt-host` re-chown pass operates *exclusively* on the bind-mount paths listed in
section 3's "stays under OP_HOME" column. Named volumes are Docker's problem, not
`resolveOperatorIds()`'s — they get a fresh, empty (or self-healing per §2.7) start on every
new host by construction, and are explicitly out of scope for any chown logic.

---

## 3. Directory disposition (canonical, single source of truth)

### Stays bind-mounted under OP_HOME (travels with the drive)

| Path | Reason |
|---|---|
| `system/{stack,assistant,guardian}/` | Compose files + baked config the CLI itself reads to know what to start — the stack cannot boot without these physically present on whatever host is running `openpalm start`. |
| `config/{stack,assistant,guardian,akm}/` | User-editable config, already documented in README.md as user-facing; losing it on host-swap silently resets configuration to defaults. |
| `state/stack.state.env` (+ new `state/host-identity.json`) | `OP_SETUP_COMPLETE` traveling with the drive is what makes host-swap feel like "plug in and it works" instead of re-running setup; `host-identity.json` is the new host-swap-detection UX artifact. |
| `knowledge/{secrets,wikis,memories,env,skills,tasks}/` | Core user data: secrets, conversation memories, user-authored skills/tasks. Named-volume here would be silent, catastrophic data loss (tokens/secrets vanish and regenerate as new random values on host-swap, breaking every external integration with no error). Non-negotiable. |
| `data/portal/` | Unverified; default bind-mount per reversal-cost test until Phase 0 audit proves it's pure ephemeral queue state. |
| `data/voice/` | Bind-mount overall; model-weight subtree (once named per Phase 0's split) gets the relaxed-permission/content-addressed treatment (§4). |
| `data/logs/` | Guardian audit logs + others — the core invariant explicitly requires host-visible logs; also needed by homelab operators for incident review after a host move. |
| `data/assistant/` | Unverified; flagged ambiguous, default preserve — may hold session/tool-call state adjacent to `workspace/` a user expects to survive a host swap. |
| `data/guardian/` | Unverified; flagged ambiguous, default preserve — likely adjacent to audit/session state. |
| `data/api/` | Unverified; flagged ambiguous, default preserve — may include job/troubleshooting history. |
| `data/ollama/` | Bind-mount overall; model-blob subtree gets the relaxed-permission/content-addressed treatment (§4) — re-downloading multi-GB models on every host-swap is a real usability regression. |
| `data/akm/` — `akm.db` + durable indices only | User's tasks/memories/skill-usage history; canonical, durable data. (Embeddings cache half moves out — see moves table.) |
| `data/backups/` | The install system's actual pre-upgrade snapshot content — the safety net a user needs specifically right after a host move if something breaks on the new host. |
| `data/ui/` | Unverified; flagged ambiguous, default preserve. |
| `workspace/` | The assistant's actual project files/git repos — the single most important human-facing tree, unambiguous, highest priority. |
| `package.json`, `manifest.json`, `.skeleton-version`, `README.md`, `openpalm.sh`/`.ps1` | Install package metadata and entry-point scripts — what `openpalm start` *is*; must be on the drive for the CLI to function on any host. |

### Moves to Docker-managed named volume (host-local, does not travel, regenerates)

| Path | Named volume | Reason |
|---|---|---|
| `data/setup/` | `op_setup_scratch` | Install-lifecycle scratch; safe because `OP_SETUP_COMPLETE` (the thing that actually matters for "does this host think setup is done") lives in bind-mounted `state/`, not here. |
| `data/rollback/` | `op_rollback_staging` | Transient staging area used *while* a rollback runs, not the archived snapshots (those are `data/backups/`, which stays bind-mounted). Not meaningfully resumable across a host-swap anyway. |
| `data/akm/` embeddings cache (split from `akm.db`) | `op_akm_embeddings_cache` | Local re-embedding is cheap and has no external dependency (unlike LLM/voice model downloads which hit an external registry) — firm decision, not hedged. |
| container-private `/opt/akm/cache`, `/opt/akm/data` | `op_akm_cache` (existing) | Current compose+entrypoint mounts create a confirmed duplicate with bind-mounted `OP_HOME/data/akm/*` (`packages/skeleton/system/stack/core.compose.yml:87-88`, `containers/assistant/entrypoint.sh:38-40`). Planned migration should resolve to a single canonical side explicitly. |
| guardian `.local/share/opencode`, `.local/state/opencode` | existing named volume (already fixed narrowly in 8b0c3a00) | Moderator's OpenCode scratch storage; never a portability requirement. Once host-side pre-create+chown (§5) exists, the narrow non-recursive 8b0c3a00 fix becomes redundant and should be deleted, not kept alongside the new mechanism. |
| `/opt/openpalm` guardian-cache | existing named volume, `op_guardian_cache` | Current target is to keep build-time artifacts and remove runtime install (`containers/guardian/Dockerfile:31-33`, `containers/guardian/entrypoint.sh:104-123`, `136-145`), with this volume retained only for any residual dynamic-install case. |

---

## 4. Expensive-to-regenerate caches: a third class, not a binary choice

`data/ollama/` model blobs and `data/voice/` model weights are **bind-mounted** (they must
travel — re-downloading multi-GB models on every host-swap is a real regression against
the portability goal, and there's no other tree they could canonically move to without
losing that property) but are **not** treated like `workspace/` or `knowledge/`:

- Content-addressed layout (filenames keyed by hash/model-id, matching Ollama's own blob
  store convention already) so files are immutable and trivially re-derivable if truly
  lost.
- Directory mode `755`, file mode `644` — not `OP_UID`-owned in the strict single-owner
  sense, and explicitly **excluded from the per-host chown pass** (§2.1/§2.13): reads
  dominate (99% of container interaction with this tree is read-only), writes only happen
  on a rare fresh model pull, so host-swap ownership friction is minimal even without
  reconciling ownership on every boot.
- This is a distinct permission class from `knowledge/secrets/`, which keeps `0600`/`0700`
  regardless of this convention.

The akm embeddings cache does **not** get this treatment (it's a named volume, per §2.6) —
it's cheap enough to regenerate that the model-cache tradeoff doesn't apply.

---

## 5. Container conversion plan (Option 1: uniform rootless)

### 5.1 Guiding rule, every container
No `USER root` at runtime. No gosu, no `usermod`/`groupmod`, no root-conditional branch in
any entrypoint. Exactly one identity mechanism: compose `user: "${OP_UID:-1000}:${OP_GID:-1000}"`
plus images whose application files are group-writable (`chmod -R g=u`, "arbitrary UID"
convention). Because OpenPalm must support common Linux, macOS, and Windows filesystems,
later phases cannot assume a preflight filesystem gate will reject awkward media for us.
Behavior under those filesystems needs to be tested, documented, and where necessary handled
with explicit degraded-mode rules rather than hidden assumptions.

### 5.2 Conversion order (unchanged from migration's draft — no critique disputed the
ordering itself, only what happens within guardian/assistant's phases)

1. **voice** — already on target pattern. Confirm clean, use as reference implementation.
2. **ollama** (+ cuda/rocm variants) — already on target pattern. Confirm clean; resolve
   GPU `group_add` GIDs dynamically per-host (§2.9) as part of this phase, not hardcoded.
3. **portal** — simplest remaining container, no root logic today. Add `user:` directive,
   confirm group-writable image paths. Lowest risk: nothing to regress mid-entrypoint
   because there's no entrypoint branching today.
4. **guardian** — bigger lift (whole-script root+gosu re-exec, no named user, has been
   mis-fixed at least 3 times in git history including a same-week `user:` add-then-revert).
   Converted before assistant because it's the container most directly touched by
   in-flight guardian-pro OIDC work (opp#4) — land the rootless conversion before more auth
   surface gets built on the current root+gosu guardian, not after. Includes: delete
   whole-script re-exec, add named non-root user + `user:` directive, bake `bun install`
   deps at build time (§2.7), pre-chmod `/opt/openpalm` before `VOLUME` declaration, delete
   the narrow 8b0c3a00 opencode fix once host-side pre-chown supersedes it. Explicit
   re-verification: guardian must not gain any new ability to read secrets it couldn't
   read before — group-writable image convention never extends to `knowledge/secrets/`.
5. **assistant** — last, deliberately: most complex entrypoint (317 lines, should shrink not
   grow), fixes openpalm#541 (`akm tasks sync` un-gosu'd write — becomes structurally
   impossible once there's no root phase to skip gosu from), and carries the
   passwordless-sudo redesign (§2.10) as an explicitly-flagged, signed-off interim
   regression rather than a silent one. Cron replacement decision (forced now, not left
   open for Phase 5 implementation to relitigate): **non-root user-crontab** (`crontab`
   under the app user) if the assistant genuinely needs calendar-style scheduling beyond a
   fixed interval; otherwise **a plain in-process sleep-loop** for the single known case
   (`akm tasks sync` on an interval) — no root crond either way. Default to the sleep-loop
   unless Phase 0's audit finds another cron consumer that needs real crontab semantics.

### 5.3 Runtime-root-only steps → build-time or install-time

| Step | Today | Target |
|---|---|---|
| sshd host-key gen (assistant, if applicable) | runtime, root | build-time bake, or install-time host-side pre-generation into a bind-mounted secrets-style path before first boot |
| guardian `bun install` at `/opt/openpalm` | first-boot, root-then-gosu | build-time bake (default); runtime-as-non-root against pre-chowned dir only for the confirmed residual dynamic-plugin case (§2.7) |
| akm schema migration | presumably runtime | run once at install/update time via host-side control-plane tooling invoking the container's migration command as the non-root target user, not on every boot as root |
| cron setup (assistant) | runtime, likely root crond | build-time: no crond in image; runtime: non-root sleep-loop (default) or non-root user-crontab, decided per §5.2 |
| `akm tasks sync` writing `config/akm/config.json` | runtime, un-gosu'd (bug #541) | runtime, always as the single non-root user — bug disappears structurally |

---

## 6. Host-side ownership mechanism (single mechanism, replaces every ad hoc chown)

Extend `ensureComposeVolumeTargets`/`chownVolumeTarget` (config-persistence.ts) and
`resolveOperatorIds` (operator-ids.ts) to be the **only** place ownership is ever
reconciled — collapsing the five independently-reinvented "root-then-chown-then-gosu"
patterns the audit found into one code path.

1. **Filesystem compatibility diagnostics (Phase 0+).** `openpalm install`/`start` may detect
   the filesystem OP_HOME lives on for supportability and future UX, but it does not
   hard-block common Linux, macOS, or Windows filesystems. Compatibility issues should be
   handled through tests, targeted warnings, and later ownership-reconciliation logic.
2. **On every `openpalm start` (not just fresh install):** resolve `OP_UID`/`OP_GID` fresh
   for this session (§2.2 — never trust a persisted value as authoritative). Stat the
   canary paths. Compare against actual on-disk ownership.
3. **Match** → proceed, no-op.
4. **Mismatch, host-identity fingerprint unchanged or absent** → same-host drift, run the
   narrow, silent `repairRootOwnedBindMounts`-class auto-repair (this should be structurally
   rare post-migration).
5. **Mismatch, host-identity fingerprint changed** → host swap detected. Block. Print the
   diagnostic (old host kind/uid → new host kind/uid, using the cached `host-identity.json`
   purely for display). Require `--adopt-host` (re-chown every bind-mounted tree in
   section 3's "stays under OP_HOME" list, exactly those paths and no others — never
   named volumes, per §2.13; never the model-cache relaxed-permission subtrees, per §4) or
   `--readonly` (proceed without re-owning; writes fail until adopted).
6. **Ordering:** this entire pass completes fully before `docker compose up` is invoked —
   replaces every runtime root-then-chown branch, including guardian's opencode nested-mount
   case and assistant's #541 case, both of which existed purely because chown happened too
   late (in-container, at/after boot) instead of too early (host-side, before compose
   starts).
7. **Secrets get their own stricter sub-path within the same mechanism:** `knowledge/secrets/`
   is chowned to `OP_UID:OP_GID` and set to `0700`/`0600` explicitly — never the looser
   `g=u`/`0775` applied to general bind-mount trees like `workspace/`/`config/`. This is a
   distinct code branch inside the same mechanism, not a separate system.
8. **Docker Desktop / OrbStack handling:** `resolveOperatorIds()` must resolve a stable
   synthetic uid/gid keyed on `docker_context` (e.g. `desktop-linux`) so Docker Desktop VM
   restarts don't spuriously register as a host-swap. Current implementation does not yet do this
   (`packages/lib/src/control-plane/operator-ids.ts:36-74`), so this remains a planned addition.
   In the meantime, document plainly that Docker Desktop/OrbStack/WSL2 remain lower-confidence
   ownership environments due to VM-mediated uid/ownership translation (VirtioFS/gRPC-FUSE has a
   documented history of ownership-preservation quirks) and may require more frequent warnings,
   repair passes, or swap-block prompts.

---

## 7. Upgrade path for existing installs (no flag day)

1. On `openpalm update`/`start` against an OP_HOME created under the old root+gosu regime,
   run a one-time migration gated by a new `state/stack.state.env` flag
   (`OP_ROOTLESS_MIGRATED=1`):
   - Recursively chown existing bind-mounted trees (section 3's list) to the resolved
     `OP_UID:OP_GID` via the host-side mechanism (§6) — this is the one-time cleanup for
     files currently root-owned from the old regime.
   - Set the flag so subsequent starts only do the lightweight drift/swap check, not a full
     recursive chown every time.
2. **Data relocation (Option 3 moves) — separate PR from any container conversion,** its
   own resumable, idempotent, per-path migration:
   - For each path in section 3's "moves to named volume" table: **copy** (never move) into
     the new named volume, verify (size/checksum), then leave the original in place renamed
     `.migrated-<timestamp>` — never auto-deleted. Actual deletion of `.migrated-*`
     leftovers is a separate, explicit, user-approved cleanup step, later, never bundled
     into automatic migration (per the standing no-destructive-ops-without-per-path-approval
     policy).
   - Track per-path completion (`OP_LAYOUT_MIGRATED_PATHS=...`) so a partial failure (disk
     full, permission denied, container running mid-copy) leaves the stack still bootable
     on the old layout for any not-yet-migrated path; re-running only touches incomplete
     paths.
   - `--dry-run` mode reports what would move and how much data before writing anything.
3. **Image/entrypoint rollback is independent of data migration:** because data relocation
   copies rather than moves and never auto-deletes, rolling back a container conversion
   (repoint compose at the previous image tag, per §2.8) never requires reversing a data
   migration — the old bind-mount data is still exactly where it was.
4. Ship each converted image alongside the previous tag for one release cycle so a
   mid-upgrade rollback doesn't strand a partially-migrated tree against an incompatible
   image; remove the old gosu/root-era image entirely once `OP_ROOTLESS_MIGRATED=1` is
   confirmed universally set across supported instances.

---

## 8. Phase sequence (each independently shippable, ~7-8 small PRs)

Every phase is gated on: tests green AND the diff deletes/simplifies more than it adds.

- **Phase 0 — Audit + test harness + guardrails (no runtime behavior change).**
  - `OP_HOME/data/akm` ↔ `/opt/akm/{cache,data}` duplicate is already confirmed in current code
    (`core.compose.yml:87-88`, `containers/assistant/entrypoint.sh:38-40`), so Phase 0
    focuses on migration execution rather than discovery.
  - Guardian runtime install + `gosu` flow is confirmed active (`containers/guardian/Dockerfile:31-33`,
    `containers/guardian/entrypoint.sh:104-123`, `136-145`) and should be explicitly folded into the
    conversion plan in Phase 4.
  - Name the concrete `data/voice/` models-vs-runtime split (§2.5) if one exists.
  - Confirm `resolveOperatorIds()` remains non-desktop-aware (`packages/lib/src/control-plane/operator-ids.ts:36-74`) so Phase 3 can
    implement synthetic desktop handling deliberately.
  - Do not ship a filesystem startup/install hard gate; keep filesystem work diagnostic-only.
  - Replace the old gate idea with a compatibility matrix: native Linux filesystems, macOS
    Docker Desktop/OrbStack storage, and Windows Docker Desktop/WSL2 storage each need an
    explicit validation plan.
  - Ship the CI static grep-guard: fail if any Dockerfile under `containers/*` has `USER root`
    as its final active directive, or any entrypoint contains `gosu` without a `user:`
    fallback.
  - Ship the per-container bats boot-smoke-test: boot each container against a scratch
    OP_HOME, assert `find $OP_HOME -newer <marker> -user root` is empty after boot. Wire as
    a CI matrix over the five containers, `expected-fail` for guardian/assistant until
    their phases land, then flipped to required.

- **Phase 1 — voice + ollama: confirm and template.** Flip their smoke tests to required.
  Extract the shared host-side pre-create+chown helper fully into
  `config-persistence.ts` if not already unified. Resolve GPU `group_add` GIDs dynamically
  per-host (§2.9). Add the first explicit filesystem-compatibility validation pass here because
  these services are already closest to the target rootless pattern and provide the reference
  behavior for later phases.

- **Phase 2 — portal rootless conversion.** Add `user:` directive, confirm group-writable
  image paths, flip smoke test to required. Add explicit coverage for bind-mounted
  `data/portal/tools` behavior under the supported cross-platform filesystem matrix.
  Independently shippable.

- **Phase 3 — Data-relocation migration script + host-swap reconciliation.** Ships the
  copy-then-mark-migrated-never-auto-delete data mover (§7.2), the on-disk-canary-stat
  comparison and `--adopt-host` gate (§6.2–6.5), and the Docker-Desktop-aware
  host-identity fingerprinting (§6.8). This phase now owns most of the filesystem-specific UX:
  targeted warnings, degraded-mode behavior, same-host repair, and cross-host prompts across the
  supported Linux/macOS/Windows storage environments. This is the riskiest phase for existing
  instances and is deliberately separate from any container conversion so it can be tested/
  rolled out on its own cadence.

- **Phase 4 — guardian rootless conversion.** Per §5.2: delete root+gosu re-exec, add
  `user:`, bake deps at build time, pre-chmod before `VOLUME`, delete the superseded
  8b0c3a00 narrow fix, explicit secrets-contract re-verification. Given this container's
  history of mis-fixed rootless attempts, the Phase 0 smoke test passing is a required merge
  gate, not a manual check. Include guardian-cache and bind-mounted tools-path verification on
  the supported filesystem matrix. Flip smoke test to required.

- **Phase 5 — assistant rootless conversion.** Delete root+gosu branches (entrypoint should
  shrink), fix #541 as part of the same change (same root cause, not separately), remove
  passwordless sudo with the explicit signed-off interim regression note (§2.10), decide and
  implement the cron replacement (§5.2). This phase must explicitly validate `workspace/`,
  `knowledge/`, and `data/akm/` behavior on the supported filesystem matrix because the assistant
  is the widest writer to user-owned storage. Flip smoke test to required — at this point the
  full five-container Phase 0 matrix is required.

- **Phase 6 — end-to-end thumbdrive acceptance test.** Wire Phase 3's reconciliation into the
  documented `openpalm start` flow so it's invoked on every boot, not just implemented. Add
  the acceptance test: boot on host A, stop, copy OP_HOME to a second machine (different
  UID/host kind), boot on host B **without** `--adopt-host` and assert it's blocked (this
  assertion was missing from migration's original Phase 6 description and is now required,
  per portability's critique), then boot **with** `--adopt-host` and assert smoke tests pass
  and no data was lost. Expand this to a cross-platform acceptance matrix: native Linux and the
  supported macOS/Windows Docker Desktop-style environments must each document expected behavior,
  caveats, and any degraded ownership UX. This is the acceptance gate for calling the migration
  "done," not just the happy path.

---

## 9. Test coverage additions (closes the confirmed zero-coverage gap)

1. CI static grep-guard forbidding `gosu`, `usermod`, `groupmod`, and a final `USER root`
   directive across all five Dockerfiles (Phase 0).
2. Per-container bats boot-smoke-test asserting no root-owned files appear under any
   bind-mounted OP_HOME path after boot, matrixed across all five containers (Phase 0,
   flipped to required as each container's phase lands).
3. Filesystem compatibility coverage: ensure install/start is not blanket-blocked on common
   Linux, macOS, or Windows filesystems, treat filesystem detection as diagnostic rather than
   fatal, and record per-environment expected ownership behavior (Phase 0+).
4. Un-mocked test for `ensureComposeVolumeTargets`/`chownVolumeTarget`: real tmp directory
   tree, synthetic UID/GID, assert resulting file modes — including the secrets-tree
   stricter sub-path (`0600`/`0700` never relaxed) (Phase 3).
5. Host-identity comparison unit test, pure logic: fixture JSON in, decision out
   (match/drift/swap), no containers needed (Phase 3).
6. Drift-vs-swap simulation test: same-host mismatch auto-repairs silently; cross-host
   mismatch blocks and requires `--adopt-host` before start proceeds (Phase 3).
7. Data-relocation migration tests: dry-run reporting accuracy, checksum-verified copy,
   resumability after simulated partial failure (kill mid-copy, re-run only touches
   incomplete paths), never-auto-delete-of-`.migrated-*` assertion (Phase 3).
8. End-to-end host-move acceptance test per Phase 6, including the negative case (blocked
   without `--adopt-host`), not just the happy path.
9. Explicitly out of CI scope: real Docker Desktop/OrbStack/WSL2 uid-translation behavior —
   document as a manual pre-release check per release, relying on the fail-safe (block + prompt)
   design rather than fail-silent (wrong ownership) if those environments surprise us.

---

## 10. Open risks and unresolved items carried forward explicitly

- **Verification debt now reduced:** phase-0 items for `akm` mirror status and
  guardian runtime-install reality were confirmed against the actual source in this checkout.
  Remaining unresolved items are tracked below: concrete `data/voice/` models-vs-runtime split
  naming, and whether any other subtrees in `data/*` (`portal`, `api`, `ui`) contain non-obvious
  durable state that should remain bind-mounted.
- **Ambiguous `data/*` subtrees** (`portal`, `assistant`, `guardian`, `api`, `ui`) are
  bind-mounted by conservative default, not because they're confirmed to hold irreplaceable
  data — Phase 0 should schedule a real inventory of what's written to each, so the
  "flagged ambiguous, default preserve" state doesn't become permanent by inertia.
  Reclassifying any of them to a named volume later is safe (in the low-risk direction);
  discovering one holds real user data after wrongly moving it would not be.
- **Assistant's sudo replacement** (narrow allowlist vs. host-side privileged helper) is
  deliberately undesigned in this plan — it needs its own review, its own threat-model
  discussion, and explicit maintainer sign-off before Phase 5 ships, not a default chosen
  by inertia during implementation.
- **Docker Desktop and cross-host portability remain lower-confidence targets.** This plan no
  longer relies on refusing non-ext4/APFS media up front, so later phases need stronger real
  compatibility coverage across the filesystems users actually run on Linux, macOS, and
  Windows. This should be stated plainly in user-facing docs, not discovered by users the hard
  way.
- **Cross-platform filesystem support increases the burden on Phase 3 and Phase 6.** The removed
  hard gate means the migration now succeeds or fails on the quality of ownership repair,
  warning UX, and documented degraded-mode behavior, not on early exclusion of awkward media.
- **GPU device-group portability (§2.9)** is scoped narrowly to a dynamic-GID-resolution
  fix for ollama-cuda/rocm; if assistant or guardian ever gain GPU access in the future, this
  same fix needs to be re-applied there — flagged so it isn't silently skipped when that
  happens.
