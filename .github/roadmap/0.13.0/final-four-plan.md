# 0.13.0 Final-Four Implementation Plan — #586, #585, #581, #577

_Prepared 2026-07-27 against `main` @ `a010c01e` (post-#584 "public-seams review" merge).
Method: one deep-dive investigation agent per issue grounded in the current working
tree, each followed by an independent adversarial verification agent that re-opened
every cited file and attempted to refute the draft. All four plans returned
**sound-with-corrections**; the corrections are folded in below. Every file:line
citation was verified against the current tree; older line-number citations must
not be trusted._

**Headline findings:**

1. **#577 is already fully implemented in `main`** (commit `f78c32ef`, ancestor of
   HEAD). Both U1 and U2 plus all four required test categories exist and pass
   (88/88 vitest, `ui:check` clean). The issue should be closed; one optional
   ~3-line hardening is recommended (empirically-proven latent staleness gap).
2. **#585 is release-blocking, and its fix is deletion.** `0.13.0-beta.13`
   predates the #584 merge, so the image-baked-only model has never shipped; a
   release tagged before this lands makes every subsequent upgrade serve stale
   artifacts. A root-cause audit replaced the planned reseed module with
   **removing the three named volumes over `/opt/openpalm` entirely** — nothing
   there must survive container recreation, and the stale volume is itself what
   makes the guardian re-fetch packages from npm after every upgrade.
   Together with the image-footprint work it takes a default install from
   ~7 GB at rest and ~11.8 GB peak-during-upgrade to ~2.5 GB with a negligible
   peak, and cuts upgrade pulls from ~3.3 GB to ~25 MB.
3. **#581 is ~80% landed** by #584 (E2/S2 image-baked, S4 first pass, S5 backup
   lifecycle, S6 preflight, S7 doctor reaper, S8 storage report, S3 lib module).
   The remainder is: the deferred S1 cache relocation (commit `921412b1`), S3 live
   wiring + visibility, and a set of small verified defects + doc corrections.
4. **#586 is a self-contained guardian redesign** (schema v3→v4) that must land
   **before** #581's `doctor --prune-sessions` wiring so the two session-deleting
   writers are both correct and attributable.

## Decisions recorded (2026-07-27, maintainer)

| # | Decision | Ruling |
|---|---|---|
| 586-1 | Sweep finds an evicted session still active upstream | **Restore the ownership row** from the retained `principal_key`; deferring alone leaves the user 403'd and only postpones deletion |
| 586-2 | `GUARDIAN_SESSION_ACTIVE_GRACE_MS` default | **24 hours** |
| 586-3 | Compose env plumbing for guardian knobs | **Grace + reconcile interval only** (`${VAR:-default}` pattern); caps stay compile-time internals |
| 586-4 | Acceptance-criterion-1 coverage | **Build a handleProxy test harness** (Bun.serve stub assistant + seeded principal) **plus** a corrected manual real-stack checklist in the PR |
| 585-3 | Seed records at fresh install | **Skip** — accept one redundant reseed per install lifetime |
| 585-4 | Upgrade smoke depth | **Drive `performUpgrade` end-to-end** against local `:dev` images |
| 581-S1 | Cache location | **`${OP_HOME}/cache/{assistant,guardian}` host binds**, pre-created operator-owned by `ensureHomeDirs`, no env knob. Companions are mandatory: exclude `cache/` from backups + the space estimate, add it to `uninstall --purge`, amend the filesystem contract in `core-principles.md` |
| 581-caps | Cache size/age caps | **Descoped** — purge-on-demand (`doctor --clean-caches`) + the disk-headroom preflight cover the failure mode; no background reaper |
| 581-prune | `ui-*`/`skeleton-*` snapshot accumulation | **Auto-prune each namespace to 3** after a successful bundle update; ships together with the doc correction |
| 581-task | Scheduled session retention | **Ship `session-maintenance.yml` disabled** (health-check.yml precedent); executor must call OpenCode's REST API **in-container** — the host CLI does not exist there |
| 581-ui | Bulk session visibility | **CLI only this round** (`doctor --sessions`); UI `parentID`/paging is its own issue |
| 577 | U2 probe-cache staleness | **Apply the 3-line invalidation + failing-test-first**, restricted to the three connection-mutating wrapper methods |

### Decisions from the two root-cause audits (2026-07-27)

The reseed design was rejected and replaced. Both audits ran four investigation
strands with adversarial verification; findings are measured, not estimated.

| # | Decision | Ruling |
|---|---|---|
| 585-A | The three named volumes over `/opt/openpalm` | **Delete all three mounts.** Nothing under `/opt/openpalm` must survive container recreation — audit confirmed across all four strands |
| 585-B | Orphaned volumes on existing installs | **Reap automatically during the upgrade** (closed list of retired names, current project only, logged) |
| IMG-1 | Four AI coding CLIs (~891 MB) | **Remove**, and ship install scripts the assistant can run on request |
| IMG-2 | On-demand install mechanism | **One akm skill** with a small manifest, installing into `/opt/persistent` |
| IMG-3 | Google Cloud SDK (~550 MB) | **Remove entirely**; `gws-setup` installs it on first use via the same skill |
| IMG-4 | Duplicate OpenCode binaries | **Drop musl + baseline** (~482 MB guardian, ~168 MB assistant); document an AVX2-era minimum CPU |
| IMG-5 | Speculative CLI tooling | **Keep `gh`, `uv`, `jq`, `sqlite3`**; drop `postgresql-client`/`libpq` and the dead `libglib` (~16 MB) |
| IMG-6 | Upgrade data movement | **Fix both**: reorder the version ARG below the heavy layers (~3.3 GB → ~25 MB per upgrade) **and** teach the retention reporter to attribute untagged predecessors |
| IMG-7 | Container logs | **Cap at 10 MB × 3 files per service** (unbounded today) |
| 581-disk | Documented minimum disk | **Per-configuration breakdown**, not one number — and the numbers go *down* |
| SEQ | Volume fix vs image slimming | **Ship together as one image transition** |

