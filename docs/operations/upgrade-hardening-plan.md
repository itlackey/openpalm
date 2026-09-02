# Upgrade hardening plan

**Date:** 2026-08-30 · **Status:** proposed
**Evidence base:** [`../reviews/akm-0.9.4-integration-issues.md`](../reviews/akm-0.9.4-integration-issues.md)
(this cycle's incident record), the op-home lessons catalog
([`../reviews/op-home-structure-issues-and-lessons.md`](../reviews/op-home-structure-issues-and-lessons.md)),
both repos' changelogs 0.9.x–0.13.0, and closed issues #474, #552, #558, #620,
plus akm #852, #867–#870. Every claim below traces to one of those.

The 0.13.0 cycle burned 33 beta releases, and the akm 0.9.1→0.9.4 bump alone
produced five cascading production failures, each invisible until the previous
one was fixed. This plan names the five failure MODES behind that pain — each
backed by at least two independent incidents — and one countermeasure per
mode. Bias: automatic over procedural, contract tests over documentation,
small over large. This is a one-maintainer project pair; nothing here adds
standing overhead that does not demonstrably pay for itself.

---

## The five failure modes

### Mode 1 — Dead subsystem, green health

Every akm/cron failure in the boot path is downgraded to a stderr warning that
no health surface reads. A permanently broken subsystem coexists with passing
health checks until someone does docker-logs archaeology.

Incidents: `akm migrate` exit-70 warned-and-continued on every boot for a full
release cycle (entrypoint.sh:426); initial `task sync` failure killed all cron
with one stderr line (entrypoint.sh:612); #552 cron tasks failing while
exiting 0; the AKM stats endpoint discarding the stderr that named the cause;
missing supercronic = warning only.

### Mode 2 — Version gate with no read shim, shipped inside a "patch"

akm repeatedly gates persisted data behind a new version and hard-fails the
old shape with no read path — inside a 0.9.x patch series its own STABILITY.md
exempts from patch semantics. OpenPalm consumed those patches with patch-level
trust. akm's own source names the pattern: "a version gate with no read shim…
the same shape of break… each caused in 0.9.x"
(src/core/config/config-version-shim.ts:6-14).

Incidents: task-source v4-only gate (killed all cron); akm #852 (0.9.2
rejecting valid 0.9.1 configs); targetVocab rows older binaries throw on;
stashDir/wiki removals in 0.9.0; the node 22→24→22 engine flip across
0.9.2–0.9.4, where each hotfix itself needed a same-day follow-up.

### Mode 3 — No automated gate ever ran the real pinned akm against a real home

**Update (0.13.1): the three named gaps below are closed** —
`scripts/upgrade-path-smoke.sh` now runs `applyHomeAssets` (not just the
seed), exercises the real pinned akm (`migrate status`, `task sync
--dry-run`) against each era's migrated home (reusing
akm-pin-integration-smoke.sh's technique), and no longer force-deletes
`state/schema-version` — it stamps 0 for every fetched era instead (the only
stamp consistent with the pre-consolidation fixture content
`smoke_seed_legacy_install_state` writes; see that function's own comments in
the script for why a stamp derived from what the era's skeleton ships,
rather than what the FIXTURE'S file shapes actually require, produced false
migration failures when tried). The paragraph below is kept as the historical
incident record.

CI's only akm exercise used to be `akm --version`. upgrade-path-smoke.sh never
called akm (its one mention was a comment, line 313), never ran
`applyHomeAssets` (only the seed, lines 219-226), and force-deleted
`state/schema-version` (line 96) — making the mid-cycle-stamp population that
stranded the retired files untestable *by construction*. #558 M21 predicted
this in advance: "zero automated coverage of the one scenario every real user
will hit." All five 0.9.4 failures were discoverable only on a live instance.

### Mode 4 — One-shot delivery to existing homes

Outside the managed `system/` tree, seeding is add-only and migrations are
since-gated, so a changed or retired shipped file structurally cannot reach
existing homes. Each occurrence forces a bespoke escape hatch invented under
incident pressure — three coexisting mechanisms shipped in this ONE cycle
(schema-gated deletes, the frozen-hash skill sweep, rename-and-reseed).

