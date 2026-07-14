# Fix spec — c9-lifecycle-guard

PR #564 review cluster c9. Finding ref: **r3566892768** (severity: major).
Verified against HEAD `15ffdf6` on 2026-07-12. Prior branch fixes 28d1afb / 3825e00 touch
none of the files below; nothing here can regress them.

---

## 1. Finding verification and decision

### r3566892768 — `packages/lib/src/control-plane/lifecycle.ts:249` — CONFIRMED, with two corrections

**Confirmed.** At HEAD, `reconcileStack` (lifecycle.ts:233) runs the guard unconditionally,
before any kind branch and before `withStackEnvRollback`:

```ts
const activate = op.kind === "install" || op.kind === "upgrade";   // :237
const deactivate = op.kind === "uninstall";                        // :238
const composes = op.kind === "upgrade";                            // :239
...
const overlayCheck = checkCustomComposeChannelLan(state.homeDir);  // :248
if (overlayCheck.blockError) throw new Error(overlayCheck.blockError); // :249  ← cited line, matches HEAD
```

`applyUninstall` (:355) calls `reconcileStack(state, { kind: "uninstall" })` and `applyUpdate`
(:339) calls it with `kind: "update"`, so a `custom.compose.yml` that references `channel_lan`
without defining it (blockError case, `overlay-deprecations.ts:79-87`) throws for all four kinds.

**Correction 1 — the blocked surfaces are the admin routes, not the CLI command.** The
reviewer's example `openpalm uninstall` never reaches the guard:
`packages/cli/src/commands/uninstall.ts:25-28` runs `runComposeWithPreflight(state, ['down'])`
and optionally purges directories — it never calls `applyUninstall`/`reconcileStack`. The
surfaces that ARE blocked are `POST /api/host/uninstall`
(`packages/ui/src/routes/api/host/uninstall/+server.ts:41` → `applyUninstall`) and the
full-update branch of `POST /api/host/update`
(`packages/ui/src/routes/api/host/update/+server.ts:155` → `applyUpdate`). These are real
operator surfaces; severity stands.

**Correction 2 — the prescribed one-line gate does NOT, by itself, unblock uninstall.** This
drives the fix design, so it is spelled out. `reconcileCore` runs a *mandatory* compose
preflight for every kind (lifecycle.ts:108-124: `checkDocker` throw + `composePreflight` throw
when `files.length > 0 && !OP_SKIP_COMPOSE_PREFLIGHT`), and `buildComposeOptions →
discoverStackOverlays` (config-persistence.ts:263-277) always includes `custom.compose.yml`.
Trace of admin uninstall on a 0.12.x home (old managed files still define the `channel_lan`
compat bridge) with only the guard gated:

1. Route `composeDown` — merged model still valid (bridge defined) → containers go down.
2. `applyUninstall` → guard skipped → `applyHome` overwrites `system/stack/` to the 0.13.0
   skeleton (the `channel_lan` definition disappears; core/services compose are **not** in the
   `withStackEnvRollback` crash-restore set, :419-428).
3. `reconcileCore` preflight → `docker compose config` fails (`service … refers to undefined
   network channel_lan`) → throw → route 500s.

Net effect of the literal prescription: the same 500 as today, a *worse* (cryptic) message,
and the managed tree overwritten before the failure — the exact harm #490 introduced the guard
to prevent. So the fix must pair the guard gate with a preflight gate for the deactivation
flow (Fix 2 below); otherwise the finding's stated goal ("uninstall should not be blocked") is
not delivered in the main production scenario.

**Analysis note on `update`.** With an *actively referenced* stale overlay, a full update can
never succeed regardless of the guard: the same invalid merged model fails `reconcileCore`'s
preflight and the route's `applyStack`. Demoting the guard for `update` is still correct, for
two reasons: (a) the guard is a **textual** scan of the raw YAML — it also blocks *dormant*
references (e.g. an overlay service gated behind an inactive compose profile is excluded from
the model, so `docker compose config` validates and the update would succeed; the guard blocks
it anyway — a genuine false-positive lockout that the fix removes); (b) in the active case the
preflight error already names `channel_lan` and lists `custom.compose.yml` in its Files line
(`buildComposePreflightError`, docker.ts:342-377), and the demoted warning (Fix 1) supplies
the rename-to-`portal_net` guidance right above it, so no actionable information is lost.

### Decision

Two minimal changes in `packages/lib/src/control-plane/lifecycle.ts`, nothing else in prod code:

- **Fix 1 (the prescription):** run `checkCustomComposeChannelLan` for every kind (keeps
  cleanup-guardrails Guardrail 11 satisfied and keeps the advisory `warning` path identical),
  but **throw the blockError only for activation kinds** (`activate`, i.e. install/upgrade).
  For update/uninstall, log the same blockError text via `lifecycleLogger.warn` so the operator
  still gets the rename guidance next to whatever the preflight later reports.
