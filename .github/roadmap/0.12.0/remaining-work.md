# OpenPalm 0.12.0 — Remaining Work to Completion

**Branch:** `release/0.12.0`
**Compiled:** 2026-06-13
**Method:** Every slice in `.github/roadmap/0.12.0/implementation-plan.md` was re-verified against the actual tree by five parallel verification agents (one per workstream). This document supersedes `STATUS-0.12.0.md`, which is badly stale.

---

## SESSION UPDATE — 2026-06-13 (implementation pass complete)

All workflow-able remaining slices were implemented and **verified green** by the orchestrator (not just agent reports): `bun run test` 1039 pass / 0 fail; UI vitest 835 pass / 0 fail; `npm run check` 0 errors/0 warnings; CLI typecheck exit 0.

**Now complete:** A2a, A2b (+tests), A3 (+tests), A6 (dedup + guardian skip-if-modified), A7 (+tests), B1, B3 (scanner collapse + 4 pinning tests), B5 (wording + snapshot test), C1 (nested binds done earlier + startup warning + doc fix), C2, C3 (registry→addons rename), C4 (sensitivity split + injection removal + copy-only migration), D2a (direct-tier tests), D4 PR-4 leftovers (CHANNEL_*_SECRET rows + getCoreSecretMappings legacy scan + comment scrub), D5a (no-defect partitioning disposition + mDNS scaffold), E4 (lib/wizard→lib/client rename), plus the **composite upgrade exit-gate test**.

**Remaining follow-ups (NOT done):**
1. **E3 — RESOLVED (PASS, 2026-06-14).** The wizard UX validation gate was re-run against the redesigned 4-step flow (the prior 2026-06-13 FAIL audited the now-replaced 8-step wizard). Deterministic floor driven to P0=0/P1=0 by 7 contrast/reflow/target-size fixes (`--color-text-tertiary`/`--color-success-text` darkened, new `--color-accent-text`, dark-on-orange active tick, mobile ticker hidden to kill a 375px reflow, disabled-button opacity 0.55→0.7, review links min-height:24px). All three independent judges (a11y, IA/flow, visual) returned PASS with zero blocking items; the three prior-FAIL IA classes (dead Edit route, lying "install without AI" CTA, sticky-bar review occlusion) were source-confirmed eliminated. Fresh artifact: `.reviews/ux-gate-wizard/decision.json` (prior FAIL preserved as `decision-prev-8step-fail-2026-06-13.json`). UI unit suite 830/830 green after the token changes.
2. **GitHub issue hygiene** — body rewrites + move #398→0.13.0 + close fixed bugs #481–#485.
3. **D5a mDNS — RESOLVED.** The avahi `apk add` sidecars were removed and replaced with OpenCode's native in-process mDNS responder (`server.mdns` / `server.mdnsDomain` in the assistant/guardian `opencode.jsonc`), default-OFF and LAN-first. No image-baking needed. Known limit: OpenCode hardcodes the service-instance label `opencode-<port>` (only the resolved `.local` hostname is customizable), and the loopback-only guardian moderator cannot advertise — its LAN-facing front door is named by the host OS. See `docs/technical/network-partitioning-d5a.md`.
4. **Vitest teardown hang (cosmetic)** — benign upstream Vite8/SvelteKit chokidar teardown race; all 835 tests pass, only a "close timed out" warning. Do NOT "fix" it by removing the browser test project (that drops 145 component/a11y tests).

---

## 0. Reconciliation note — STATUS-0.12.0.md is wrong

`STATUS-0.12.0.md` claims ~25% complete (4 of 28 slices). **That is incorrect.** The bulk of the milestone landed in one squashed foundation commit (`08702efb feat: land 0.12 setup and ingress foundations`) plus the portal-refactor commits, none of which the STATUS file reflects. Verified true state: **~85% complete.** Most implementation is present and the guardian test suite (143 pass / 0 fail) and migration suite (32 pass / 0 fail) are green.

Two assumptions in the original plan are now **false against the tree** and require no further work:
- **D3 (MCP gateway) IS built** — `containers/guardian/src/mcp.ts` exists with `@modelcontextprotocol/sdk`, `ask_assistant` tool, static bearer, `GUARDIAN_MCP` gate.
- **HMAC transport IS fully removed** — `signature.ts`/`replay.ts` deleted, no `/channel/inbound`, zero `x-channel-signature` in code. (`forward.ts` survives but is unrelated session-management code, not the dead HMAC forwarder.)