Incidents: v4 task files reaching only fresh installs; the since:6 sweep
permanently skipped by homes stamped 10; op_session_signing_key needing
re-listing at since:3; K7/B11 skills bugfixes never reaching existing homes;
#558 M16 guardian seed-once pins.

### Mode 5 — Split-brain versioning

Independently-versioned components share one durable file or runtime contract
with no version gate on either side.

Incidents: version-uncontrolled HOST akm pointed at the same state.db as the
pinned container akm, with a documented one-way crash waiting
(v0.9.1-to-v0.9.2.md:277-294 — "keep one akm version reading a given state.db
at a time"); host-AKM config import producing files the container CLI could
not parse; #620 — OpenCode live-fetches akm-opencode from npm at runtime, so
a bad publish 500'd every provider request independent of any image that
passed CI.

---

## Countermeasures — one per mode

### 1. Make akm boot outcomes machine-readable, and grep boot logs in CI
**openpalm · small**

The entrypoint writes a status file recording the exit codes of
`akm migrate status/apply`, initial `task sync`, and `akm health`;
`/api/host/akm/stats` reports degraded from it (the `available:false`
plumbing already exists); the existing rootless smoke greps assistant boot
logs since container `StartedAt` and fails on `warning: akm` /
`migrate apply failed` / `task sync failed`.

Deliberately does NOT fail the compose healthcheck: #474's "a migration
hiccup must never block the assistant from starting" stands. Degraded-but-up
is correct; *invisible* is the bug.

### 2. Extend akm's previous-release corpus to everything it persists
**akm · small-medium**

akm 0.9.4 already ships the mechanism: previous-release-corpus.test.ts with
the policy "every future schema bump must add the OLD shape here BEFORE
shipping." Extend it beyond task sources to every persisted surface prior
akms actually wrote — the synthesized AKM_BUNDLE_DIR `stash` bundle entry
(#870), pre-`--bundle` crontab rows, retired-key 0.8 configs — plus
OpenPalm's shipped artifacts (its config.json shape and four task files) as
downstream-consumer fixtures. Bump configVersion via the #863 shim whenever
load-validation tightens. Fixtures in an existing gated suite, not new
machinery.

### 3. One pinned-akm integration job in CI, required on every pin bump
**openpalm · DONE — `scripts/akm-pin-integration-smoke.sh`, wired into CI quality-gates**

A scripted version of the manual procedure that actually caught this cycle's
bugs: exact-pin install under the image's Node version (so an engines floor
fails at install, catching the 0.9.2/0.9.3 flip from published metadata);
materialize a throwaway OP_HOME from the skeleton PLUS a legacy fixture home
that keeps its previous release's schema stamp; run `applyHomeAssets` (not
just the seed); then the real akm: `migrate status`, `task sync --rebind`
against the shim spool, `config list`. Fail on any nonzero exit. This one job
would have caught failures 1, 2, 3 and 5 of this cycle before merge.

### 4. Release-owned files move to the managed overwrite channel
**openpalm · medium — guard landed (0.13.1); the file-ownership migration itself is still open**

Stop inventing escape hatches: release-owned task files move onto the channel
`system/skills` already uses — always-overwritten managed tree, with the
existing frozen-hash pristine-check protecting operator edits. Retire
rename-and-reseed for release content. Record the rule in core-principles.md:
release-owned content lives on an overwrite channel; the user-owned knowledge
tree receives nothing the release will later need to change.

The guard this depends on has landed: upgrade-path-smoke.sh no longer
force-deletes `state/schema-version` (every fetched era keeps a real stamp —
see the Mode 3 update above), which is what kills the
untestable-by-construction gap for whatever migration eventually ships this
move. The move itself — retiring rename-and-reseed and the post-upgrade
"every task file parses via loadMarkdownTasks with nonzero count" assertion
that would prove it — has not shipped; it is a lifecycle/migration change,
not a test-lane one.

### 5. Close the two unpinned lanes
**openpalm · small-medium**