> **Recorded risk on SEQ.** I recommended splitting, because the volume removal
> is release-blocking and self-contained while the slimming needs a real build
> and smoke cycle. Shipping together means a build regression in the slimming
> work delays the blocking fix. Mitigation adopted: do the volume change first
> and get it green on its own before the slimming lands on top, so it can be
> split late if the build work slips.

## Execution model

Same gated test-first pipeline as the rest of the milestone (the
`implement-0-13-0.js` workflow script, since removed with the other workflow
assets): spec → spec review (gate) → failing
tests first (red) → implement (green + gates) → code review (gate) → fix loop.
Repo gates per change: `bun run lint`, `bun run check`, targeted package suites
(`cd packages/guardian && bun test --no-orphans`, `bun run lib:test`,
`bun run cli:test`, `bun run ui:test:unit`), root `bun run test` at phase end.
Hard rules baked into every task: control-plane logic only in `@openpalm/lib`;
file assembly not templating (compose `${VAR}` interpolation is sanctioned);
**never delete user data** (load-bearing for #585 and #581-S1); `execFile` argv
only; guardian-only ingress; no unjustified complexity.

## Sequencing and PR slicing

| PR | Scope | Depends on | Effort |
|----|-------|-----------|--------|
| 1 | **#577** — close issue + cache-invalidation hardening + type-regression pin | nothing | trivial |
| 2 | **#586** — guardian lifecycle-aware eviction/reconciliation (schema v4) | nothing | medium |
| 3 | **#585 + image footprint** — delete the three volume mounts, auto-reap retired volumes, layer reorder, content reductions, on-demand install skill, log caps, predecessor-image attribution | nothing; **must precede next tagged release** | large (one image transition, per SEQ) |
| 4 | **#581 wave 1** — S5 fixes, S6 lib preflight, S8 report additions, S2 residue removal, docs pass, CI contract tests | nothing | small–medium |
| 5 | **#581 wave 2** — S3 live wiring (`doctor --prune-sessions`, `--sessions`, skeleton task) + S1 cache relocation | PR 2 (#586 first); S1 rides PR 3's compose/rootless-smoke transition | medium |

**Internal order inside PR 3** (the SEQ mitigation): land the volume deletion +
reaper + compose/lib cleanup first and get it green on its own, then stack the
image slimming and layer reorder on top. If the build work slips, the blocking
half can still be split out late.

Cross-issue coordination points (do each once, in the PR noted):

- **Volume classification** — `OPENPALM_VOLUME_SUFFIXES`
  (`packages/lib/src/control-plane/image-volume-retention.ts:110`) was going to
  gain `guardian-cache`/`portal-cache` for orphan detection. With the volumes
  deleted, what it needs instead is the **retired-volume list** plus untagged
  predecessor-image attribution (IMG-6). Both live in **PR 3**; #581-S7's
  remainder is satisfied there, not separately. Note the audit's correction:
  `findOrphanVolumes` only flags volumes whose project prefix *differs* from the
  current project, so it could never have seen these — adding suffixes alone
  would not have worked.
- **#586 before `--prune-sessions`** (PR 5): two independent writers DELETE
  upstream sessions via the same REST API; the reconciliation bug must be fixed
  before session retention goes live.
- **S1 relocation rides with #585's compose transition** where possible: both
  touch `core.compose.yml`/`portals.compose.yml` and both need the rootless
  ownership smoke; operators should see one volume/mount transition, not two.
- **#577 is fully independent** (browser-side UI modules only; zero shared files).

---

## #586 — Guardian reconciliation: lifecycle-aware eviction (schema v4)

### Current state (verified landed, commit `fce5e89b`)

- `session_eviction_log` table + v2→v3 migration, `PRAGMA user_version` runner
  with downgrade refusal — `packages/guardian/src/state-db.ts:116-172`.
- Synchronous eviction logging before owner-row delete —
  `state-db.ts:354-383`, called from `recordSessionOwnerRow` at `:400`.
- Async reconciliation sweep (oldest-first, marks reconciled only on confirmed
  upstream DELETE, 404=success) — `packages/guardian/src/reconciliation.ts:58-105`,
  wired in `server.ts:277-287` (boot + every `GUARDIAN_RECONCILE_INTERVAL_MS`,
  default 300 000, `'0'` disables).
- `/stats` exposes `oc_proxy.pending_evicted_sessions` (`server.ts:138`).
- Portal SDK session reuse defaults to `client` (`packages/portal-sdk/src/session-map.ts`,
  `opencode.ts`) — which is exactly why long-lived active sessions with stale
  `created_at` now exist.

### Confirmed defects

- **A (P1):** eviction candidates ordered by `created_at`, never refreshed;
  evicted rows go straight to the upstream DELETE callback
  (`reconciliation.ts:70`) with no activity check — an active conversation can be
  destroyed mid-use.
- **B (P2):** `pruneEvictionLog` (`state-db.ts:331-340`) prefers reconciled rows
  but **still deletes pending rows** once reconciled rows are exhausted — the
  test at `state-db.test.ts:464-490` currently pins this defect.

### Design (three-layer defense for A; structural fix for B)

**Schema v3→v4** (`state-db.ts`): add `last_used_at INTEGER NOT NULL DEFAULT 0`
to `session_owners` + `session_owners_last_used` index; backfill from
`created_at`. The migration step **must sniff** `PRAGMA table_info` and no-op if
the column exists — `createOwnershipTables` is both the v1→v2 migration and the
unconditional configure-time CREATE (`state-db.ts:186`), so on fresh DBs the
v3→v4 ALTER runs against a table that already has the column (same precedent as
`migrateKindConstraintIfNeeded`'s sniff at `:38-48`). Update the fresh-DB DDL
(`:86-91`) to include the column + index (convergence contract, `:184-188`).

**Fix A:**

1. `recordSessionOwnerRow` (`:385-401`): write `last_used_at = createdAt`; extend
   `ON CONFLICT` to `SET last_used_at = excluded.last_used_at`. **Thread the new
   optional params (`activeGraceMs`, `now`) through `recordSessionOwnerRow` into
   `evictOldestSessionOwners`** — it is the only public entry to the eviction
   path (verifier: the draft omitted this and the tests were unwritable).
2. New `touchSessionOwnerRow(sessionId, now?, database?)`; thin
   `ownership.ts` wrapper `touchSessionOwner` (not re-exported from `index.ts` —
   no external consumer). Call it in `proxy.ts` immediately after the
   `ownsSession` gate passes (`proxy.ts:298-304`) — verified single choke point:
   `SESSION_SCOPED_RE` covers message/prompt_async/abort/history/DELETE, and MCP
   + OpenAI-compat edges both flow through `/oc`. Deliberately do **not** touch
   in `event-fanout.ts` (per-frame hot path; frames only flow for sessions being
   driven by touched requests).
3. `evictOldestSessionOwners` (`:354-383`): candidate SELECT becomes
   `WHERE last_used_at <= (now - activeGraceMs) ORDER BY last_used_at ASC,
   session_id ASC LIMIT overflow`. **Soft cap:** when fewer idle candidates than
   overflow exist, evict only the idle ones and emit a structured warn — the
   table may temporarily exceed `GUARDIAN_OWNERSHIP_MAX_ROWS` rather than
   destroy an active conversation (never-delete-user-data outranks table
   hygiene). New `GUARDIAN_SESSION_ACTIVE_GRACE_MS` clamp; recommended default
   **24 h**.
4. Sweep-side verification: new
   `verifyThenDeleteUpstreamSession(baseUrl, sessionId, activeGraceMs, fetchLike?)` —
   GET `/session/{id}` first; 404 ⇒ done; 200 with recent `time.updated` ⇒
   **defer** (leave pending); 200 stale ⇒ DELETE; any other status/parse failure
   ⇒ defer (fail-safe, never destroy on uncertainty). Covers activity the
   guardian cannot see (session continued via the OpenCode web UI on :4096).
   Note: this is roughly the **fourth** OpenCode schema-coupling point (after
   `proxy.ts:357-365` request bodies, `forwardSessionCreate`/`forwardSessionList`
   response parsing, and event-frame shapes); `Session.time.{created,updated}`
   is confirmed in the vendored SDK typegen. Document the coupling next to the
   OpenCode pins in `containers/{assistant,guardian}/tools/package.json`
   (the `OPENCODE_VERSION` Dockerfile ARG no longer exists — CLAUDE.md is stale).
5. **Un-evict on active (recommended — decision below):** when verification
   finds the session recently active, don't just defer — **restore** the
   ownership row (the eviction log retains `principal_key`, `state-db.ts:118-125`;
   re-insert into `session_owners` with a fresh `last_used_at` and mark the log
   row reconciled). Without this, the principal's access stays lost (every `/oc`
   call 403s) and the session is deleted anyway once the non-guardian activity
   goes idle — only restoration actually satisfies the issue's "never evict a
   row for a session known to be active".

**Fix B:**

1. `pruneEvictionLog` (`:331-340`): add `WHERE reconciled_at IS NOT NULL` to the
   inner SELECT (drop the now-constant `(reconciled_at IS NULL) ASC` sort key).
   Pending rows become structurally unreachable by the cap. Emit a structured
   warn when the pending count still exceeds the cap after pruning.
2. New `drainEvictedSessions(deleteUpstream, batch = 100, database?)`: loop
   `reconcileEvictedSessions`; continue while a full batch reconciles cleanly;
   stop on any failure (never hammer a down assistant). Replace the single-batch
   call in `server.ts:277-287`.
3. **Add a third result category `deferred` to `ReconcileResult`** (verifier):
   an active-session deferral must not count as `failed`, or the drain loop
   stops for a healthy reason and the sweep log conflates "assistant down" with
   "session still active".
4. Backpressure = unbounded-but-observable pending set (warn + `/stats`).
   New-session refusal deliberately **not** implemented (guardian stays
   fail-safe for users; the issue's Direction lists the three remedies as
   co-equal alternatives and this plan picks accelerate + prune-completed-only).

**Also address (verifier findings):**

- **Head-of-line starvation:** `listPendingEvictedSessions` is
  `ORDER BY evicted_at ASC LIMIT` (`state-db.ts:461-465`); persistently-deferring
  rows can starve newer pending rows once the defer class exists. Add sweep-side
  rotation (e.g. offset past deferred rows within a drain pass) or at minimum a
  test documenting the accepted behavior.
- **Warn-spam:** the deferred-eviction and backlog warns fire on the hot
  session-create path; rate-limit or emit once per state transition.
- If `GUARDIAN_SESSION_ACTIVE_GRACE_MS` (and the existing eviction/reconcile
  knobs) should be operator-tunable in a shipped stack, they must be plumbed
  into the guardian env block in `packages/skeleton/system/stack/portals.compose.yml`
  using the existing `${VAR:-default}` pattern (`:115-119`) — **none of the
  current knobs are plumbed today**, which is also what invalidated the draft's
  stack-validation procedure.

### Tests (write first; guardian suite: `cd packages/guardian && bun test --no-orphans`)

1. **Migration v3→v4** — hand-build a v3-shape DB (old DDL verbatim,
   `user_version = 3`), seed `session_owners` **and `session_eviction_log`**
   rows (data-preservation precedent of the v1/v2 migration tests at
   `state-db.test.ts:245-321`); run `configureStateDatabase` → v4, column
   backfilled `= created_at`, log rows intact; idempotent re-run; fresh-DB
   `table_info` convergence.
2. **Ordering-key refresh** — touch makes an old row survive; `ON CONFLICT`
   re-insert refreshes `last_used_at`.
3. **Active-grace soft cap** — all rows in-grace ⇒ zero evictions, table over
   cap, empty log; one row aged out ⇒ exactly it evicts.
4. **Pending never pruned** — 5 pending, cap 2 ⇒ all 5 survive; reconcile 3,
   re-prune ⇒ 3 reconciled pruned, pending intact. **Flip the existing test at
   `state-db.test.ts:464-490`** (verified arithmetic: ses_3/ses_4/ses_5 all
   survive under the fix).
5. **AC1 sweep** — active (touched) session never appears in the delete
   callback nor the eviction log across repeated cap-crossings.
6. **AC2 backlog** — 250 evictions, cap 50, always-fail callback ⇒ zero pending
   dropped; recovery + `drainEvictedSessions` ⇒ all reconciled in one call.
7. **Drain stop conditions** — failure mid-drain stops the loop;
   deferred-active results do **not** stop it (the new `deferred` category).
8. **`verifyThenDeleteUpstreamSession`** against a `Bun.serve` stub — recent
   `time.updated` ⇒ no DELETE (+ un-evict restoration if adopted); stale ⇒
   DELETE; 404 ⇒ success; 500/unparsable ⇒ defer, no DELETE.
9. **AC1 end-to-end** — no `handleProxy` test exists anywhere in the package;
   build a small handleProxy harness (Bun.serve stub assistant + seeded
   principal, subprocess-harness pattern already used by the config tests) to
   pin the proxy touch call, **or** perform the corrected manual validation:
   drive sessions through the OpenAI-compat edge on `127.0.0.1:3821` (it
   authenticates upstream as the seeded portal principal `api`), read `/stats`
   with the admin bearer, with the guardian knobs plumbed via a compose overlay
   (the internal `/oc` listener is not host-published; `stack.env` cannot reach
   unplumbed guardian env vars).

### Decisions — all ruled 2026-07-27

| Decision | Ruling |
|---|---|
| Un-evict (restore ownership row) on active-verify | **Yes** — only restoration satisfies "never evict an active session"; cheap (principal_key retained) |
| `GUARDIAN_SESSION_ACTIVE_GRACE_MS` default | **24 h** |
| Plumb guardian knobs into portals.compose.yml | **Grace + reconcile interval only**; the two caps stay compile-time |
| AC1 coverage | **handleProxy harness** (new, reusable — the package has none today) **+ manual checklist** in the PR |

Risks: v4 is one-way (older guardian refuses the DB — same posture as v2/v3,
state in PR); soft cap trades strict boundedness for data preservation (state
in PR; update the module docs at `state-db.ts:282-283` and `:323-330` whose
invariants this flips); portal-sdk recovery on guardian 403 exists (evicts on
**any** prompt error, `opencode.ts:105-111`) but must not be relied on.

---

## #585 — Delete the named volumes over `/opt/openpalm`

**The reseed design is withdrawn.** A four-strand audit with adversarial
verification established that these volumes have no remaining purpose, so the
fix is subtraction, not machinery.

### Why they can go (measured, all four strands agree)

- **Assistant** writes exactly one file under `/opt/openpalm` at runtime:
  `runtime-config.json`, regenerated every boot from image content + env
  (`containers/assistant/entrypoint.sh:191,230`). Persisting it has no value and
  mild negative value (a stale copy exists between mount and rewrite).
- **Guardian**'s entire durable state — `state.db`, `guardian-audit.log`,
  `auth.json`, `.npmrc`, the bun tarball cache — lives on **host binds nested
  under** the volume (`portals.compose.yml:173-186`) and is untouched by
  removing the parent. Already proven in-tree:
  `scripts/guardian-image-offline-smoke.sh:62-67` boots the guardian with a
  nested host bind onto an image-layer `/opt/openpalm` and **no** named volume.
- **Portals** write nothing there — `containers/portal/start.sh:21-24` is a
  presence check and `portal-entrypoint.ts:47-55` only imports. `portal-cache`
  is 100% dead weight, and the shared discord/slack mount is a live silent trap
  (whichever starts first seeds the volume, so an image override on one service
  silently makes the other run the first one's code).
- **Nothing blocks the writable layer:** no `read_only:` or `tmpfs:` anywhere in
  `packages/skeleton/system/stack/`, and the target trees are `chmod a+rwX` for
  the arbitrary-uid case (assistant `Dockerfile:181,197,213`, guardian `:83`).
- **Provenance:** `guardian-cache` replaced an anonymous `VOLUME` as an npm
  artifact cache for cold-start package downloads (`24cf49ea`). #584 deleted the
  installs it cached. The surviving compose comment
  (`core.compose.yml:178-187`) is openly circular — the volume exists to be
  seeded and to give ownership repair a target, i.e. to feed the machinery that
  exists because it exists.

### It is the volume that causes the data pull

With a stale `guardian-cache`, the boot-time `install_artifact` semver check
compares against **old volume content**, fails, and re-runs `bun add` from npm
on the first boot after every upgrade (`containers/guardian/entrypoint.sh:79-85,
108-109`). Against image content the same check is a guaranteed no-op with zero
network. Removing the volume deletes the pull rather than managing it — which
answers both objections at once.

### The change

1. **Compose:** delete the three mounts and their declarations —
   `core.compose.yml:178-188` (mount + comment) and the `assistant-artifacts`
   entry at `:286-291` (**keep `assistant-persistent`** at `:174-177`/`:287` —
   genuine user content, the escape hatch for prefix-style installs);
   `portals.compose.yml` discord `:33-39`, slack `:71-74`, guardian `:167-173`,
   and the **entire** top-level `volumes:` block `:255-261` (an empty
   `volumes:` key is invalid compose and `docker compose config` runs before
   anything else on the apply path). Verifier flagged two off-by-one ranges in
   the draft citations — re-derive each boundary with the surrounding lines
   before deleting.
2. **Lib:** `volume-ownership.ts:135-144` `SERVICE_NAMED_VOLUMES` shrinks to
   `{assistant: ['assistant-persistent']}`, which also deletes an
   `alpine chown -R` (30s timeout) run over a ~200k-file tree on every ownership
   reconcile. Stale comments at `ownership-reconcile.ts:204` go with it.
3. **Auto-reap on upgrade (decision 585-B):** a closed list of retired volume
   names, matched only within the current project, removed as part of applying
   the new stack, with a log line naming what was reclaimed. Guardrails: the
   list is explicit and closed (never a pattern), `assistant-persistent` is
   never in it, and the reaper runs after the new containers are up so a failure
   cannot strand the stack. This is app-owned regenerable content OpenPalm
   itself created — not user data — but the closed list is what keeps that true.
4. **Docs:** `docs/technical/core-principles.md:59` still lists both the
   already-deleted `data/assistant/tools` bind and the `assistant-artifacts`
   volume as part of the assistant mount contract. That file's header requires
   explicit approval to edit — treat the edit as approved by decision 585-A.
5. **Tests/assets:** `image-volume-retention.test.ts` fixtures,
   `guardian-rootless.test.ts:28-32` (comment only; its assertion survives),
   `doctor.test.ts:204-210`.

### Accepted regressions (both documented, neither default)

- A downstream distro overriding `OP_GUARDIAN_NPM_VERSION`/`OP_GUARDIAN_PACKAGE`
  loses cross-recreate persistence of that install. It re-**installs**, not
  re-downloads — the bun tarball cache is on the host bind
  (`containers/guardian/Dockerfile:44` → `portals.compose.yml:174`) — and only
  on genuine recreation, not restart or reboot.
- With a non-1000 `OP_UID`, `/opt/openpalm/tools` becomes read-only in the
  container. The image explicitly designs for this
  (`containers/assistant/Dockerfile:169-177`: "an arbitrary-uid container only
  ever READS it"); today's writability is an accident of the chown pass.

### Tests

Unit: `SERVICE_NAMED_VOLUMES` reduction; the retired-volume reaper matches only
the closed list and only the current project, and **never** `assistant-persistent`
(negative pin). Compose contract: no service mounts a named volume at
`/opt/openpalm`; `docker compose config` parses both files. Smoke (extends
`scripts/rootless-ownership-smoke.sh`): after an upgrade the container serves
the new image's `/opt/openpalm`, the guardian's nested binds still resolve, the
retired volumes are gone, and `assistant-persistent` plus all `data/` canaries
survive byte-identical.

### Head-to-head with the withdrawn design

| | Reseed module | Delete the mounts |
|---|---|---|
| New code | ~300 lines, new lib module + state file | net **negative** — deletes code and a subsystem |
| New concepts | seed records, staleness planning, scope promotion, profile intersection | none |
| Failure modes | mid-upgrade partial rm; shared-volume outage; profile mismatch; stale records | one documented override regression |
| Disk | still stores a duplicate copy per project | reclaims ~2.2 GB per install |
| The npm re-pull | unchanged | eliminated |

---

## Image footprint reduction (answers "why are we pulling that much data")

Measured against `openpalm/assistant:0.13.0-beta.13` (4.77 GB) and
`openpalm/guardian:0.13.0-beta.11` (2.03 GB). `docs/system-requirements.md:91`
already understates reality at "~2–3 GB" for core images, and
`core.compose.yml:30-31` makes the assistant the **only** core service — so a
minimal install pulls one 4.77 GB image.

### The dominant cost is layer ordering, not tool size (IMG-6)

`ARG PLATFORM_VERSION` sits **above** the heavy layers
(`containers/assistant/Dockerfile:55,58-59`), so every release invalidates
everything below it: an upgrade pulls ~3.3 GB of "new" layers where ~25 MB
changed. Guardian: 755 MB → ~3 MB. Moving the ARG/ENV to just above the
`@openpalm/ui` bake (`:194`) fixes it — nothing between `:58` and `:194` reads
it (grep-verified), but it must be re-declared before `:194` for the documented
runtime-introspection use, and one real build must confirm it. Same treatment
for `containers/guardian/Dockerfile:28-29`.

Second-order: the release workflow builds the assistant **twice**
(`.github/workflows/release.yml:731-737` does a plain `docker build` for the
smoke test alongside the buildx build). Feed the buildx image to the smoke
instead — keep the pre-push gate ordering.

Also fix the reclaim side: after an upgrade the predecessor lingers as an
untagged image that `doctor --clean-docker` cannot attribute (its filter matches
by tag). Attribute via repo-digest or label so ~4.4 GB per upgrade cycle is
reclaimable — with positive OpenPalm attribution required, since the retention
module's own header warns against removing unrelated dangling images.

### Content reductions

| Item | Saving | Notes |
|---|---:|---|
| Four AI coding CLIs (IMG-1) | ~891 MB | Nothing shipped invokes them; OpenCode is the runtime |
| Google Cloud SDK (IMG-3) | ~550 MB | Sole consumer is the optional `gws-setup` skill |
| onnxruntime CUDA + wrong-platform binaries | ~479 MB | 301 MB CUDA provider with no GPU mapping anywhere; win32/darwin/arm64 trees |
| onnxruntime-web | ~130 MB | Browser WASM bundles in a Node-only runtime; verifier **measured** that removing it leaves the offline embedding test passing |
| OpenCode musl + baseline (IMG-4) | ~482 MB guardian, ~168 MB assistant | musl cannot execute on the glibc base at all |
| `postgresql-client` + dead `libglib` (IMG-5) | ~16 MB | `libglib` has no reverse deps and nothing links it |

Guarded by the build-time offline inference test at
`containers/assistant/Dockerfile:120-122` for anything onnxruntime-related — if
a prune breaks semantic search, the build fails rather than shipping.

**Removals that are not free** (verifier findings — all in scope):
`ProvidersPanel.svelte:42,186-191` and
`packages/lib/src/control-plane/assistant-cli-tools.ts` write credential files
for the four CLIs and must go with them; `release.yml:737` asserts each
`--version`; `containers/assistant/Dockerfile:43-48` partitions `node_modules`
by moving those exact scope directories, so the three-way layer split must be
re-derived; and `packages/skeleton/data/assistant/tools/package.json` carries a
**second** copy of the same pins, seeded into every OP_HOME.

### On-demand installation (IMG-2)

One akm skill with a small manifest of supported optional tools — the four
coding CLIs and gcloud — installing into `/opt/persistent` (the
`assistant-persistent` volume, already documented for exactly this) and putting
the binary on PATH. The user asks in plain language; the assistant runs the
skill. `gws-setup` calls the same path for gcloud on first use. One code path,
one place to add the next tool, and it needs an "already installed?" check so
repeat invocations are cheap.

### Log caps (IMG-7)

`logging: driver: json-file, options: {max-size: 10m, max-file: '3'}` on
assistant, guardian and both portals — a 30 MB ceiling per service where today
there is none.

### Published requirements (581-disk)

Replace the single 10 GB figure in `docs/system-requirements.md` with a
per-configuration table (assistant only ≈ 4 GB; with guardian/portals ≈ 6 GB;
voice or a local LLM higher), each row showing its components. **Before
publishing, run a measured verification build** — these figures come from strand
measurements and the verifiers flagged unit inconsistencies (`docker images`
size vs `docker history` layer sums vs `du --apparent-size` are three different
numbers). Publish measured values, not derived ones.

---

## #581 — Container storage growth: the true remainder

### Landed in #584 (verified — do not re-plan)

S2/E2 fully (zero boot-time installs; exact pins everywhere incl.
`akm-opencode@0.8.2`; single-volume mounts; guardian semver-satisfies skip
fixed; unused akm-cli dropped). S4 first pass (→ #586). S5 substantially
(`OP_BACKUP_DIR` via `resolveBackupsDirFor`, fail-closed destination
measurement, staging + completion marker + torn-copy cleanup, per-namespace
protected mtime retention, wired space guard). S6 substantially
(`disk-headroom.ts`, CLI preamble alongside docker-readiness). S7 substantially
(`image-volume-retention.ts` + confirm-gated `doctor --clean-docker`). S8
substantially (`storage-report.ts` + doctor default output; flags today:
`--clean-caches`, `--clean-docker`, `--reclaim-db`, `--yes`, `--json`). S3 lib
module complete (`opencode-db-maintenance.ts`: conservative retention planner,
paged listing, WAL/VACUUM with thresholds, 30 tests) but wired only as
file-only `--reclaim-db`. S1 purge tooling (`cleanCaches` safelist +
`--clean-caches`) landed; **relocation deferred by `921412b1`** (nested named
volumes created root-owned mountpoints on the host bind → rootless smoke
failure).

### Remainder A — S1 cache relocation (rootless-safe redo)

**Design:** fixed `${OP_HOME}/cache/{assistant,guardian}` host dirs — **no
`OP_CACHE_DIR` knob** (verifier: unrequested configurability; a knob forces
absolute-path validation against the secrets/knowledge trees for zero
demonstrated need). Pre-created **operator-owned** by `ensureHomeDirs`
(`home.ts:257-304`) — this is the rootless-safe mechanism: Docker only creates
a root-owned mountpoint when the host dir is missing. Also pre-create
`data/guardian/.cache` (the exact missing mountpoint that caused the
`921412b1` failure). Bind them over the unchanged in-container paths
(`/home/opencode/.cache`, guardian `.cache`) — nested bind targets win by
target-path depth (the `config/assistant` nested-over-HOME bind at
`core.compose.yml:157` is the in-repo precedent); declaration order is **not**
load-bearing — don't document it as such.

**Mandatory companions (verifier — each is an AC violation if missed):**

1. **Backup exclusion:** `backupOpenPalmHome` skips only top-level `data`
   (`backup.ts:226`) and `estimateHomeBackupBytes` likewise (`:33`) — add
   `cache` to both + test, or every safety snapshot starts copying the caches
   (re-breaking AC4).
2. **`uninstall --purge`:** add the cache dir to the purge list + test.
3. **`core-principles.md` amendment:** the contract currently says regenerable
   cache belongs at `~/.cache/openpalm` (`:70, :152, :177`) — amend it to name
   `OP_HOME/cache/` in the same change (architectural-authority rule).
4. **Safelist:** `CACHE_RELATIVE_PATHS` covers both the new `cache/*` dirs and
   the legacy `data/*/.cache` paths (legacy installs keep purge coverage; never
   auto-delete the legacy trees).
5. **Validation gate:** the rootless ownership smoke must pass; add a lib-level
   test that the apply path (`lifecycle.ts` `applyHome` → `ensureHomeDirs`)
   produces the mountpoint dirs before any compose invocation — the `921412b1`
   regression class is "compose ran before the mountpoint existed".

Alternative (c) — accept caches under `data/` and amend the contract — is the
zero-risk fallback if the maintainer prefers; it leaves the incident report's
"Critical" contract violation in place. **Recommend the relocation.**

### Remainder B — S3 live wiring + visibility

- **`doctor --prune-sessions`** (`--max-age-days` required, `--max-sessions`,
  `--dry-run`): **thin adapter over lib** — `resolveAssistantEndpoint`
  (`assistant-endpoint.ts`, the one place URL precedence is decided) +
  `createOpenCodeClient` (`opencode-client.ts:127,139` already has
  `listSessions`/`deleteSession`) shimmed to `SessionDeletionClient`; Basic
  auth read from `${OP_HOME}/private/secrets/op_opencode_password`
  (`core.compose.yml:277-278` — note the file name). Calls
  `runOpenCodeDbMaintenance(client, dbPath, {confirm, retention,
  skipVacuumStage: true})` (the option exists, `opencode-db-maintenance.ts:455`).
  Needs the stack **running** (opposite of `--reclaim-db`); keep the two-flag
  split crisp in docs. **Lands after #586.** One live-stack validation pass for
  the real list/DELETE semantics (module flags them unverified, `:480-486`).
- **`doctor --sessions [--page N]`**: renders `listSessionsPaged` (exported,
  zero callers today) — parentID/depth/age/root-vs-child summary. UI
  session-list changes (parentID is mapped away, `chat.ts:31-45`) deliberately
  deferred — CLI-only visibility satisfies the operator-cleanup ask.
- **`packages/skeleton/knowledge/tasks/session-maintenance.yml`** shipped
  **disabled** (like `health-check.yml`). **Executor constraint (verifier):**
  tasks run **inside the assistant container** where the host CLI doesn't
  exist — the task must call OpenCode's REST API in-container
  (`localhost:4096`), not `openpalm doctor`; specify the in-container script.
- **S8 report addition:** per-DB freelist/free-ratio via `getDbSizeInfo`
  (readonly) + a "`--reclaim-db` recommended" line when `shouldVacuum` is true.

### Remainder C — verified small defects (wave 1)

1. **CLI prune preview parity (consent-integrity):** `backups.ts:50-60` prints
   the *global* `listBackupDirs().slice(keep)` list then deletes the
   per-namespace protected-aware set. Export `planBackupPrune(homeDir, keep)`
   from `backup.ts` (factor the shared logic) and print exactly it; assert the
   printed set in a CLI-level test. (The UI route's slice at
   `+server.ts:62-63` is only an early-return guard and is provably consistent
   — verifier; aligning it is optional.)
2. **Doctor ignores `OP_BACKUP_DIR`:** pass
   `backupsDir: resolveBackupsDirFor(homeDir)` at `doctor.ts:205`.
3. **`install --force` prompt honesty:** `install.ts:182` hardcodes
   `data/backups` — build from `resolveBackupsDirFor`.
4. **`ui-*`/`skeleton-*` auto-prune:** `pruneBackupNamespace(prefix, keep=3)`
   called from `npm-bundle-updater.ts` after successful update (decision
   below); the doc fix must ship with it.
5. **`uninstall --purge` + external backups:** when `resolveBackupsDirFor` is
   outside `homeDir`, print "External backups at `<dir>` were preserved" —
   never delete an external destination.
6. **S6 lib gap:** the headroom check runs only in the CLI preamble
   (`cli-compose.ts:63-82`); the UI-driven lib apply path has none. Run
   `checkDiskHeadroom` in `reconcileCore`'s preflight block
   (`lifecycle.ts:106-121`), `lifecycleLogger.warn` on low (existing pattern —
   no return-shape change), throw only when `shouldBlockOnDiskHeadroom`, gated
   by `OP_SKIP_COMPOSE_PREFLIGHT`; share one helper with cli-compose to avoid
   double-warn.
7. **S7 suffixes:** done in PR 3 (#585) — coordinate, don't duplicate.
8. **S2 residue:** delete **all three** dead seeded manifests —
   `packages/skeleton/data/{assistant,guardian,portal}/tools/package.json`
   (the portal one exists too — verifier); stop creating `data/*/tools` in
   `ensureHomeDirs` (`home.ts:273,278`); fix the stale `versions.ts:8-10`
   comment, `core-principles.md:59` mount reference, and the `backup.ts:182-186`
   docstring. Never touch existing operator copies.
9. **CI ratchet tests** (green at introduction — that's their purpose; say so):
   entrypoints contain no `bun update|bun add|npm install|npm ci` outside
   guardian's `install_artifact`; compose mounts no bind over the **artifact
   paths** `/opt/openpalm/{tools,ui,skeleton,guardian-pkg}` — the guardian's
   legitimate `/opt/openpalm/guardian`, `/opt/openpalm/logs`, and config binds
   (`portals.compose.yml:174,180,185`) must be allowlisted or the assertion
   inverted (the draft's blanket subpath ban would be red today — verifier).
10. **Doctor test gap:** add the missing declined-prompt test for
    `--clean-caches` while in the file.

### Remainder D — docs pass (AC6)

- `managing-openpalm.md:365-366`: "never pruned automatically" is false
  (`install --force` prunes to 3; plus the new namespace auto-prune). State the
  real policy.
- Document `OP_BACKUP_DIR`, `OP_DISK_LOW/CRITICAL_THRESHOLD_BYTES`,
  `OP_DISK_HARD_BLOCK`, and an `openpalm doctor` section covering the report +
  all four actions.
- `backup-restore.md`: keep the simple full-tree tar but add the curated
  variant excluding `data/*/.cache`, `data/akm/cache`, legacy `data/*/tools`;
  note lifecycle snapshots exclude `data/` entirely; fix the stale
  `config/stack/` path at `:103`; document that legacy `data/*/tools` trees are
  dead and safe to remove **manually** (the report deliberately never purges
  them).
- `system-requirements.md:37`: raise the 10 GB figure — recommend
  **20 GB minimum / 40 GB recommended** (maintainer to confirm).
- `core-principles.md`: cache-location amendment (Remainder A) +
  `state/artifact-volume-seeds.json` (#585) + stale `:59` mount line.
- Doctor report: print effective compose project/files/profiles (issue
  Recommended Change 4 facet — `projectName` is computed at `doctor.ts:207`
  but never printed).

### Acceptance criteria status

| #581 AC | Status |
|---|---|
| Restarts don't resolve newer deps | **Met** (E2/S2); remainder = CI ratchet test |
| Tool versions pinned, reviewed upgrades | **Met**; remainder = dead-manifest removal |
| Caches independently purgeable | Purge half met; remainder = S1 relocation |
| Backups/rollback exclude generated artifacts | **Met**; keep it true under S1 (cache/ exclusion) |
| Operators can identify + clean safely | Mostly met; remainder = backupsDir-aware report, freelist, orphan suffixes, session visibility/pruning |
| Docs match behavior | **Not met** — Remainder D |

### Decisions — all ruled 2026-07-27

| Decision | Ruling |
|---|---|
| S1 mechanism | **Fixed `${OP_HOME}/cache/{assistant,guardian}` host binds, no env knob**, contract amended; backup-exclusion + purge-list + core-principles edits are mandatory companions |
| Cache size/age caps | **Descoped** — purge-on-demand + headroom warnings; no background reaper |
| Auto-prune `ui-*`/`skeleton-*` (keep 3) | **Yes** — ships with the doc correction |
| `session-maintenance.yml` default | **Disabled**, in-container REST executor (host CLI is unreachable from the task runtime) |
| Bulk session visibility | **CLI only** (`doctor --sessions`); UI `parentID`/paging deferred to its own issue |
| Min-disk figure | **Per-configuration table, numbers going down** — see the footprint section. Publish measured values from a verification build, not derived ones |
| S7 volume retention | **Superseded** — the retired-volume list + predecessor-image attribution in PR 3 replace the suffix extension |

---

## #577 — Activation veto + IndexedDB probe: close, plus optional hardening

### Verified: the issue is fully implemented in `main` (commit `f78c32ef`)

- **U1:** `ACTIVATION_VETO` symbol (`connection-events.ts:28`), narrowed
  `ActivationListener` return type (`:34-37` — boolean returns are now a
  compile error, verified TS2322), sentinel-only check (`:94`). All three
  registration sites conform; `chat-state.svelte.ts:1301` translates the
  boolean to the sentinel; the throw-based rollback path
  (`endpoints-state.svelte.ts:388-416`) needed no change.
- **U2:** `probedEntries` cache (`boot.ts:57-102`) — probe result consumed
  exactly once by the first `getAll`, fallback semantics and
  `getConnectionStorageMode` unchanged.
- All four required test categories exist and pass (88/88; `ui:check` 0/0):
  plain-false-does-not-veto (`connection-events.vitest.ts:34-45`), sentinel
  refuses (`:25-32`), **rollback + re-emit pinned by
  `endpoints-state.svelte.vitest.ts:145-172`** (the draft's `:211-251` citation
  pins activation-write serialization, not the re-emit — use the corrected
  citation in the closing comment), single-getAll (`boot.vitest.ts:121-143`),
  memory fallback (`:47-119`).

### Actions

1. **Close #577** with a comment citing `f78c32ef` and the file:line evidence
   above (corrected test citations).
2. **Recommended ~3-line hardening + 1 test (write it first):** the
   `probedEntries` cache is not invalidated by wrapper mutations
   (`put`/`updateConnection`/`removeConnectionState`, `boot.ts:91-94`). The
   verifier empirically reproduced the staleness: `store.add()` as the first
   wrapper op followed by `store.list()` returns the pre-add probe snapshot.
   Latent today only because every real boot path getAlls first — an unstated
   ordering invariant, the exact footgun class this issue targets. Clear the
   cache in those three methods **only** (clearing on `getMeta` would defeat
   the landed optimization — `seedFromRuntimeConfig` calls `getMeta` before
   `getAll`; meta/crypto stores can't affect `getAll` results).
3. **One-line type-regression pin:** a `// @ts-expect-error` case
   (`onConnectionActivated((id) => false)`) — the runtime tests cast through
   `unknown`, so a silent re-widening of the listener type would go unnoticed.

Fully independent of the other three issues; effort trivial.

---

## Milestone exit criteria (these four)

- #577 closed; hardening + type-regression pin merged.
- #586: both acceptance criteria pinned by guardian unit tests (active session
  survives cap-crossing sweeps; zero pending rows dropped under backlog) +
  handleProxy-level cover for the touch path; guardian suite green.
- #585 + footprint: upgrade smoke green in CI — after an upgrade the container
  serves the **new** image's `/opt/openpalm`, the guardian's nested binds
  resolve, retired volumes are reclaimed, and `assistant-persistent` plus every
  `data/` canary survives byte-identical; negative pin that the reaper can never
  match `assistant-persistent`; `docker compose config` parses both files;
  measured before/after image sizes and upgrade-pull bytes recorded in the PR;
  the on-demand install skill verified for each optional tool it lists;
  **landed before the next tagged release**.
- #581: acceptance table above fully "Met"; rootless ownership smoke green with
  the S1 relocation; docs pass merged (including the per-configuration disk
  table built from the verification build's measurements).
- Repo gates green at each PR: `bun run lint`, `bun run check`, targeted
  suites, root `bun run test`; CHANGELOG `[Unreleased]` entries for every
  user-visible change — volume removal and reclaim, the slimmed images and what
  moved to on-demand install, the documented CPU floor, log caps, doctor flags,
  backup pruning, cache relocation, and the guardian soft cap.