All 9 owner decisions in the plan (§7, lines 459-467) have been **answered inline** — there are no open owner blockers. The relevant answers are folded into the steps below.

---

## 1. Verified slice status (all workstreams)

| Slice | Verified status | Remaining work summary |
|-------|-----------------|------------------------|
| **A1** error mapper | ✅ DONE | — |
| **A2a** createState purity | ⚠️ PARTIAL | delete `cli/src/lib/env.ts`; rename/inline setup helpers; add purity test |
| **A2b** deploy spine | 🟡 impl DONE | missing AC tests (collision retry, lock concurrency, label match) |
| **A3** deploy journal | 🟡 impl DONE | missing AC tests (journal round-trip, resume, mtime, 0600) |
| **A4** wizard subprocess | ✅ DONE | — |
| **A5** port-check robustness | ✅ DONE | — |
| **A6** managed-asset list | ⚠️ PARTIAL | delete `MANAGED_STACK_ASSETS` dup; guardian skip-if-modified + test |
| **A7** #440 consumers | 🟡 impl DONE | missing AC tests (probe TTL, CLI status snapshot, no-disk-parse spy) |
| **B1** CLI correctness gate | ⚠️ PARTIAL | wire CLI `typecheck` into CI |
| **B2** migration harness | ✅ DONE | — |
| **B3** per-image pinning | ⚠️ PARTIAL | collapse 3 tag scanners; add 4 AC pinning tests |
| **B4** docs + CI grep gates | ✅ DONE | — |
| **B5** snapshot/prune | ⚠️ PARTIAL | fix `--force` wording; add armed-snapshot behavior test |
| **B6** behavior tests | ✅ DONE | — |
| **C1** OP_BIND_ADDRESS | ⚠️ PARTIAL | startup non-loopback warning; fix stale doc table |
| **C2** compose honesty | ⚠️ PARTIAL | remove `OP_DOCKER_SOCK` from `.env.example` |
| **C3** lib dead-code purge | ⚠️ PARTIAL | rename `registry.ts` → `addons.ts` (file + test + imports) |
| **C4** addon config → stack.env | ❌ PENDING | entire slice (sensitivity split, kill injection, migration, tests) |
| **D0a** pre-work deletions | ✅ DONE | — |
| **D0b** image bakes adapters | ✅ DONE | — |
| **D1** principal registry | ✅ DONE | — |
| **D2a** front-door delta | 🟡 impl DONE | missing direct-tier tests |
| **D2b** listeners + admin CRUD | ✅ DONE | — |
| **D3** MCP gateway | ✅ DONE | — |
| **D4** dissolve transport | ⚠️ PARTIAL | PR-4 leftovers (2 deletions) + cosmetic comments |
| **D5a** networking + mDNS | ❌ NOT STARTED | secure-partitioning verification + mDNS, or disposition |
| **D5b** rename + dual-network | ✅ DONE | — |
| **E1** dead CSS | ✅ DONE | — |
| **E2** shared components | ✅ DONE | — |
| **E3** delete wizard.css | ⚠️ PARTIAL | post-typography 3-judge UX gate re-PASS |
| **E4** client constants dedup | ⚠️ PARTIAL | rename `lib/wizard/` → `lib/client/` |
| **F1** CLI agents in image | ✅ DONE | — |
| **F2** Connections subtab | ✅ DONE | — |
| **F3** MCP consumption docs | ✅ DONE | — |
| **Exit gate** composite upgrade | ❌ NOT STARTED | gated on D5b (now unblocked) |

**Net remaining:** 12 slices with work + the exit gate + issue hygiene. Of these, only **C4** and **D5a** are net-new implementation; the rest are deletions, renames, wording fixes, or AC-test backfill.

---

## 2. Remaining work — detailed steps

Steps are grouped by workstream. Each is independently shippable, must stay green on `bun run test` + `bun run ui:test:unit` + `bun run ui:check` (+ `guardian:test`/`cli:test` where touched), and must not perform destructive ops on any `OP_HOME` content.

### WS-A — Setup robustness