- **Fix 2 (required to make Fix 1 meaningful for uninstall):** in `reconcileCore`, skip the
  Docker-check + compose-preflight block when `opts.deactivateServices` is set. Justification
  is already written in the codebase: "the deactivation flow (uninstall) only rewrites runtime
  files reflecting the stopped state — the route does composeDown" (lifecycle.ts:253-257).
  Uninstall's reconcile performs no compose operation (`composes === false`; both
  `activating && composes` blocks are skipped) and none of its writes consume the merged model
  (`writeRuntimeFiles` is seed-if-absent + `writeSystemEnv`, config-persistence.ts:438-474).
  Bonus alignment: the uninstall route already tolerates Docker-down (`if (dockerCheck.ok)`
  around `composeDown`, and it reports `dockerAvailable` in its response) — but today
  `reconcileCore` throws "Docker is not available" and defeats that route design. After Fix 2,
  uninstall completes docker-down, matching the route's evident intent. `applyUninstall` has
  exactly one caller (the admin route); no other blast radius. No test anywhere pins the old
  behavior (verified: zero hits for `applyUninstall` in any test file).

**Rejected alternatives:**
- *Skip the check entirely for non-activate kinds* — loses the actionable rename guidance in
  exactly the runs where the follow-on failure is most cryptic.
- *Relax the route's `composeDown` / CLI `down` on an invalid model* — impossible/unsafe:
  `docker compose down` itself cannot load an invalid project; catching and continuing would
  report "uninstalled" with containers still running. Out of scope (see §5).
- *Auto-rewrite `channel_lan` → `portal_net`* — the migration framework that promised this was
  deliberately deleted (CHANGELOG "auto-migrated" note is historical; see
  docs/reviews/upgrade-migration-review-2026-07-06.md M7). Reintroducing writes to a
  user-owned file from a guard is a config-ownership violation.

---

## 2. TEST-FIRST PLAN (write these before touching lifecycle.ts)

**New file:** `packages/lib/src/control-plane/lifecycle-overlay-guard.test.ts`