(a) Bake the pinned akm-opencode plugin into the assistant image (warm
OpenCode's plugin cache at build) so first boot never depends on a live npm
fetch — the exact surface #620 broke. (b) Before `executeAutomation` runs a
host akm against the shared state dir, check `akm --version` >= the container
pin; refuse (with the Mode-1 status marker) otherwise — the documented
targetVocab one-way crash is otherwise waiting to fire.

### Cross-cutting: tag every published release at its publish commit
**both · small**

As part of the publish path so it cannot be skipped. Create the missing
`0.13.0`(-to-be) and akm `v0.9.4` tags; every incident review this cycle paid
an npm-archaeology tax to answer "what did the broken install actually run."

---

## The akm bump gate

The checklist a pin bump must pass, in order. Steps 4–6 are what actually
caught every bug this cycle; unit suites and health checks caught none.

0. **Precondition**: the version being adopted has a git tag at its publish
   commit in the akm repo.
1. **Read the delta**: every "Breaking changes & migration" section between
   the pins, plus the docs/migration/ guides they name. Quote them in the
   bump commit. STABILITY.md says 0.9.x patches may break — this step is
   mandatory, not diligence theater.
2. **Check machine metadata first**: `npm view akm-cli@<new> engines` against
   the image's base (`containers/assistant/Dockerfile:65`). Mismatch = stop.
3. **Bump all lockstep surfaces together** — assistant tools, paperclip
   manifest, opencode.jsonc — and confirm paperclip-compose-contract passes.
4. **Run the pinned-akm integration job**: `./scripts/akm-pin-integration-smoke.sh`
   (countermeasure 3, now automated and wired into CI's quality-gates).
5. **Build the image and boot the real stack twice** — fresh OP_HOME and an
   upgraded legacy fixture home. Then **confirm the running `akm --version`
   equals the new pin before reading any other result.** Building an image does
   not mean the stack runs it: a home whose `OP_ASSISTANT_VERSION` names a
   rollback generation (or any tag other than the one just built) boots the OLD
   image, and every downstream check — clean boot logs, a clean marker, the
   scheduler — then describes the version you were trying to replace. This
   nearly published a 0.9.6 result as 0.9.7 verification.
6. **Gate on boot logs, not health**: scan logs since
   `docker inspect --format '{{.State.StartedAt}}'` (plain `--since`
   spans restarts); fail on any akm warning line.
7. **Verify the scheduler end-to-end**: supercronic spool has an entry per
   shipped task (no crontab binary in the image — put /tmp/openpalm-bin on
   PATH in any docker exec), and loadMarkdownTasks returns the full count.
8. **Verify the plugin lane**: provider list works with the plugin enabled,
   from the image alone.
9. **Only then merge.** Any workaround needed during 4–8 becomes a same-day
   upstream issue WITH a repro fixture added to akm's previous-release
   corpus as part of the fix.

---

## Explicitly rejected

- **Cross-repo CI** (akm running OpenPalm's suite): enterprise-grade standing
  overhead for a one-maintainer pair; copying OpenPalm's artifacts into akm's
  corpus gets ~90% at ~10% of the cost.
- **Failing container health on akm failure**: conflicts with #474 by design;
  a degraded scheduler must not become a restart-looping assistant.
- **"Treat every 0.9.x bump as breaking" as written policy**: procedural and
  superseded by the gate; "wait for the next patch" is superstition — 0.9.4
  itself needed a same-day fix.
- **Schema-validating shipped files in unit tests**: duplicate oracle; the
  integration job runs the real binary, which is the authoritative check.
- **`openpalm doctor` akm checks**: pull-based — requires the operator to
  already suspect a problem, the exact assumption the green-while-broken
  incidents disprove.
- **Auto-growing the smoke's version list**: the gap was missing assertions,
  not missing eras.

## Sequencing

1. Now (pre-0.13.0-tag, hours): cross-cutting tags; countermeasure 1.
2. With the 0.13.0 release (days): countermeasure 3 — the CI job is the
   single highest-leverage item and the bump gate's automation.
3. 0.13.1 / akm 0.9.5 (as they land): countermeasures 2 and 5 — 0.9.5's
   degrade-don't-reject and per-bundle migrate (#869) already address the
   worst of Mode 2's blast radius upstream.
4. 0.14.0: countermeasure 4 — it moves files between ownership trees, which
   belongs in a minor, not a patch.