#### A2a — finish createState purity (real code work)
1. **Delete `packages/cli/src/lib/env.ts`** (both `ensureStackEnv` + `ensureSecrets`). `ensureStackEnv` has no remaining CLI callers; `ensureSecrets` is only imported by a test.
   - Update `packages/cli/src/main.test.ts:639` — replace the `ensureSecrets` import with lib's `mkdirSync` equivalent or drop the test branch.
2. **Rename `buildSecretsFromSetup` → `buildOwnerEnvFromSetup(owner)`** (`packages/lib/src/control-plane/setup.ts:80`, called `:195`) and **inline `buildSystemSecretsFromSetup`** (`setup.ts:125`) into its single caller (`setup.ts:213`).
3. **Add a lib test** asserting `createState` performs zero filesystem writes and zero `process.env` mutation (spy on `fs` + `process.env`). This AC test is currently absent.

#### A2b — backfill deploy-spine AC tests
4. Add lib tests in/near `deployment-scenarios.test.ts`:
   - Collision detection fails **closed with retry** (`detectProjectCollision` retries `[0,1s,1s]` then refuses).
   - Health rows match by `com.docker.compose.service` label (not `-{service}-1` suffix).
   - **Lock-held-through-deploy concurrency:** a full `runDeploy` holding the lock does not false-refuse, while a second concurrent `runDeploy` DOES refuse.

#### A3 — backfill journal AC tests
5. Add lib vitest: journal round-trip (`writeJournal`/`readDeployJournal`); dead-PID + `deploying:true` journal hydrates to `interrupted`; journal file mode is `0600`.
6. Add a UI test asserting the retry-deploy route leaves `knowledge/secrets/` + akm config **mtimes unchanged** (it must run only the spine, never `performSetup`).