**Idiom to mirror:** the subprocess `mock.module` scenario harness in
`packages/lib/src/control-plane/lifecycle.rollback.test.ts` — specifically
`runArmedSnapshotScenario` (lines 232-367), which is the proven template that runs a full
`applyUpdate` to completion with: stateless mock of `rollback.js`, plus mocks for
`compose-args.js`, `docker.js`, `volume-ownership.js`, `config-persistence.js`,
`ui-assets.js` (`applyHomeSeed` no-op), `install-lock.js`, and `addons.js`; temp `OP_HOME`
via the same `makeState()` (writes `knowledge/env/stack.env` with `OP_IMAGE_NAMESPACE=openpalm`
so `performUpgrade`'s `resolveImageNamespace` succeeds); cache-busted dynamic
`import(lifecycleUrl + '?x=' + Math.random())`; outer `bun:test` asserts the subprocess exit
code (and here, also its stderr). `overlay-deprecations.js` is **not** mocked — it reads the
real temp-home file, which is the unit under test.

Harness deltas vs the template (one parameterized `runGuardScenario`):

- `delete process.env.OP_SKIP_COMPOSE_PREFLIGHT` in the scenario script (the template *sets*
  it; these tests must exercise the preflight block).
- Mock `compose-args.js` `buildComposeOptions` to return `files: ['<home>/system/stack/core.compose.yml']`
  (non-empty so the preflight block is reached; path existence is irrelevant — `docker.js` is mocked).
- Mock `docker.js` per scenario: `checkDocker` → `{ ok: scenario.dockerOk, ... }`;
  `composePreflight` → `{ ok: scenario.preflightOk, stderr: 'service "legacy" refers to undefined network channel_lan', ... }`;
  `buildComposePreflightError: (_o, stderr) => 'Compose preflight failed: ' + stderr`;
  `applyStack`/`composeConfigServices`/`resolveComposeProjectName` as in the template.
- Unless a scenario says otherwise, write the stale overlay into the temp home before invoking
  the entry point:
  `config/stack/custom.compose.yml` = `services:\n  legacy:\n    image: example:latest\n    networks:\n      - channel_lan\n`
  (same fixture shape as `overlay-deprecations.test.ts:69-82`).

**Scenarios** (`describe('channel_lan guard is kind-gated (PR #564 r3566892768)')`):

1. `test('applyInstall still blocks on a stale channel_lan overlay reference')`
   Stale overlay; `dockerOk:true, preflightOk:true`. Expect rejection whose message contains
   `channel_lan` **and** `nothing was changed`, and that `custom.compose.yml` is unmodified.
   *Green before AND after the fix* — regression pin so the gate is not over-widened (#490 stays).
2. `test('performUpgrade still blocks on a stale channel_lan overlay reference')`
   Same expectations via `performUpgrade`. *Green before and after* — pin for the primary #490
   scenario (upgrade refreshes the skeleton).
3. `test('applyUpdate proceeds past the guard and logs the rename guidance as a warning')`
   Stale overlay; `dockerOk:true, preflightOk:true`. Expect `applyUpdate` to RESOLVE; outer
   test asserts subprocess stderr contains `channel_lan` and `portal_net` (lifecycle logger's
   `warn` emits JSON via `console.error` → stderr, `packages/lib/src/logger.ts:76`).
   *RED today:* rejects with the blockError instead of resolving.
4. `test('applyUpdate still fails compose preflight when the merged config is invalid')`
   Stale overlay; `dockerOk:true, preflightOk:false`. Expect rejection matching
   `/^Compose preflight failed:/` and NOT containing `nothing was changed`.
   *RED today:* the rejection is the guard's blockError (wrong error). Post-fix it proves the
   demotion did not remove update's fail-closed validation.
5. `test('applyUninstall completes despite a stale overlay and a failing compose preflight')`
   Stale overlay; `dockerOk:true, preflightOk:false`. Expect `applyUninstall` to RESOLVE
   (returns `{ stopped: [] }` — harness state has no running services), overlay file unmodified,
   and stderr containing `channel_lan`/`portal_net`.
   *RED today* (guard throws). **Still RED with Fix 1 alone** (preflight throws) — this is the
   scenario that forces Fix 2, per §1 Correction 2.
6. `test('applyUninstall completes when Docker is unavailable')`
   **No overlay written** (isolates Fix 2 from the guard); `dockerOk:false`. Expect resolve.
   *RED today:* `reconcileCore` throws `Compose preflight failed: Docker is not available…`.

**Existing tests that must stay green unchanged** (no edits to them):
- `overlay-deprecations.test.ts` — the module itself is not modified.
- `cleanup-guardrails.test.ts` Guardrail 11 (:353-371) — source-text check that
  `checkCustomComposeChannelLan(` appears before `return withStackEnvRollback(` inside
  `reconcileStack`; Fix 1 keeps the call in the same position.
- `lifecycle.rollback.test.ts` — untouched paths (its harnesses set `OP_SKIP_COMPOSE_PREFLIGHT`
  and write no overlay, so neither fix changes their behavior).

**Genuinely untestable pieces:** none. Nothing here needs a real Docker daemon; the demoted
warning, the kind gate, and the preflight skip are all observable through the harness. The
end-to-end admin-route behavior (composeDown-then-applyUninstall ordering) has no existing UI
test surface and stays manual (see §5 non-goals).

---

## 3. File-level changes

### 3a. `packages/lib/src/control-plane/lifecycle-overlay-guard.test.ts` (NEW — written first)
As specified in §2. Single parameterized subprocess runner + 6 tests. Match the
single-quote style of `lifecycle.rollback.test.ts`.

### 3b. `packages/lib/src/control-plane/lifecycle.ts` (two hunks, no signature changes)

**Hunk A — guard gating (replaces lines 241-250).** Keep the existing comment's first
paragraph, append the gating rationale, and gate only the throw:

```ts
  // Overlay deprecation guard (#490): runs BEFORE withStackEnvRollback arms the
  // pre-reconcile snapshot and BEFORE applyHome can overwrite core.compose.yml
  // (core.compose.yml is not in the crash-restore set). A custom.compose.yml
  // that still references the removed `channel_lan` network without defining
  // it itself would otherwise fail later with a cryptic Docker error, AFTER
  // managed files were already overwritten. Fail fast instead, while nothing
  // has changed yet.
  //
  // Only ACTIVATION kinds (install/upgrade) hard-block (PR #564 r3566892768):
  // update/uninstall are maintenance/teardown ops and must not be refused over
  // a deprecated overlay reference — the guard is a textual scan and would even
  // block references that are dormant in the resolved model (inactive profile).
  // They log the same guidance as a warning instead: update still fail-closes
  // in the compose preflight below when the merged config is genuinely invalid,
  // and uninstall must stay usable as the way OUT of a broken-overlay state.
  const overlayCheck = checkCustomComposeChannelLan(state.homeDir);
  if (overlayCheck.blockError) {
    if (activate) throw new Error(overlayCheck.blockError);
    lifecycleLogger.warn(overlayCheck.blockError);
  }
  if (overlayCheck.warning) lifecycleLogger.warn(overlayCheck.warning);
```

Notes: `activate` is already in scope (declared :237). The `warnings` array returned at :320
(`overlayCheck.warning ? [overlayCheck.warning] : []`) is intentionally unchanged — its only
consumer is `performUpgrade` (an activate kind, which still throws on blockError), and
`applyUpdate`/`applyUninstall` do not surface warnings; do not add plumbing.

**Hunk B — preflight gate for the deactivation flow (edits the condition at line 112 and the
comment at 108-110):**

```ts
  // Preflight: validate compose merge before mutation.
  // Mandatory when compose files exist and OP_SKIP_COMPOSE_PREFLIGHT is not set.
  // Fails if Docker is unavailable (Docker is required for any compose operation).
  //
  // EXCEPT the deactivation flow (uninstall): its reconcile performs no compose
  // operation (the route runs composeDown BEFORE calling in, and already
  // tolerates docker-down) and none of its file writes consume the merged
  // model, so validating the model — or requiring Docker at all — would only
  // block teardown on exactly the broken state the operator is trying to leave
  // (stale overlay, stopped daemon). PR #564 r3566892768.
  const { files, envFiles, profiles } = buildComposeOptions(state);
  if (!opts.deactivateServices && files.length > 0 && !process.env.OP_SKIP_COMPOSE_PREFLIGHT) {
```

Everything inside the block (checkDocker throw, composePreflight throw) is unchanged.
`reconcileCore` has exactly one caller (`reconcileStack`), and `deactivateServices` is set only
by the uninstall kind, so this cannot affect install/update/upgrade.

Match the file's surrounding double-quote style; `bun run lint` is the arbiter.

### 3c. `CHANGELOG.md` (unreleased 0.13.0 section, lines ~238-245 — wording truth-up)
The entry currently claims "lifecycle operations now fail fast … when such a reference is
detected". Reword to match the gated behavior, e.g.:
"install/upgrade now fail fast with an actionable message (before changing anything) when such
a reference is detected; update/uninstall log the same guidance as a warning instead of
refusing to run, and warn when an overlay self-defines a deprecated `channel_lan` network."

### 3d. `packages/lib/src/control-plane/overlay-deprecations.ts` (optional, comments only)
The module header (:8-11) and `checkCustomComposeChannelLan` doc (:60-68) describe the
caller's policy ("blockError"). Add one sentence noting the caller hard-blocks activation
kinds only (install/upgrade) and demotes to a warning otherwise. No code changes; the module
stays pure and un-barrel-exported.

**Do not touch:** routes, CLI commands, `docker.ts`, `config-persistence.ts`, any file from
28d1afb/3825e00, `packages/lib/src/index.ts`. No new dependencies.

---

## 4. Verification gates (all must be green)

```bash
# red phase: after writing 3a only — scenarios 3,4,5,6 fail; 1,2 pass
bun test --cwd packages/lib src/control-plane/lifecycle-overlay-guard.test.ts

# green phase: after 3b
bun test --cwd packages/lib src/control-plane/lifecycle-overlay-guard.test.ts \
  src/control-plane/overlay-deprecations.test.ts \
  src/control-plane/cleanup-guardrails.test.ts \
  src/control-plane/lifecycle.rollback.test.ts

# required gates
bun run lint
bun run lib:test
```

(Baseline verified at HEAD: `overlay-deprecations` + `cleanup-guardrails` +
`lifecycle.rollback` = 36 pass / 0 fail.)

Suggested commits (never push):
1. `test(lib): pin kind-gating for the channel_lan overlay guard (PR #564 r3566892768) — red`
2. `fix(lib): channel_lan guard blocks only install/upgrade; uninstall reconcile skips compose preflight (PR #564 r3566892768)`

---

## 5. Out of scope / non-goals / coordination

- **`compose down` on a genuinely invalid merged model still fails** (admin route's
  `composeDown` preflight, CLI `runComposeWithPreflight`, and raw `docker compose down`
  alike): Docker cannot load an invalid project to tear it down. Pre-existing,
  not channel_lan-specific, and not fixable safely at this layer (continuing past a failed
  `down` would report success with containers running). If the reviewer wants a follow-up,
  it is a separate issue ("uninstall route: surface remediation guidance when composeDown
  preflight fails"), not part of c9.
- **No route/UI changes.** The uninstall route's `composeDown → applyUninstall` ordering and
  its `dockerAvailable` reporting already fit the fixed lib behavior.
- **No auto-rewrite** of user overlays (config/ ownership rule; migrations framework removed).
- **No change to `performUpgrade` warnings plumbing** or `UpgradeResult`.
- **Sibling coordination:** none needed. No other review-564 cluster touches lifecycle,
  uninstall, or preflight (verified across `c1…c10` briefs); the shared-username-default
  coordination note applies to c1/c2 only and does not intersect these files.