#### A6 — finish managed-asset dedup + guardian semantics
7. **Delete `MANAGED_STACK_ASSETS` + `refreshManagedStackAssets`** from `packages/ui/src/lib/server/ui-assets.ts:122-140`. Repoint its two callers (`:176`, `:214`) and the scenario test (`deployment-scenarios.test.ts:173`) at lib `refreshCoreAssetsFromSource` / `MANAGED_ASSETS`.
8. **Implement skip-if-user-modified for managed `config/guardian/` assets** (owner decision #1 = **approved**, manage `instructions/moderation.md`):
   - Keep a manifest of shipped-default hashes; refresh a managed `config/guardian/` file only if it is still byte-identical to *some prior shipped default*; user-modified files are kept with a surfaced "new default available; yours kept" notice.
   - Amend `docs/technical/core-principles.md` in the same change (owner approval #5 = granted).
   - Add the skip-if-user-modified test.

#### A7 — backfill #440-consumer AC tests
9. Add a probe-TTL vitest for `listRemoteStatuses` / `remoteStatusCache` (in-memory only, never written to the 0600 config).
10. Add a CLI `status` snapshot test (`packages/cli` has no status test today).
11. Add a spy test proving no request-path disk parse of `stack.env` after `OP_SETUP_COMPLETE` flips true.
12. (Optional) expand the hooks vitest into a full routing-table (each `LaunchStatus` → route).

### WS-B — Upgrade/migration robustness

#### B1 — wire CLI typecheck into CI
13. Add a `cd packages/cli && bun run typecheck` step to the quality-gates job in `.github/workflows/ci.yml` (the `"typecheck": "tsc --noEmit"` script exists and passes; CI just doesn't run it — only `packages/ui` check runs at `ci.yml:140`).

#### B3 — finish per-image pinning
14. **Collapse the three tag scanners** `resolveNewestDockerTag` (`lifecycle.ts:201`), `resolveNewestDockerTagForCurrentMajor` (`:223`), `resolveNewestDockerTagAtOrBelow` (`:293`) into one with `{ sameMajorAs?, atOrBelow? }` constraints.
15. **Add the 4 missing B3 AC tests** (no `image-tags.test.ts` / `pin.test.ts` exists): (a) pinned key survives `performUpgrade`; (b) `--unpin` restores auto-resolution; (c) cross-boundary pin (`portal`/`guardian` `< 0.12.0` vs platform `≥ 0.12.0`) produces the `unsupported-cross-boundary-pin` warning; (d) release migration unaffected by pins.

#### B5 — fix wording + add behavior test
16. **Fix the `--force` prompt wording** at `packages/cli/src/commands/install.ts:202` (and the stale comments at `:191-192`, `:209`): it says "**move** the existing OpenPalm install"; the code uses `cpSync` (copies, original stays). Change to "backed up (copied)".
17. **Add the armed-snapshot protection behavior test:** `reconcileCore` skips re-snapshot while `hasArmedSnapshot()` is true (no test references `hasArmedSnapshot`/`armed` today).
18. **Confirm backup-retention prune semantics** match owner decision #3: keep upgrade backups for one major release plus all intermediate minors (e.g. upgrading to 1.0.0 retains 0.13.x; a minor upgrade retains the one prior minor). The `openpalm backups prune --keep N` command exists and is confirm-gated — verify/adjust the default retention to honor this policy and document it. **No automatic pruning** (command only).

### WS-C — Env/compose simplification

#### C1 — startup warning + doc fix
19. **Add a structured non-loopback warning** at UI/CLI startup when `OP_BIND_ADDRESS` ≠ loopback, listing any per-service bind overrides in the same message. (Compose nested-defaults, SSH literal, phantom-var deletion, and CI grep gate are all already done.)
20. **Fix the stale doc table** `docs/technical/environment-and-mounts.md:210,215` — show the nested-default form `${OP_<SVC>_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}` and **delete the reference to `OP_OLLAMA_BIND_ADDRESS`** (the var was removed from code).

#### C2 — finish compose honesty
21. **Remove `OP_DOCKER_SOCK`** from `/.env.example:41` (the only remaining C2 item; dead labels, network comment, `COMPOSE_PROFILES`, and write-only schema knobs are already deleted per owner decision #4).

#### C3 — finish the rename
22. **Rename `packages/lib/src/control-plane/registry.ts` → `addons.ts`** (the "spec/registry" era is over). Rename `registry.test.ts` → `addons.test.ts`. Update all imports (e.g. `setup.ts:33` `./registry.js` → `./addons.js`) and the barrel. (All other C3 deletions/unifications are done.)

#### C4 — entire slice (net-new — the only fully pending simplification)
> **Sequencing note:** C4 depends only on A2a. The plan assumed A2a deleted the `process.env` mass-injection, but it was only *moved* — it now lives at `lifecycle.ts:82` inside `initializeStateSecrets`. C4 must delete it.
23. **Split sensitive/non-sensitive in the credentials route** `packages/ui/src/routes/admin/addons/[name]/credentials/+server.ts:171`: non-`@sensitive` schema fields (e.g. `DISCORD_ALLOWED_GUILDS`, `OP_VOICE_WHISPER_MODEL`) → **stack.env** via `writeStackEnv`; `@sensitive` fields stay as compose `secrets:` files. Today `writeStackSecretEnv` writes *every* key to `knowledge/secrets/`.
24. **Delete the `process.env` mass-injection** `Object.assign(process.env, readStackSecretEnv(state.stackDir))` at `lifecycle.ts:82`; confirm compose substitution still sees values via `--env-file` (`docker.ts:27`).
25. **Add a copy-only, idempotent release migration** that copies existing non-sensitive values from `knowledge/secrets/<key>` files into stack.env keys — **skip if key exists; never delete the source files** (user data).
26. **Add tests:** migration idempotency/copy-only; Discord/Slack config reaches containers via a compose-config render assertion; `secrets.ts` hygiene guard updated.

### WS-D — Standards-based ingress

#### D2a — backfill direct-tier tests
27. Add guardian tests for the `kind:'direct'` path (implemented in `proxy.ts` but entirely untested): (a) moderation block → prompt-rewrite produces a native refusal turn (mock upstream); (b) moderator-unreachable (fail-closed) → same refusal rewrite; (c) direct-tier per-principal rate limit (gate 1c) fires **before any upstream call**. Channel-tier 403/fanout behavior is already tested and must stay green.

#### D4 — finish PR-4 leftovers
28. **Delete `getCoreSecretMappings` legacy dynamic `CHANNEL_*_SECRET` scan** at `containers/guardian/.../secret-mappings.ts:104-116` (or its current path) — `migrations.ts` is the only legitimate legacy reader.
29. **Delete the four `CHANNEL_*_SECRET=` addon-schema rows** in `registry.ts` (lines ~37/45/52/101, with their stale "HMAC secret" comments). These configured the dead HMAC era; the secret *files* are system-generated and survive (Basic credential source). Confirm no consumer breaks — these two deletions are coupled.
30. (Cosmetic, low priority) Scrub stale `channels-sdk` doc comments in `forward.ts:6`, `proxy.ts:10`, `moderation.ts:7`, `event-fanout.ts:136`, `oc-bounds.ts:186`; fix the stale `channel_lan`/"signing" docstring in `scripts/oc-e2e.ts`.

> **Do NOT delete in 0.12.0** (deferred to 0.13, per the transition story): compose channel-secret declarations/grants, `ensureChannelSecret`/`channelSecretName`, `CHANNEL_*_SECRET_FILE` guardian envs, the `channel_lan` network definition. And **never** delete users' `knowledge/secrets/channel_*_secret` files — they are the live Basic credential source.

#### D5a — networking partitioning + mDNS (net-new; pre-rename gate, owner decision #7)
> Owner decision #7 (resolved) defines the concrete symptoms: *"verify that we are securely partitioning network traffic so that only the guardian, host, and optionally the host LAN can access the assistant container directly. The guardian should be exposable on the host's LAN with mDNS as `assistant-name-guardian.local`; if the assistant is enabled for LAN access, mDNS as `assistant-name.local`."*
31. **Root-cause + verify secure partitioning** in `.openpalm/config/stack/*.yml`: confirm only the guardian (plus host, and optionally host LAN) can reach the assistant container directly; the assistant's `assistant_net` membership is minimal; nothing else needs `assistant_net`. Fix the topology in the **same managed-asset refresh** if a defect is found, **or** record an explicit written "no-defect" disposition on #436 with a compose-fixture test.
32. **Add mDNS support:** guardian advertises `assistant-name-guardian.local` when LAN-exposed; assistant advertises `assistant-name.local` when the assistant is LAN-enabled. Wire the publishing into the stack (compose + any required sidecar/avahi config), default-off and LAN-gated.
33. Add the compose-fixture test pinning the partitioning + the mDNS naming scheme.

### WS-E — Wizard dedup + design system

#### E3 — UX gate re-pass (blocking the wizard merge)
34. **Re-run the full 3-judge UX gate AFTER the wizard adopted app typography** (wizard.css is deleted; typography changed). The only existing artifact `.reviews/ux-gate-wizard/decision.json` is the **pre-deletion #457 run (2026-06-11)** and references `wizard.css` throughout — it does not satisfy this AC.
   - Process (per memory): dispatch the 3 web-UX judges **sequentially** (chrome-devtools profile contention); capture screenshots up front (320/768/1280 + dark); point the dev wizard `OP_HOST_UI_PORT` at a free port; **restart vite before re-audit** (stale static `wizard.css` cache); verify `npm run ux:audit` deterministic floor is green and dark-mode token inheritance works.
   - Produce a fresh PASS `decision.json`.

#### E4 — finish client constants dedup
35. **Rename `packages/ui/src/lib/wizard/` → `packages/ui/src/lib/client/`** (it is consumed by admin voice + FriendlyError, not just the wizard) and update all `$lib/wizard/...` import paths (8+ files: ModelsStep, ProvidersStep, OptionsStep, VoiceStep, ProgressBar, +page.svelte, VoiceEngineSelector, DeployStep). (Provider-constants subpath, mirror deletion, browser-guard test, and providers-endpoint dedup are all done.)

---

## 3. Milestone exit gate (now unblocked — D5b is done)

#### Composite upgrade proof test (NOT STARTED)
36. Build one populated **0.11.5 fixture home**: channels enabled, a custom service in `custom.compose.yml` attached to `channel_lan`, one non-default per-service bind var, addon non-secret config stored as secret files.
37. Run the **full upgrade sequence twice**. Assert: all expected stack.env keys present; no user-file content changes outside documented writes (mtime/byte assertions on `custom.compose.yml`, secret files, user env); guardian principal seed idempotent; `docker compose config` validates (`skipIf` no docker CLI, per the `extends-support.test.ts` precedent — no running stack required).
38. This is the cross-migration interaction catch (C4 copying into a stack.env other migrations touch; D5b key copies; refreshed compose referencing migration-produced vars). It must land **after** C4 and D5a so their migrations are exercised.

---

## 4. Issue hygiene (non-code; do before milestone close)

Per plan §2.3. These are body rewrites and milestone moves, not code:
39. **Rewrite issue bodies to remaining-work-only** (strike shipped items, cite commits): **#465** (only the AC-test backfill + A6 dedup remain), **#440** (consumer tests only), **#441** (DONE — close), **#477/#436/#429/#434** (note what shipped vs the small deltas above).
40. **#439** — already CLOSED. Confirm `.reviews/ux-gate-wizard` artifacts referenced and leave closed.
41. **#398** (Azure Container Apps draft PR) — **move to the 0.13.0 milestone** (owner decision #9 = move, not close).
42. Bug issues **#481–#485** are already filed (dead CLI spawner, guardian textSync auth, `state.imageTag` phantom, `uncomment:true`, fetch timeouts) — all are FIXED in the tree (A4/D0a/B1/B2). **Verify and close each.**

---

## 5. Recommended completion sequence

Most remaining items are independent and parallelizable. Recommended order respecting the few real dependencies:

**Wave 1 — quick, zero-risk, no dependencies (parallel):**
- B1 (CI typecheck wiring) · C2 (`.env.example`) · C1 step 20 (doc fix) · B5 step 16 (`--force` wording) · D4 steps 28–30 (PR-4 deletions + comments) · E4 step 35 (`lib/wizard/`→`lib/client/` rename) · C3 step 22 (`registry.ts`→`addons.ts` rename)
- *Caution:* C3 and D4-registry both edit `registry.ts` → do **not** run those two concurrently (rename vs row-deletion conflict). Sequence: do D4 row-deletion first, then the C3 rename, or vice versa in one agent.

**Wave 2 — net-new code (parallel, but watch `lifecycle.ts`):**
- A2a (steps 1–3) · A6 (steps 7–8) · B3 (steps 14–15) · C1 step 19 (startup warning) · D2a tests (step 27) · D5a (steps 31–33)
- *Caution:* A2a, A6, B3, C4 all touch `lifecycle.ts` and/or `secrets.ts` — **serialize** anything editing `lifecycle.ts`; verify git state after any parallel dispatch (known failure mode).
- **C4 (steps 23–26)** runs after A2a (it removes the injection A2a relocated to `lifecycle.ts:82`).

**Wave 3 — test backfill (parallel, after their impl waves):**
- A2b (step 4) · A3 (steps 5–6) · A7 (steps 9–12) · B5 step 17 (armed-snapshot test)

**Wave 4 — gates (last, sequential):**
- E3 (step 34, UX gate re-pass) — long pole, schedule judge time.
- Composite exit gate (steps 36–38) — **must come after C4 + D5a** so their migrations are exercised.

**Wave 5 — issue hygiene (steps 39–42)** — anytime, but finish before tagging.

---

## 6. Cut-line if 0.12.0 slips (from plan §4)

Drop in this order: **F-slices** (already done, n/a) → then if needed **D5a/D5b networking** can slip together, but D5b already shipped, so D5a would ship as a written "no-defect / deferred-mDNS" disposition rather than slipping the rename. The HMAC removal and adapter migration are already complete and cannot be cut. The realistic slip candidates are **D5a's mDNS** (could ship as documented-future-work) and **C4** (could defer the migration to 0.13 if the credentials-route split proves risky). Everything else is small enough to finish.

---

## 7. Owner decisions — all resolved (reference)

| # | Decision | Resolution |
|---|----------|------------|
| 1 | Guardian moderation assets management | **Manage** `instructions/moderation.md` with skip-if-user-modified (A6 step 8) |
| 2 | #436 rename name | **portals** (done) |
| 3 | Backup retention policy | Keep 1 major + all intermediate minors; one prior minor on minor upgrades (B5 step 18) |
| 4 | Write-only schema knobs | **Delete** anything not useful (done) |
| 5 | Edit `core-principles.md` | **Approved** |
| 6 | Descope transactional install | **Agreed** — restore-point + journal + reconcile test only |
| 7 | #436 Part 2 networking symptoms | Secure partitioning (guardian/host/LAN → assistant) + mDNS `assistant-name-guardian.local` / `assistant-name.local` (D5a steps 31–33) |
| 8 | Deferred admin surfaces (pin UI, principals tab) | Deferred — CLI/curl + stack.env are the 0.12.0 surfaces |
| 9 | #398 Azure Container Apps PR | **Move to 0.13.0** (step 41) |
