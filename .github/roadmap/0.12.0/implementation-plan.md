# OpenPalm 0.12.0 — End-to-End Milestone Plan (FINAL)

> **Provenance:** drafted by a 5-mapper/3-critic agent team on 2026-06-11; statuses verified against `main` at `d37e7857`. This final revision incorporates all 9 must-fix and the accepted should-fix items from three adversarial reviews (simplicity, migration-safety/security, feasibility); every disputed claim was re-verified against the tree before incorporation.

Repo: `/home/founder3/code/github/itlackey/openpalm` @ `d37e7857` (main). All paths below are repo-relative unless prefixed with `OP_HOME`.

---

## 1. Executive summary

0.12.0 ships four things, in the owner's priority order:

1. **Robust setup and upgrade.** The deploy pipeline becomes one shared lib spine with a disk-persisted journal, restart-resume, retry-that-only-redeploys, fail-closed collision detection, label-based health matching, and friendly error mapping shared by CLI and UI. The spine lands in two slices (state-factory purity first, then the spine itself) so the safety-critical path is never a big-bang PR. The migration harness keeps its copy-only/backup-first/stamp-last invariants and loses its duplicated orchestration, its dual-meaning `OP_RELEASE_VERSION`, and its two shell-script clones. `#440` launch routing finally gets consumers: splash route, hooks rewrite, CLI status. A new cross-slice acceptance test proves the headline #465 scenario: re-running install over a damaged 0.11.x home converges to a working stack.
2. **Simplification everywhere.** ~1,000+ lines of verified-dead code get deleted (registry remote machinery, dead CLI OpenCode spawner, dead CSS, dead env keys, no-op allowlists, duplicate assemblers, source-regex tests). Every cleanup is folded into the slice that touches that file — nothing deferred.
3. **Standards-based ingress.** The bespoke HMAC channel **transport** dies in 0.12.0; the channel **credential files survive** and become the Basic-auth secret source, so upgrades are zero-touch. Sequence: `#433` sqlite principal registry (Basic auth, seeded from the existing `channel_*_secret` files) → `#429` moderating front door (auth seam, direct-principal tier, loopback port, prompt-rewrite block) → `#432` MCP gateway → `#434` adapters become official `@opencode-ai/sdk` clients, baked into the channel image from the workspace — **all npm publication of channel packages stops**, and channels-sdk dissolves → `#436` rename lands last, in-repo only, with both Docker networks kept alive for one release so user overlays never break.
4. **One design system.** `static/setup/wizard.css` (1,509 lines) is deleted; the three wizard-bespoke patterns become shared components (props preserved — no data-flow rewiring this milestone); ~150 lines of dead app.css go with it. The wizard re-passes the un-gameable UX gate before merge.

End state: a clean, robust stack that installs in one pass, upgrades non-destructively, resumes after a crash, and speaks standard OpenCode/MCP at its edges — with a written cut-line so a slip strands nothing half-migrated.

---

## 2. Ground truth

### 2.1 Already shipped — do NOT re-plan (issue bodies are stale; the tree wins)

| Issue claim | Tree reality (evidence) |
|---|---|
| #465 "managed compose assets are seed-if-missing" | **Half-stale.** CLI install/re-install refreshes them (`ui-assets.ts:122-140,176,214`, the #472 fix; pinned by `deployment-scenarios.test.ts:161-186`) and upgrade refreshes with hash-compare+backup (`core-assets.ts:97-168`). Only the **UI rerun/applyUpdate path** is still seed-if-missing (`config-persistence.ts:319-328`). |
| #465 image-tag pinning, single setup writer, docker-down 503, self-healing lock, pull retries, collision detect | All shipped (`setup.ts:236-249`, `complete/+server.ts:80-98`, `install-lock.ts:98-145`, `setup-deploy.ts:394-460`, `docker.ts:97-129`). |
| #440 | Lib keystone done with table tests (`launch-status.ts:86-157`, commit a3525f51). **Zero consumers** — all consumer work remains. |
| #441 | Code-side **complete**: `stack-spec.ts` deleted; `OP_ENABLED_ADDONS` wired end-to-end; only the migration converter reads legacy `stack.yml`. Remaining: docs + CI grep gate. |
| #477 | Compose vars, release-migration seed, lag-behind fallback all shipped (`image-tags.ts`, `migrations.ts:418-441`, `lifecycle.ts:292-330`). Remaining: independent pin surface, pin-clobber fix, per-image newest resolution, release-workflow outputs. |
| #429 "build a proxy" | **Mostly built and live-verified**: allowlist, ownership, fan-out, bounds, write-path moderation, drift gate, idempotent session create (`core/guardian/src/{proxy,event-fanout,ownership,oc-bounds,drift,moderation}.ts`). Remaining is exactly the delta in §WS-D D2a/D2b. |
| #434 "preserve rich Discord UX" | Already free: adapters consume native OpenCode event shapes today (`oc-events.ts`), and `@opencode-ai/sdk@1.15.13` is already a channels-sdk dependency. |
| #395 "bare var renders bind-all" | Currently guarded: every compose bind reference carries the literal `:-127.0.0.1` default. Remaining: the global var (as a **nested default**, see C1), the CI grep gate, the startup warning. |
| #436 "channel detection by directory convention" | Already compose-derived (`channels.ts:65-88`). Also: **voice is NOT guardian-fronted** (assistant_net, host-consumed) — issue text grouping voice with channel listeners is wrong. Part 2 ("fix/align Docker networking, symptoms TBD") is **unresolved input** — see D5a. |
| #439 UI overhaul | Complete through f55e843a; the stricter gate (`npm run ux:audit`) exists. Close-or-verify only. |

### 2.2 Unfiled bugs found by the mappers (file as issues, fix in the slices noted)

1. **Dead CLI OpenCode spawner** — `packages/cli/src/lib/opencode-subprocess.ts:62` uses `dirname` without importing it; throws `ReferenceError` on every `ui serve`; swallowed at `ui-server.ts:89-92`. Fix = **delete** (WS-A A4).
2. **Latent guardian auth break** — four copies of upstream Basic-auth construction call `Bun.file(path).textSync()`, which does not exist; the documented `OPENCODE_AUTH=true` hardening path silently sends no credential (`proxy.ts:88-95`, `forward.ts:25-32`, `event-fanout.ts:48-62`, `drift.ts:34-48`). Fix = delete the dead plumbing now, reintroduce ONE working helper if/when `OPENCODE_AUTH` is actually wired (WS-D D0a).
3. **Phantom `state.imageTag`** — `packages/cli/src/commands/update.ts:53` reads a property that doesn't exist on `ControlPlaneState`; prerelease installs never track the `next` UI channel. No typecheck gate covers the CLI (WS-B B1).
4. **Vestigial empty `config/stack/auth.json` seed** — `install.ts:327-328`; canonical file is `knowledge/secrets/auth.json` (`paths.ts:24`, `core.compose.yml:73`). Delete the seed (WS-A A4). Code was re-introduced *because the docs are wrong* — fix the doc in the same change.
5. **`mergeEnvContent` `uncomment:true` on upgrade** resurrects deliberately commented-out user keys (`lifecycle.ts:378,524`) (WS-B B2).
6. **No timeout on Docker Hub/GitHub fetches** — a hung registry hangs "Update now" forever (`lifecycle.ts:231-265`) (WS-B B2).

### 2.3 Issue hygiene actions

- **#465**: rewrite body to the remaining-work list (journal/resume, retry-deploy, UI-rerun asset refresh, error mapping, label matching, port-check, fail-closed collision, subprocess reaping, runtime detection, reconcile-on-install acceptance test). Strike the shipped items, cite commits. Record the descope of "transactional install" to restore-point + resumable journal (owner decision #6).
- **#440**: update body — keystone done, list consumer work only.
- **#441**: retitle "docs + CI grep gate"; code conversion is complete.
- **#477**: retitle "per-image pinning + release outputs"; compose/migration plumbing shipped; note the single-surface decision (CLI flag only, see B3).
- **#429**: rewrite body to the remaining delta; note the proxy is live-verified on main.
- **#434**: append corrections: `constantTimeEqual` has a surviving channel-api consumer (inline it); `parseIdList` has three adapter consumers (kit module); `extractChatText`/`asRecord` have a single surviving consumer (inline into channel-api); `assistant-client` survives trimmed in the guardian (moderation); `oc-events` is also a guardian dep; Discord `/clear` needs an /oc replacement; **npm publication of channel packages ends in 0.12.0** (the only stack consumer was the boot-time `bun add`, which dies).
- **#436**: correct the issue: voice/ollama are not channels; networks are plain bridges; rename decision needed from owner (recommendation: **portals**) **before D4 starts**; Part 2 networking symptoms must be enumerated by the owner (owner decision #7).
- **#439**: verify the gate decision artifacts exist (`.reviews/ux-gate-wizard`) and **close**.
- **#398** (open draft PR, Azure Container Apps deployment plan): orthogonal to every 0.12.0 workstream — review with the owner and either close or move to the 0.13.0 milestone. It must not linger unmilestoned.
- **File new issues** for bugs 1, 2, 3, 5, 6 above (1-3 can fold into #465/#440 checklists if preferred).

---

## 3. Workstreams

Conventions for every slice: independently shippable, green on `bun run test` + `bun run ui:test:unit` + `bun run ui:check` (+ `guardian:test`, `cli:test`, `sdk:test` where touched); tests never require a running stack (mock `@openpalm/lib`, temp `OP_HOME` via the existing bunfig/vitest tripwire); **no destructive ops on OP_HOME content, ever** — all listed deletions are git-tracked source files.

---

### WS-A — Setup robustness (#465 remaining + #440 consumers) — P1

**Goal:** install/deploy survives crashes, restarts, flaky daemons, and re-runs; CLI and UI share one deploy spine in lib; launch routing replaces the blunt `/setup` redirect.

#### A1 — One error mapper in lib
- **Work:** Build `mapDockerError(stderr)` in `packages/lib/src/control-plane/compose-errors.ts` on top of `summarizeComposeStderr`/`parseComposeStderr`. Keep the existing 5 patterns; add platform-mismatch, private-pull/unauthorized, OOM, healthcheck-failure. Fall-through returns the **summarized first line**, never raw stderr. UI `setup-deploy.ts:123-141` and `complete/+server.ts:43-65` syscall mapping collapse onto it; CLI `deployServices` uses it.
- **Cleanup folded in:** delete `allServiceImagesPresent` (keep `missingServiceImages`, derive the boolean) — `setup-deploy.ts:544-621`. Drop the braille-spinner `SERVICE_ERROR_RE` reliance where `compose ps --format json` works; keep `summarizeComposeStderr` as the only fallback parser.
- **Files:** `packages/lib/src/control-plane/compose-errors.ts`, `packages/ui/src/lib/server/setup-deploy.ts`, `packages/ui/src/routes/api/setup/complete/+server.ts`, `packages/cli/src/commands/install.ts`.
- **AC:** table test in lib mapping representative stderr fixtures → friendly codes; UI/CLI emit identical messages for the same failure; no raw multi-line stderr reaches the wizard.
- **Deletions:** UI-local `mapDockerError`, route-local syscall map, `allServiceImagesPresent`.

#### A2a — `createState` purity + one stack.env seeder
*(Split from the draft's A2: the state-factory change is a cross-cutting behavioral change every CLI/UI entry point implicitly depends on — it gets its own slice, its own tests, and C4 depends only on it, not on the spine.)*
- **Work:** `createState` becomes pure path resolution. Move `ensureSecrets(bootstrapState)` + the `Object.assign(process.env, readStackSecretEnv(stackDir))` mass-injection (`lifecycle.ts:68-69`) out of the factory and into the lifecycle entry points that actually need them — **audit every `createState` callsite** (CLI commands, UI server modules, tests) and add the explicit calls where behavior depends on them. Delete CLI `ensureStackEnv` + the mkdir-only `ensureSecrets(dataDir)` in `packages/cli/src/lib/env.ts` — lib `writeSystemEnv`/`generateFallbackSystemEnv` is the single stack.env seeder. Rename `buildSecretsFromSetup` → `buildOwnerEnvFromSetup(owner)` and inline `buildSystemSecretsFromSetup` (`setup.ts:80-91,125-131`).
- **Files:** `packages/lib/src/control-plane/lifecycle.ts`, `setup.ts`; `packages/cli/src/lib/env.ts` (deleted); callsites across CLI/UI.
- **AC:** `setup.test.ts`, `install-edge-cases.test.ts`, `lifecycle.rollback.test.ts` green; a new test asserts `createState` performs zero filesystem writes and zero `process.env` mutation; each entry point that previously depended on the implicit injection has an explicit-call test.
- **Deletions:** `packages/cli/src/lib/env.ts` (both functions), factory side effects.

#### A2b — Shared deploy spine in lib (fail-closed, label-matched, lock-owned, re-entrant)
- **Work:** Lift the deploy sequence (collision check → applyInstall → buildManagedServices → pull-with-retry → up `--force-recreate --remove-orphans` → health poll) into `packages/lib/src/control-plane/deploy.ts` with plain progress callbacks (`onPhase(phase, detail)`). UI adds journal/poll; CLI prints. Within it:
  - `detectExistingProject` fails **closed** on `docker ps` error, with 2 retries (≈1s apart) before refusing — addresses the flaky-daemon false-refusal risk (`docker.ts:108`).
  - Health rows match by `com.docker.compose.service` (the `Service` field `parseComposePsOutput` already reads) — kill the `-{service}-1` suffix heuristics (`setup-deploy.ts:240-243`).
  - The **install lock is held for the whole deploy**, not just `applyInstall` — closes the CLI/UI interleave window (`setup-deploy.ts:326-335`).
  - **Lock re-entrancy (verified hazard):** lifecycle entry points acquire the install lock internally (`lifecycle.ts:140,154,164,393`) and `ensureMigrated` acquires it too (`migrations.ts:512,620`). A spine that holds the lock while calling `applyInstall` would false-refuse on every deploy. Mechanism: the spine acquires once; lifecycle functions accept an optional already-held lock handle (and skip acquisition when given one); `ensureMigrated` runs strictly **before** the spine in both CLI and UI flows. No lock wrapper class — one optional parameter.
- **Cleanup folded in:** delete the copy-pasted `projectNameForState` (`install.ts:148-150` / `setup-deploy.ts:33-35` → one lib export).
- **Files:** new `packages/lib/src/control-plane/deploy.ts`; `lifecycle.ts`, `docker.ts`; `packages/ui/src/lib/server/setup-deploy.ts`; `packages/cli/src/commands/install.ts`.
- **AC:** `setup.test.ts`, `install-edge-cases.test.ts`, `deployment-scenarios.test.ts`, `lifecycle.rollback.test.ts`, `guardian-gating.test.ts` stay green (zero-channel installs must not health-wait on guardian); new lib tests: collision fail-closed-with-retry, label matching, lock-held-through-deploy, **full spine run with the lock held does not false-refuse while a concurrent second orchestrator DOES refuse**. CLI deploy now reports friendly errors and polls health (via the spine).
- **Deletions:** duplicated deploy code in `install.ts:152-185` and most of `setup-deploy.ts:325-535`, `projectNameForState` copy.

#### A3 — Deploy journal + restart-resume + retry-deploy
- **Work:** Persist deploy state as a dumb JSON file `OP_HOME/data/setup/deploy-journal.json` written via `writeFileAtomic` on every phase transition (phase, per-service status, error, imageWarning, startedAt, pid). On ui-serve boot, `getDeployState` hydrates from it; a journal with `deploying:true` + dead PID surfaces as `interrupted` with a Retry action. New `POST /api/setup/retry-deploy` runs **only** the deploy spine (no `performSetup` re-run); wizard `handleDeployRetry` (`+page.svelte:1308-1317`) calls it. **The retry-deploy route carries the same `OP_SETUP_COMPLETE` binary guard as the other `/api/setup/*` routes** (it is a mutating pre-auth-adjacent endpoint) — pinned by a vitest. Add a cheap pre-`performSetup` backup of `stack.env` + `knowledge/secrets/` (small files) to a timestamped directory **under the existing `resolveBackupsDir()` root, reusing the same timestamp-dir convention and copy helper that `core-assets.ts:144-150` already uses** — no sixth backup mechanism, the same one with a `-setup` suffix. This is the pragmatic answer to "transactional install": keep the resumable contract, add a restore point; do **not** build a transaction engine (zero-abstractions; descope recorded as owner decision #6).
- **Cleanup folded in:** `markSetupComplete` becomes `writeFileAtomic(path, mergeEnvContent(existing, { OP_SETUP_COMPLETE: "true" }))` — delete the 30-line hand-rolled merge (`setup-deploy.ts:150-179`).
- **Files:** `packages/lib/src/control-plane/deploy.ts` (journal helpers live in lib so CLI can read them too), `packages/ui/src/lib/server/setup-deploy.ts`, new `packages/ui/src/routes/api/setup/retry-deploy/+server.ts`, `packages/ui/src/routes/setup/+page.svelte`.
- **AC:** vitest: journal round-trip; resume-after-restart shows interrupted state; retry endpoint does not rewrite secrets/akm config (assert file mtimes unchanged); retry endpoint 4xx-refuses once `OP_SETUP_COMPLETE=true`; journal file mode 0600.

#### A4 — Wizard OpenCode subprocess sanity
- **Work:** **Delete** `packages/cli/src/lib/opencode-subprocess.ts` and the pre-spawn block in `ui-server.ts:74-92` (dead since the `dirname` bug; the UI ensure route is the single implementation). In `routes/api/setup/opencode/ensure/+server.ts`: add an in-flight promise guard (second POST awaits the first), reap the old `_proc` before replacing, handle reject-after-resolve by clearing `_proc/_url`, and **stop writing `process.env.OP_OPENCODE_URL`** — return the URL to the wizard client and keep it in module state only, so the post-deploy admin UI default endpoint (`lib/server/endpoints.ts:1-16`) is never repointed at the temp instance. Delete the vestigial `config/stack/auth.json` seed (`install.ts:327-328`).
- **AC:** vitest with a fake spawn: double-POST yields one process; exit-after-resolve clears state; `process.env.OP_OPENCODE_URL` untouched.
- **Deletions:** `opencode-subprocess.ts` (121 lines), ui-server pre-spawn block, auth.json seed lines.

#### A5 — Port-check + runtime detection robustness
- **Work:** `portHeldByOurContainer` retries once on docker error and, when docker is unreachable, system-check reports `portCheckReliable:false` and **does not mark conflicts blocking** (`system-check/+server.ts:14-34,90-104`; `SystemCheckStep.svelte:60-63,222` — gate Continue only on genuinely-reliable conflicts). Extend `detectRuntime` (`launch-status.ts:149-157`) to identify OrbStack/Podman from `docker version`/server identity strings — informational only, surfaced in system-check and splash. "Stale-config detection" is deliberately reduced to: launch-status reports when `.skeleton-version` ≠ current release (A6 makes auto-refresh the actual fix; a detector beyond that is unjustified complexity).
- **AC:** unit tests for the failure paths; with docker down, system-check shows degraded-but-not-blocking.

#### A6 — One managed-asset list; refresh on every apply path; reconcile-on-install proof
- **Work:** Single `MANAGED_ASSETS` list in `core-assets.ts`; `refreshManagedStackAssets` becomes `refreshCoreAssets` with a content-source parameter (local skeleton dir vs GitHub fetch), keeping the per-file backup convention (`core-assets.ts:144-150`). `writeRuntimeFiles` (UI rerun / `applyUpdate` path) refreshes managed compose files instead of seed-if-missing (`config-persistence.ts:319-328`); `custom.compose.yml` + `opencode.jsonc` stay strictly SEEDED (never overwritten).
- **Guardian moderation assets (owner decision #1):** if the owner approves managing `config/guardian/instructions/moderation.md`, it gets **skip-if-user-modified semantics, NOT blind backup-then-overwrite** — `config/guardian/` is documented user config (core-principles §1), and the existing `MANAGED_ASSETS` mechanism (`core-assets.ts:134-154`) overwrites on any hash mismatch, which would silently replace a user-tuned moderation prompt (a live behavior change). Mechanism: keep a manifest of shipped-default hashes; refresh only files still byte-identical to *some prior shipped default*; user-modified files get a surfaced notice ("new default available; yours kept"). Amend core-principles in the same approved edit.
- **Cross-slice acceptance test (the #465 headline scenario, composed behavior proven here):** fixture of a corrupted/partial 0.11.x OP_HOME (stale `core.compose.yml`, missing stack.env keys, half-written secrets dir) → `openpalm install` reconciles managed assets, seeds missing system files, preserves user files byte-for-byte, and reaches a green health poll (compose invocations mocked — no stack required).
- **AC:** `deployment-scenarios.test.ts` extended: UI-rerun over a stale home refreshes core.compose.yml, preserves custom.compose.yml byte-for-byte; per-file backups created; the reconcile-on-install fixture test above; skip-if-user-modified test for any managed `config/guardian/` file.
- **Deletions:** `MANAGED_STACK_ASSETS` duplicate list + `refreshManagedStackAssets` in `ui-assets.ts:122-140`.

#### A7 — #440 consumers: hooks, splash, status
- **Work:**
  1. **Hooks rewrite** (`hooks.server.ts:121,134-136`): single per-request resolution; module-level memo once `isSetupComplete` flips true (invalidated by `markSetupComplete` in the same process — required to avoid the wizard redirect-loop); routing decided by `deriveLaunchStatus` → `recommendedRoute` (`/chat` | `/splash` | `/setup`). SEC-1..4 and the `:169` setup-path login exclusion preserved verbatim — covered by existing hooks tests plus new routing-table tests.
  2. **Local health mapper**: lib function mapping `compose ps` (label-matched, from A2b) → `running | installed_offline | installed_broken`, behind a short TTL cache (5s) so hooks never block. Critical rule: `OP_SETUP_COMPLETE=false` **but containers healthy** routes to `/chat`-capable splash, not the wizard (the slow-deploy case).
  3. **Splash route** `routes/splash/`: renders `LaunchStatus` — local state, runtime info, per-remote status, actions (open setup / retry deploy via A3 / pick remote). Root `+page.ts:5` routes via `recommendedRoute`.
  4. **Remote reachability collector** in `lib/server/endpoints.ts`-adjacent module: probe all endpoints.json entries (2s timeout, TTL-cached in memory), map to the existing `RemoteStatus` shape (`launch-status.ts:44-50`). Results live in memory only — never written back to the 0600 user-owned config file.
  5. **CLI**: `openpalm status` prints the same LaunchStatus (replacing bare `compose ps`); `ensureValidState` consults `classifyLocalInstall` for friendly not-installed errors.
  6. Collapse the two routing `isSetupComplete` callsites; the binary guards in `/api/setup/*` routes legitimately stay.
- **Files:** `packages/ui/src/hooks.server.ts`, new `routes/splash/`, `packages/ui/src/routes/+page.ts`, `packages/ui/src/lib/server/endpoints.ts` (+ new probe module), `packages/cli/src/commands/status.ts`, `packages/cli/src/lib/cli-state.ts`, `packages/lib/src/control-plane/launch-status.ts`.
- **AC:** routing-table vitest for hooks (each LaunchStatus → route); probe TTL test; no request-path disk parse of stack.env after completion (assert via spy); CLI status snapshot test; splash passes `ui:check`.

**WS-A deletion inventory (all git-tracked):** `packages/cli/src/lib/opencode-subprocess.ts`; `packages/cli/src/lib/env.ts`; UI `mapDockerError` + syscall map + `allServiceImagesPresent` + hand-rolled `markSetupComplete` merge + duplicated deploy sequence; `install.ts` auth.json seed + `deployServices` body; `MANAGED_STACK_ASSETS`. **Nothing under OP_HOME is touched destructively.**

---

### WS-B — Upgrade/migration robustness (#441 finish, #477 finish, harness hygiene) — P1

#### B1 — CLI correctness gate
- **Work:** Fix `update.ts:53` to use `result.imageTag` from `performUpgrade`; add `"typecheck": "tsc --noEmit"` to `packages/cli/package.json` and wire into CI alongside existing gates.
- **AC:** typecheck passes; a regression test pins the UI channel selection for prerelease tags.

#### B2 — Migration harness: one orchestrator, one stamp meaning, bounded network
- **Work:**
  - **`OP_RELEASE_VERSION` = the deployed platform image tag, period.** `ensureMigrated` stops stamping `CURRENT_RELEASE_VERSION` (host lib version); on unstamped homes it seeds from `OP_IMAGE_TAG` (existing fallback `migrations.ts:152-166`); only the upgrade paths re-stamp to the resolved tag. Release-migration selection therefore can never run "ahead" of the deployed platform.
  - **Never stamp a non-comparable value.** The `OP_IMAGE_TAG` fallback can yield `latest` or a local dev tag; stamping that would make the "re-run all release migrations" state permanent, leaving every future upgrade dependent on perfect idempotency of all past migrations forever. Rule: if the resolved tag isn't comparable semver, keep the prior comparable stamp (or leave unstamped) and log a structured note.
  - **Dedup orchestration:** `ensureMigrated` runs layout migrations then calls `ensureReleaseMigrated` — delete the embedded duplicate loop (`migrations.ts:539-545`) and the ~70 duplicated lock/backup/stamp lines.
  - **Fast path stops writing:** stamp only when values differ; no unlocked stack.env rewrite on every call (`migrations.ts:493-498`).
  - Fix `ensureMigrated` half-honoring `opts.homeDir` (`migrations.ts:457-470` re-resolves from `process.env.OP_HOME`).
  - Add `AbortSignal.timeout(10_000)` to `fetchDockerTagsPayload`/`isDockerImageTagPublished` and the GitHub asset fetches.
  - Drop `uncomment:true` from the upgrade-path `mergeEnvContent` calls (`lifecycle.ts:378,524`) — commented-out user keys stay commented.
- **AC:** `migrations.test.ts` idempotency/non-destructive/backup-abort suite green and extended (stamp-only-on-diff, homeDir consistency, **`OP_IMAGE_TAG=latest` home upgrades without `OP_RELEASE_VERSION` ever being stamped `latest`**); `upgrade-path.test.ts` release-ordering green; new test: hung-registry mock times out with a friendly error.

#### B3 — #477 finish: independent per-image pinning (one surface)
- **Work:** Pins are explicit data: `OP_PINNED_IMAGES=guardian,channel` in stack.env — a hand-editable key, documented as the primary interface (manual file management must suffice, per core-principles). `updateStackEnvToLatestImageTag`/`buildPlatformImageTagEnv` skip keys whose service is pinned (fixes the clobber at `lifecycle.ts:375-379` / `image-tags.ts:17-27`). **One tooling surface only:** CLI `openpalm pin --guardian <tag>` / `--unpin` (pinning is a recovery/power action). The admin endpoint and `UpdatesTab.svelte` picker from the draft are **deferred to a named owner decision** — UI surface for a power-user escape hatch is unjustified in its first release. Per-image **newest** resolution: when unpinned, resolve each image to its newest published tag ≤ platform tag (the existing lag-behind scanner, now also exposed per-image for display). `platform-release.yml` emits per-image tag outputs. `OP_VOICE_IMAGE_TAG` stays **out** of the platform chain (out-of-band publishing; ROCm probe already guards).
- **Cross-boundary pin warning (auth transition support):** when a pinned `channel`/`guardian` tag is `< 0.12.0` while the platform tag is `≥ 0.12.0`, the CLI/upgrade path emits a structured warning that mixed-auth pinning across the 0.12 boundary is **unsupported** (0.12.0 ships Basic-only guardian ingress — see D4/§5). Upgrade notes say the same.
- **Cleanup folded in:** collapse the three near-identical tag scanners (`lifecycle.ts:176-188,198-209,268-280`) into one with `{sameMajorAs?, atOrBelow?}`.
- **AC:** lib tests: pinned key survives `performUpgrade`; unpin restores auto-resolution; cross-boundary pin produces the warning; release migration unaffected. `lifecycle.rollback.test.ts` green.

#### B4 — #441 finish: docs + CI grep gates
- **Work:** Fix `docs/technical/core-principles.md` §1b (delete `stack.yml` as a live file; `auth.json` → `knowledge/secrets/auth.json`; `stack.env` → `knowledge/env/stack.env`; fix `:102,:294` addon-enable wording; fix the `GUARDIAN_SECRETS_PATH` ghost at `:268`) — this doc is "authoritative" and requires the owner's explicit approval to edit, per its own header; get that approval first. Fix `CLAUDE.md` (`stack.yml` capabilities line, `stack/addons/<name>/` drop-in, auth.json path, dead `channel:voice:dev` script row). Delete the stale comment `packages/ui/src/lib/wizard/types.ts:143` and `core.compose.yml:21` comment. Add a CI "stack hygiene" job: (1) grep gate — no `stack.yml` readers outside `migrations.ts`; (2) grep gate — every host-port bind reference in `.openpalm/config/stack/*.yml` carries a literal `:-127.0.0.1` innermost default (covers C1's nested-default pattern and D2b's guardian publishes; fixture includes both).
- **AC:** CI job fails on a seeded violation in a test branch; docs match `paths.ts`.

#### B5 — Snapshot arming + 0.10 migrator sunset + prune command
*(Retitled from "Backup/rollback consolidation" — this slice does not consolidate the backup mechanisms; see §6 for the explicit justification.)*
- **Work:** **Delete** `scripts/migrate-0.10-to-0.11.sh` (296 lines) and `.ps1` (272 lines) — git-tracked, the lib migration + `openpalm migrate --dry-run` cover the use case; update `RECOVERY_GUIDANCE` (`migrations.ts:445-449`) and `docs/operations/upgrade-0.10-to-0.11.md` to point at the CLI. **Keep** the lib 0→1 layout migration (tested, still the upgrade path for 0.10 homes). Protect the pre-upgrade rollback snapshot: `reconcileCore` skips re-snapshot while an upgrade's snapshot is "armed" until `openpalm rollback` or the next successful upgrade (one timestamp check, `lifecycle.ts:131`). Backup retention/pruning of `data/backups/`: **flagged owner decision — pruning deletes user data**; implement only as an explicit `openpalm backups prune --keep N` command that lists exact paths and requires confirmation. No automatic pruning in 0.12.0.
- **AC:** migration tests green; rollback-snapshot protection has a behavior test; `--force` prompt wording fixed from "moved" to "backed up (copied)" (`install.ts:241`).

#### B6 — Replace source-regex tests
- **Work:** Delete the five source-grep "tests" in `upgrade-path.test.ts:107-142`; replace with mock-asserted behavior tests (composeUp called with `forceRecreate:true`, etc.), reusing the `lifecycle.rollback.test.ts` harness pattern.
- **AC:** same behaviors pinned by real assertions.

**WS-B deletion inventory:** both shell migrators (568 lines), duplicated migration orchestration (~70 lines), two redundant tag scanners, five regex tests, `state.imageTag` phantom.

---

### WS-C — Env/compose simplification (#395 + #436 networking + lib dead code) — P2

#### C1 — #395 `OP_BIND_ADDRESS` via nested defaults (zero-touch, no migration)
- **Work:** Compose bind refs for the host-published optional listeners (chat, api, voice — `channels.compose.yml:13,43`, `services.compose.yml:111,144,177`) become **nested defaults**: `${OP_CHAT_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}` (compose-go supports nesting). Per-service values keep working as overrides; the global becomes the new default; **there is no migration and no conflict case** — a user with `OP_CHAT_BIND_ADDRESS=0.0.0.0` + `OP_API_BIND_ADDRESS=127.0.0.1` keeps exactly that exposure with zero stack.env changes. This replaces the draft's copy-then-drop migration, whose conflict branch silently revoked deliberate LAN exposure (or, read the other way, silently LAN-exposed a loopback service) — precisely the hazard #395 exists to prevent. `OP_ASSISTANT_BIND_ADDRESS` stays separate (isolation invariant). SSH becomes literal `127.0.0.1:` (delete `OP_ASSISTANT_SSH_BIND_ADDRESS` from compose; any stack.env value becomes unread and is left in place). Do NOT seed the global into stack.env. Structured non-loopback warning at UI/CLI startup when `OP_BIND_ADDRESS` ≠ loopback (and per-service overrides are listed in the same warning). CI grep gate (lands in B4's hygiene job) asserts the **innermost literal `:-127.0.0.1`** on every host-port bind. Delete the phantom `OP_OLLAMA_BIND_ADDRESS` schema entry (`registry.ts:149-155`) and its secret-audit row; fix the stale doc table `docs/technical/environment-and-mounts.md:215`.
- **AC:** grep gate green; compose config validates with: nothing set (loopback), `OP_BIND_ADDRESS=0.0.0.0` (all listeners LAN), and a mixed per-service override (override wins over global); pre-existing `OP_CHAT_BIND_ADDRESS=0.0.0.0` home upgrades with identical exposure (compose-asset refresh only, no env writes).

#### C2 — Compose honesty pass
- **Work:** Delete the unread `openpalm.name/description/icon/category/healthcheck` labels (keep `openpalm.profile.*`, the only consumed family — `registry.ts:754-756`); the addons UI keeps `BUILTIN_ADDON_ENV_SCHEMAS` as the single metadata source. Fix or delete the misleading "LAN-restricted" network comments (`core.compose.yml:101-105`) — the *rename* of `channel_lan` itself waits for WS-D D5 to avoid double churn. Delete dead `OP_DOCKER_SOCK` from `.env.example`; document `COMPOSE_PROFILES` as a manual escape hatch in one comment or drop the read (`compose-args.ts:37`) — recommend drop. Delete schema fields with no compose passthrough (`DISCORD_CUSTOM_COMMANDS`, `SLACK_THREAD_TTL_HOURS`, `SLACK_FORWARD_TIMEOUT_MS`, `registry.ts:99,144,147`) or wire them — decide per field with the owner; default delete.
- **AC:** `skeleton-guardrail.test.ts` updated; addon UI renders unchanged.

#### C3 — Lib dead-code purge
- **Work:** Delete the ~250 lines of dead remote-registry machinery (`registry.ts:173,175-206,239-326,328-390,930-968`), their barrel exports (`index.ts:64-81`), their tests; keep `getRegistryAutomation` or inline the akm-improve seed (single caller `setup.ts:350`) — recommend inline + delete; rename file `registry.ts` → `addons.ts`. Delete dead `deriveSystemEnvFromSpec` + tests; move `writeVoiceVars` to `voice-env.ts`; rename/inline `SPEC_DEFAULTS` (the "spec" era is over). Delete the no-op `NON_SECRET_STACK_KEYS` allowlist (`secret-audit.ts:42-69`) and the always-empty allowlist in `secrets.ts:28-32`; one exported `isSecretLikeKey` predicate replaces the three regexes. Unify the two compose-arg assemblers: `docker.ts` `buildComposeArgs` becomes the one implementation; `buildComposeCliArgs` delegates; delete one `collectEnvOverrides` and the wrong doc comment (`compose-args.ts:95-99`). Delete `addonComposePath` (`paths.ts:97`), the `buildComposeFileList` alias, and the unused params on `discoverStackOverlays`/`getRegistryAddonConfig`/etc. **Note:** code stops *reading* `OP_HOME/data/registry/` — it must NOT delete that directory on user machines.
- **AC:** `bun run test` green; barrel compiles; UI build unaffected (`ui:check` + build).

#### C4 — Addon config out of the secrets store; kill the process.env injection
*(Depends on A2a only — not the deploy spine.)*
- **Work:** Non-`@sensitive` addon schema fields (e.g. `DISCORD_ALLOWED_GUILDS`, `OP_VOICE_WHISPER_MODEL`) are written to **stack.env** by the credentials route (`addons/[name]/credentials/+server.ts:171`), not as 0600 secret files; `@sensitive` fields remain compose `secrets:` files. The `Object.assign(process.env, readStackSecretEnv(...))` mass-injection is already gone (A2a) — compose substitution sees the values via `--env-file` (`docker.ts:27`). **Same-change requirement:** release migration copies existing non-sensitive values from `knowledge/secrets/<key>` files into stack.env (copy-only; the old files are left in place — user data, never deleted by us).
- **AC:** migration test (idempotent, copy-only); Discord/Slack config reaches containers via compose-config render assertion; secret files no longer required for non-sensitive keys; `secrets.ts` hygiene guard updated.

**WS-C deletion inventory:** ~250 lines registry dead code + tests, `deriveSystemEnvFromSpec`, no-op allowlists, duplicate assembler, dead labels/env keys/schema fields, `addonComposePath`, phantom ollama bind var, `OP_ASSISTANT_SSH_BIND_ADDRESS`.

---

### WS-D — Standards-based ingress (#433 → #429 → #432 → #434 + #436 rename) — P3

Build order is hard: registry/auth before front door before gateway before adapter migration; rename last, in the same release as the deletions.

**The one auth-transition story (replaces the draft's incoherent "release window"):**
- **Dual-accept (HMAC + Basic) is intra-milestone scaffolding only** — it exists on `main` between D1 landing and D4's HMAC-removal slice, solely so main stays deployable between slices. **0.12.0 releases Basic-only.** No released version carries the dual-auth window. (The draft simultaneously promised a "one release window" and deleted HMAC in the same milestone; and per-image pins *cause* the cross-version skew, they don't prevent it.)
- **Credentials are zero-touch for upgraders and provisioned for fresh installs** because the existing `knowledge/secrets/channel_*_secret` files and their compose `secrets:` declarations/grants (`channels.compose.yml:198-212`, guardian grants `:182-186`) **survive 0.12.0**: the guardian boot-seeds principals from them (token = file contents), and each adapter reads the **same file** as its Basic password via `PRINCIPAL_ID` + `PRINCIPAL_SECRET_FILE` env set in the managed compose. `ensureChannelSecret`/`channelSecretName` and the secret seeding call sites **stay** (fresh installs still need the files generated). Only the HMAC *transport* dies in 0.12.0. Compose secret-block/grant removal is 0.13 work behind a deprecation note and the existing grep-gate pattern.
- **Cross-boundary image pins are unsupported** (channel image `< 0.12.0` against a `≥ 0.12.0` guardian or vice versa): B3 warns; upgrade notes document it.

#### D0a — Pre-work deletions (ship immediately, independent)
- Delete the four broken upstream-auth copies (`Bun.file().textSync()` — never executed) and the unset `OPENCODE_SERVER_PASSWORD` plumbing; if/when `OPENCODE_AUTH` is wired, ONE guardian-local `readFileSync` helper with a real test comes back (`proxy.ts:88-95`, `forward.ts:25-32`, `event-fanout.ts:48-62`, `drift.ts:34-48`). Update `core-principles.md`'s hardening note to match (owner approval per doc header) **and rewrite the `core.compose.yml:45-48` comment** ("set op_opencode_password … and set OPENCODE_AUTH to true") — after this deletion that documented hardening path has no guardian-side implementation; the comment must say so (managed asset, refreshes via A6).
- Delete dead `generateMessageId` + its test + barrel line (`oc-client.ts:250-259`).
- `TURN_IDLE_STATUSES` → `Set(['idle'])` — the drift guard + pinned `OPENCODE_VERSION` handles upstream change, not speculative enum guessing (`oc-events.ts:103`).
- **AC:** `guardian:test` + `sdk:test` green.

#### D0b — Channel image bakes adapters (pulled forward — de-risks all of D4)
- **Work:** Bake the adapter packages into the channel image at build time via **workspace COPY**, exactly the existing pattern (`core/channel/Dockerfile:13` already COPYs `packages/channels-sdk` from the workspace) — per-package layers (Docker Hub giant-layer precedent, commit 1097ce6f); `CHANNEL_PACKAGE` selects the baked package at start; **delete the boot-time `bun add`** (`core/channel/start.sh:16-18`) and the compose `@latest` pins. No npm fetch at build or boot. This is independent of the SDK migration and removes the adapter/guardian skew + non-reproducible-restart risks before D4 begins.
- **AC:** image builds; each baked adapter resolves and starts under `CHANNEL_PACKAGE` selection; no network access during container start (assert no `bun add` in start.sh); pushed layers under Hub limits.

#### D1 — #433 principal registry (bun:sqlite)
- **Work:** `core/guardian/src/state-db.ts`: `bun:sqlite` at `data/guardian/state.db`, mode 0600 (mount already exists, `channels.compose.yml:172`). Table trimmed to columns with 0.12.0 consumers: `principals(id TEXT PK, kind TEXT CHECK(kind IN ('channel','direct')), label TEXT, token_hash TEXT, enabled INTEGER, created_at INTEGER)`. The draft's `persona`/`rate_policy`/`protocols` columns had **zero consumers anywhere in this plan** (prompt enrichment is adapter-side per D4; rate limiting stays the in-memory env-constant scheme, `server.ts:28-31`; MCP auth is a static bearer per D3) — they are added by `ALTER TABLE ADD COLUMN` when their consumer ships (#435 seam = the row shape + `authenticate()`, nothing more). `core/guardian/src/auth.ts`: `authenticate(req) → Principal | null` — parses `Authorization: Basic id:secret`, SHA-256 hash, constant-time compare (inline the 8-line `constantTimeEqual`), in-memory cache keyed by id with invalidation on CRUD. **Boot seeding:** idempotent upsert of one channel-kind principal per existing `CHANNEL_*_SECRET_FILE` env, token = the existing secret value — zero-touch for adapters, and the env/grants survive 0.12.0 (see the transition story above). Guardian accepts **both** HMAC and Basic for channel principals **on main between D1 and D4's HMAC-removal slice only**. Nonce/rate stores stay in-memory, untouched during the scaffolding window. Admin CRUD is deferred to D2b (it needs the loopback listener).
- **Files:** new `core/guardian/src/state-db.ts`, `auth.ts`; `server.ts`, `proxy.ts` (accept Basic alongside HMAC); `core/guardian/package.json` (no new deps — bun:sqlite is built in).
- **AC:** guardian tests: seed-from-env idempotency (re-boot upserts, never duplicates), Basic happy/sad paths, disabled principal rejected, cache invalidation; HMAC paths still green (intra-milestone dual-accept).

#### D2a — #429 front-door delta (guardian-only)
- **Work:**
  1. `authenticate()` from D1 becomes the single inbound auth seam for `/oc/*`; HMAC verification becomes one strategy behind it during the scaffolding window.
  2. **Direct-principal tier:** `kind:'direct'` gets near-full passthrough — still behind write-path moderation, ownership recording, bounds, **and gate-1c rate limiting** (`proxy.ts:243-250`; explicitly pinned, see AC — once `/channel/inbound` and its rate limit at `server.ts:250` die in D4, gate 1c is the only rate limiter left and the direct tier must not bypass it); `kind:'channel'` keeps the 11-route default-deny allowlist.
  3. **Event fan-out:** `Subscriber` gains `kind`; frames without `properties.sessionID` are forwarded to direct subscribers **only through an explicit global-frame type allowlist** (`server.heartbeat`, `server.connected`, `installation.*`) — never "everything without a sessionID" (cross-tenant leak hazard); channel subscribers keep the hard drop (`event-fanout.ts:175-199`).
  4. **Prompt-rewrite block** for direct principals: on moderation block of `message`/`prompt_async`, rewrite the prompt body to a refusal instruction so the assistant emits a native refusal turn — never 403/`text/html` to an SDK-attached client. **Channel tier keeps the 403 JSON** (adapters depend on non-2xx for error surfacing and audit) — per-tier behavior, explicitly tested. **Fail-closed is part of the contract:** a moderation-infrastructure failure (moderator unreachable/unparseable — `moderateMessage` already collapses these to a block, `proxy.ts:430-437`) must produce the same refusal rewrite, never passthrough.
  5. Drift-guard hardening: re-run the 3 `/doc` assertions on upstream `/event` reconnect, not just boot (`drift.ts:200`).
- **Files:** `core/guardian/src/{server,proxy,event-fanout,ownership,drift,auth}.ts`.
- **AC:** guardian tests: tier routing matrix; global-frame allowlist; prompt-rewrite produces native refusal turn (mock upstream) **for both a moderation block and a moderator-unreachable failure**; tier-matrix rate-limit test — per-principal rate limiting fires on the direct tier (429 or rewrite per tier policy) **before any upstream call**; existing channel-tier behavior pinned unchanged.

#### D2b — #429 listeners, gating, admin CRUD API (no UI tab)
- **Work:**
  1. **Two container listeners, two host publishes:** the direct tier (+`/mcp` in D3) is a second `Bun.serve` (`idleTimeout: 0`) on container port 3830, published `${OP_BIND_ADDRESS:-127.0.0.1}:${OP_GUARDIAN_PORT:-3830}:3830` — **no new per-service bind var**; the global from C1 covers it (a user LAN-exposing the stack exposes the direct tier with it, consistent and grep-gated). The admin CRUD API is a separate listener on container port 3831, published with a **literal** `127.0.0.1:${OP_GUARDIAN_ADMIN_PORT:-3831}:3831` — credential CRUD is never reachable on a non-loopback bind, by construction rather than by request filtering. Both publishes are added to B4's grep-gate fixture.
  2. The direct tier is gated by `GUARDIAN_DIRECT_INGRESS` (default off → 404). Guardian deploy gating: extend `hasEnabledChannel` (`lifecycle.ts:566-568`) and compose profiles so the guardian deploys for gateway-only users (`addon.gateway` profile).
  3. **Admin CRUD API only — no UI admin tab in 0.12.0.** `/admin/principals` (list/create/rotate/disable) on the admin listener, token-authed via a new file secret `op_guardian_admin_token` (seeded by lib `ensureSecrets`). The management story for 0.12.0 is curl + docs: direct ingress is off by default and channel principals are boot-seeded with zero user action, so a UI tab is surface for a 0-user feature (draft's tab + host-proxy plumbing dropped; revisit when direct ingress has users).
- **Files:** `core/guardian/src/server.ts` (+ small `admin.ts`); `.openpalm/config/stack/channels.compose.yml`; `packages/lib/src/control-plane/{lifecycle.ts,secrets.ts,config-persistence.ts}` (port + secret seeding); `docs/`.
- **AC:** guardian tests: direct tier 404 when disabled; admin routes absent from the 3830 listener (request to `/admin/*` on the direct port refuses); CRUD auth happy/sad. Loopback-literal admin bind + global-default direct bind asserted in compose fixture test.

#### D3 — #432 MCP gateway (A2A deferred)
- **Work:** `core/guardian/src/mcp/`: `@modelcontextprotocol/sdk` `WebStandardStreamableHTTPServerTransport` served from the direct listener at `/mcp`, static bearer token (file secret), off by default (`GUARDIAN_MCP=0`). One curated tool: `ask_assistant`, routed through the **same** moderation → ownership → bounds → rate-limit pipeline as everything else (the modules are importable guardian-locals). Never shell/edit/file tools. Optional read-only akm tools: **deferred**. A2A: **deferred** entirely (the listener's dispatch is the seam).
- **AC:** guardian test drives a real MCP client handshake over the Web-standard transport in-process; moderation block on `ask_assistant` verified; disabled-by-default verified.

#### D4 — #434 dissolve the bespoke transport (four ordered PRs)
Adapter migration order: **channel-api spike (covers chat+api after the compose consolidation) → slack → discord last** (with its e2e green before the buffered path is deleted). The final deletions are decomposed into four PRs so no single merge is a big-bang:

- **PR-1 — guardian test re-fixture:** rewrite `server.test.ts` (656 lines) + `proxy.test.ts` (628 lines) fixtures from HMAC to Basic **while dual-accept is still on** (possible from D2a onward). The guardian test surface never goes dark.
- **PR-2 — adapter migration (one PR per adapter):**
  1. **Adapter pattern:** each adapter uses `createOpencodeClient({ baseUrl: 'http://guardian:8080/oc', fetch: customFetch })` where customFetch injects `Authorization: Basic <PRINCIPAL_ID:secret-from-PRINCIPAL_SECRET_FILE>` + `x-openpalm-user`. Prompt enrichment adapter-side. Each adapter owns its ~30-line `Bun.serve` + `/health` (BaseChannel dies).
  2. **No extra channel wrapper package:** the branch keeps a single shared runtime surface in `packages/channels-sdk` while the adapters are still being collapsed. The acceptance bar for PR-4 is the same audit discipline the draft called for: every surviving `channels-sdk` export must be justified against current consumers, with zero-consumer code deleted and single-consumer helpers inlined into that consumer. Do not reintroduce a second shared package for channel code during 0.12.0 stabilization.
  3. **Moves into guardian:** `oc-allowlist.ts`, `content-screen.ts`, a trimmed `assistant-client` (create/send/delete only — moderation.ts needs it), a 16-line turn-end definition, a logger copy.
  4. **Discord `/clear`:** adapter calls `DELETE /session/{id}` for its tracked sessions via the allowlist (guardian reuse-cache eviction already exists, `proxy.ts:373-381`); guardian evicts the `(channel,sessionKey)` map entry so the next turn creates fresh. Test before deleting the buffered path.
- **PR-3 — HMAC transport removal:** delete `/channel/inbound` (`server.ts:192-328`), `signature.ts`, `forward.ts`, the HMAC strategy behind `authenticate()`, and `replay.ts`/nonce store (its only consumer was signed-transport replay protection; Basic has no nonces). Rate limiting (gate 1c) stays, principal-keyed. `GUARDIAN_REQUIRE_CHANNEL_SECRETS` stays (its meaning — "refuse to boot without the seed files" — still holds for principal seeding).
- **PR-4 — package + plumbing deletion:** delete the entire `packages/channels-sdk` package (`crypto.ts`, `channel.ts`, `channel-sdk.ts`, `channel-base.ts`, `oc-client.ts`, sdk `assistant-client.ts`, barrel, the rest per the PR-2.2 audit); `secret-mappings.ts:104-116` legacy dynamic scan; `CHANNEL_*_SECRET=` addon-schema entries (the files are system-generated; the schema rows configured the HMAC era); **the channels npm unit in `platform-release.yml:339-398,601-603`** (npm-sdk, npm-channel-api/discord/slack jobs + needs edges) — npm publication of channel packages ends; the only stack consumer was the boot-time `bun add` deleted in D0b. **NOT deleted in 0.12.0 (survive for provisioning — see the transition story):** `ensureChannelSecret`/`channelSecretName` + seeding call sites (`config-persistence.ts:204-210,330-337`, `registry.ts:905-909`), the compose `secrets:` declarations and per-service/guardian grants, the `CHANNEL_*_SECRET_FILE` guardian envs (now the principal seed source), the 0→1 migration's channel-secret split (legacy converter; D1 boot-seeding reads its output). Their removal is a 0.13 line item.
- **Compose consolidation (own PR, inside PR-2's channel-api slice or adjacent):** collapse the duplicate `chat` service — chat and api run the identical package (`channels.compose.yml:7-64`). **The consolidated `api` service carries BOTH profiles `["addon.chat","addon.api"]` and BOTH host publishes** (`…:${OP_CHAT_PORT:-3820}:<port>` and `…:${OP_API_PORT:-3821}:<port>`, both with C1 nested-default binds, mapped to the single container port) **so an existing home with `OP_ENABLED_ADDONS=chat` keeps its `:3820` listener with zero migration** — the draft's plain collapse silently dropped the listener for every chat-enabled upgrader. The service authenticates as the `api` principal; the `chat` principal is still boot-seeded from its surviving secret file (harmless; can be disabled via CRUD).
- **e2e/scripts:** `scripts/oc-e2e.ts` rewritten on the SDK client; Discord e2e (manual smoke) green before its buffered fallback is removed.
- **Security tradeoff doc:** HMAC dropped on the internal hop; compensations = per-principal tokens + docker network isolation + loopback-only host exposure + the C1/B4 bind grep gate; optional mTLS = documented upgrade path, not built. Update `core-principles.md` §Guardian-only ingress + §Addon secret lifecycle (owner approval).
- **AC per adapter slice:** adapter unit tests green on the SDK client; streaming shapes unchanged (oc-events interpreters untouched); guardian dual-accept still serves the not-yet-migrated adapters. PR-3/PR-4 AC: zero references to `x-channel-signature` anywhere; `CHANNEL_SECRET_FILE`-era references confined to the provisioning surfaces listed above + `migrations.ts`; CI grep gate added against HMAC reintroduction. Consolidation AC: 0.11.5 fixture with `OP_ENABLED_ADDONS=chat` → post-upgrade `docker compose config` still renders a listener on `OP_CHAT_PORT` (skipIf no docker CLI, per `extends-support.test.ts` precedent).

#### D5a — #436 Part 2: networking symptoms → root cause → disposition (pre-rename gate)
- **Work:** The milestone issue demands "fix/align Docker networking; concrete symptoms TBD" — the draft silently dropped it. Before the rename: collect the concrete symptoms from the owner/issue thread (owner decision #7); root-cause at `.openpalm/config/stack/*.yml` (candidate questions: does `channel_lan` still earn its keep once adapters are plain SDK clients of the guardian, or is guardian-only reachability sufficient? is the guardian's `assistant_net` membership minimal? does anything besides guardian need `assistant_net`?); either fix the topology in the **same managed-asset refresh** that D5b renames the networks, or record an explicit **"no defect found"** disposition on #436. No speculative topology changes without a named symptom.
- **AC:** #436 carries either a root-caused fix (with compose fixture test) or a written no-defect disposition before D5b merges.

#### D5b — #436 rename (owner decision, executed with D4 complete; dual-network safety)
- **Work:** **Owner must pick the name before D4 starts** (recommendation: *portals*; "paths" collides with filesystem terminology everywhere in this codebase) — D4 creates/moves adapter code once under final names; with npm publication ended (D4 PR-4) this is a **pure in-repo rename with zero npm deprecation churn**. Rename surviving surfaces: package dirs `channel-*` → `portal-*` (workspace-only), `core/channel` image → `portal`, `OP_CHANNEL_IMAGE_TAG` → `OP_PORTAL_IMAGE_TAG`, `CHANNEL_NAME` detection key, lib `channels.ts` → `portals.ts`, env passthroughs. Release migration copies old stack.env keys to new (copy-only; old keys left in place, now unread).
  **Network rename keeps both bridges for one release:** `docs/managing-openpalm.md:112` tells users "channel-style addons join `channel_lan` by default", and `custom.compose.yml` is seeded-never-overwritten user property (`core-assets.ts:105-108`) — a refreshed `core.compose.yml` that *removes* the `channel_lan` definition would fail `docker compose config` for any user overlay referencing it, taking the **whole stack** down post-upgrade. So: the refreshed `core.compose.yml` defines **both** `portal_net` (active) and `channel_lan` (retained as a deprecated empty bridge — one extra line, zero abstraction); the release migration **read-only scans** `custom.compose.yml` for `channel_lan` references and emits a structured deprecation note pointing at the rename; `channel_lan` removal is scheduled for 0.13, gated by the same scan. Compose rename applied via managed-asset refresh + the upgrade's `--force-recreate` (containers re-attach). Update docs in the same PR.
- **AC:** migration test (old-key home upgrades cleanly, idempotent); **upgrade fixture: 0.11.5 home with a custom service attached to `channel_lan` → post-upgrade `docker compose config` validates and the service still has a network** (skipIf no docker CLI); full-stack compose config validates; grep gate: no `CHANNEL_` env reintroduction outside migrations + the surviving provisioning surfaces.

**WS-D deletion inventory (0.12.0):** `packages/channels-sdk` (entire package after the PR-2.2 export audit), `core/guardian/src/{signature,forward,replay}.ts`, `/channel/inbound` pipeline, HMAC strategy, 4 broken upstream-auth copies, `generateMessageId`, boot-time `bun add` + compose `@latest` pins, duplicate `chat` compose service (consolidated, both profiles kept), `secret-mappings` legacy scan, `CHANNEL_*_SECRET=` schema rows, the channels npm unit in `platform-release.yml`. **Deferred to 0.13 (deliberately NOT deleted):** compose channel-secret declarations/grants, `ensureChannelSecret` plumbing, `CHANNEL_*_SECRET_FILE` guardian envs, `channel_lan` network definition. **User's existing `knowledge/secrets/channel_*_secret` files are never deleted — they are the live Basic credential source (D1 seeds principals from them; adapters read them as passwords).**

---

### WS-E — Wizard dedup + one design system (#458, wizard.css) — P4

Every slice here re-runs `npm run ux:audit`; the final slice re-runs the full 3-judge gate (judges dispatched **sequentially** — chrome-devtools profile contention; capture screenshots up front; dev wizard on a free port; restart vite before re-audit).

#### E1 — Dead-code quick win (no rendering risk)
- **Work:** Delete dead app.css blocks: `.model-toggle` (298-346), `.provider-card` + tokens (146-149, 355-385), `.provider-grid` (348-353, 959-963), `.filter-pills/.pill` (413-446), `.model-row` (448-469), `.provider-group summary` (471-492) — keep `.auth-method-card`. Delete dead wizard.css rules `.adv-toggle` (680-712), `.review-json*` (1014-1049). Retire the `#provider-grid` ID hack once `.provider-grid` is gone (`ProvidersStep.svelte:172`, `wizard.css:388-400`). De-dup the 138-line verbatim provider-card block via one `{#snippet providerCard(ocp)}` (`ProvidersStep.svelte:184-463`). Delete ModelsStep's six hidden test-compat inputs (179-185) and update the tests to assert POST body/state instead.
- **AC:** `ui:test:unit` + `ui:test:e2e:mocked` green (selectors updated in the same PR); visual spot-check at 320/768/1280 + dark.

#### E2 — Shared components (extraction only — no data-flow rewiring)
- **Work:** Extract `common/SelectableCard.svelte` (`.pcard`: header + check + expandable inline panel + verified state), `common/RadioRow.svelte` (`.model-opt`), `common/SettingToggle.svelte` (`.toggle-card/.toggle-track/.toggle-thumb`). Component-scoped styles; preserve every WCAG-annotated rule (contrast comments at wizard.css `:163,:749-752,:1366-1382`); focus management follows the `{@attach}` Drawer precedent (ee7b8d81). **Scope is exactly the three components with props/callbacks preserved as-is.** The draft's "one `$state` wizard object per step" rewiring of the 1,790-line monolith's data flow is **removed from this slice and from 0.12.0** — it isn't required by #458, and rewiring the wizard's entire data flow inside an extraction slice whose downstream (E3) forces a 3-judge gate re-pass makes any gate failure unattributable. It returns, if at all, as its own post-gate slice in 0.13.
- **Files:** `routes/setup/steps/{ProvidersStep,ModelsStep,OptionsStep}.svelte`, new `lib/components/common/*`.
- **AC:** browser-mode component tests (selection, expand, keyboard, focus); mocked e2e green; no prop-contract changes (diff review).

#### E3 — Delete wizard.css
- **Work:** Move page scaffolding (`.setup-page/.wizard-card/.prog-*/.step-*/.welcome-*/.deploy-*/.review-*`, etc.) into scoped styles of `+page.svelte`/`ProgressBar.svelte`/step components (the established pattern); wizard-only tokens (`--color-blue/teal`, `--wizard-toggle-off`) into app.css or scoped; **delete** `static/setup/wizard.css` and the `<link>` at `+page.svelte:1587`. Resolve `.loading-state` to the single app.css definition. The wizard intentionally adopts app typography (`--font-sans` etc. change — rendering WILL differ).
- **AC:** **full 3-judge UX gate re-PASS required before merge** (typography changed); `ux:audit` deterministic floor green; dark mode via token inheritance verified; no stale-static-asset path remains (everything vite-bundled).

#### E4 — Client constants/endpoint dedup
- **Work:** Extend `packages/lib/src/provider-constants.ts` (browser-safe subpath, `package.json:16`) with the missing data; wizard imports it; delete the mirrors (`KNOWN_EMB_DIMS`, `OLLAMA_DEFAULT_CHAT_MODEL`, two extra `addonProfileId` copies at `helpers.ts:9-11` + `+page.svelte:246`). Add a vitest that imports the subpath in a browser-like environment (guards the "Class extends value undefined" regression — the subpath must stay free of node builtins). Rename `lib/wizard/` → `lib/client/` (it's consumed by admin voice + FriendlyError). Collapse `routes/api/setup/opencode/providers/+server.ts:23-49` onto the `catalog.ts loadProviderPage` union helper (extract the small union into `lib/server/opencode/`).
- **AC:** `ui:check` + unit green; one server-side source of truth for "connected" providers.

**WS-E deletion inventory:** `static/setup/wizard.css` (1,509 lines), ~150 lines dead app.css, 138-line duplicate markup, hidden test inputs, constant mirrors, the providers-endpoint re-implementation.

---

### WS-F — Assistant extras (#479, #480, #343-A) — opportunistic

#### F1 — #479 CLI agents in the assistant image
- **Work:** `core/assistant/Dockerfile`: install codex, claude-code, pi, copilot CLIs as **per-package RUN layers** with find-scoped chmod (Docker Hub giant-layer precedent, commit 1097ce6f). Smoke: `docker build` + `--version` per tool in the image-build workflow.
- **AC:** image builds; pushed layers under Hub limits; assistant boot unaffected.

#### F2 — #480 Connections subtab
- **Work:** Admin mind-tab "Connections" subtabs per CLI tool: detect configured state (read-only checks of the tool's config under `data/assistant/`), and a "use existing provider" action that writes the tool's credential file host-side from `knowledge/secrets/auth.json` where mappings are 1:1 (e.g. codex ← openai key). Keep it dumb: per-tool detect + one write action; no abstraction layer over four config formats.
- **AC:** vitest for the mapping writers (temp OP_HOME); no secret values in client payloads or logs.

#### F3 — #343 scope A (MCP consumption)
- **Work:** Documentation + a commented `mcp` block example in `.openpalm/config/assistant/opencode.jsonc` (seed-only file — existing installs read the docs). No code. Serving MCP is D3.
- **AC:** docs build; jsonc still parses.

---

## 4. Sequencing

```
Phase 1 (now, parallel)          Phase 2                      Phase 3                        Phase 4
─ WS-A A1,A4,A5 (independent)    ─ WS-A A7 (#440 consumers)   ─ WS-D D1 (#433 registry)      ─ WS-D D4 PR-1 (test re-fixture)
─ WS-B B1,B2 (harness first)     ─ WS-C C1 (bind + gates)     ─ WS-D D2a (front-door delta)  ─ WS-D D4 PR-2 adapters
─ WS-E E1 (dead code)            ─ WS-C C2,C3,C4 (C4 ⫶ A2a)   ─ WS-D D2b (listeners+CRUD)      api(+chat consolidation)→slack→discord
─ WS-D D0a (deletions)           ─ WS-B B3,B4,B5,B6           ─ WS-D D3 (MCP)                ─ WS-D D4 PR-3 (HMAC removal)
─ WS-D D0b (image baking)        ─ WS-E E2,E4                 ─ WS-E E3 (gate re-pass)       ─ WS-D D4 PR-4 (package+plumbing del.)
then B2 → A2a → A2b → A3 → A6                                 ─ WS-F F1,F2,F3                ─ WS-D D5a (networking disposition)
                                                                                             ─ WS-D D5b (rename, dual-network)
                                                                                             ─ composite migration test (§5)
```

Rationale and ordering rules:
- **P1 first:** WS-A and WS-B open the milestone. B2 (harness/lifecycle hygiene) lands **before** A2a — both edit `lifecycle.ts`; serializing the overlap avoids churn. **A2a → A2b → A3 → A6 are strictly ordered** (factory purity, then spine, then journal on the spine, then asset-refresh through the spine). C4 depends only on A2a, so WS-C is unblocked early. A7 needs A2b's label-matched health for its local-health mapper.
- **C1 before D1/D2:** the bind grep gate must exist in CI **before** the auth change ships (#395 risk note: the gate lands in the same milestone as the auth change, not after). D2b's guardian publishes reuse C1's global var + B4's gate.
- **D0b ships in Phase 1:** image reproducibility is independent of the SDK migration and removes the skew risk before any auth work begins.
- **Owner decision #2 (rename: portals vs paths) is required before D4 starts** — adapters are created/moved once under final names; no double churn.
- **WS-D is strictly sequential internally** (registry → front door → gateway → adapters → HMAC removal → deletions → networking disposition → rename). D5b never ships without D4 complete.
- **WS-E is fully parallel** (UI-only); E3's gate re-pass is the long pole — schedule judge time.
- **WS-F is independent**, image-side; runs whenever.
- **Cut-line (explicit slip order for a ~30-slice milestone):** if 0.12.0 slips, drop in this order: **F2 first**, then **D3** (MCP — the listener dispatch is already the seam), then **D4 PR-3/PR-4 + D5a/D5b slip together as one atomic unit to 0.13.0** — in that contingency 0.12.0 ships the dual-accept guardian (HMAC + Basic both live; the §5 transition row's "intra-milestone scaffolding" becomes a one-release window, which is the acceptable fallback variant — but then the deletion inventory and the zero-HMAC grep gate move to 0.13.0 with it; the plan never claims both). D1/D2 still ship value standalone. **D5b never ships without D4 complete.**
- Parallel-agent hygiene: slices touching `lifecycle.ts`, `setup-deploy.ts`, `channels.compose.yml` must not be dispatched concurrently; verify git state after any parallel dispatch (known failure mode).

---

## 5. Migration & back-compat strategy

All migrations are **copy-only, idempotent, stamp-last**, gated on `OP_LAYOUT_VERSION` (unchanged at 1 — no layout moves this milestone) and `OP_RELEASE_VERSION` (release migrations, semantics fixed by B2 to mean "deployed platform tag"; non-comparable tags are never stamped). Every entry gets a `migrations.test.ts` case (re-run no-op, user-edited destination preserved) plus an upgrade-path test from a 0.11.5 fixture home.

| Breaking change | Migration step | Gate | Proof test |
|---|---|---|---|
| Addon non-secret config → stack.env (C4) | Release migration copies values from `knowledge/secrets/<key>` files into stack.env keys; **skip if key exists; never delete the files** | `OP_RELEASE_VERSION` | Fixture with `DISCORD_ALLOWED_GUILDS` secret file → key in stack.env, file untouched; second run no-op |
| HMAC transport removal; Basic-only guardian (D1/D4) | **No credential migration needed**: `knowledge/secrets/channel_*_secret` files + compose grants survive 0.12.0; guardian boot-seeds principals from them (idempotent upsert, token = file contents); adapters read the same file as Basic password via compose-set `PRINCIPAL_ID`/`PRINCIPAL_SECRET_FILE`. Dual-accept exists only on main between D1 and D4 PR-3 — **0.12.0 releases Basic-only**. Cross-boundary image pins (channel <0.12 vs guardian ≥0.12) are unsupported: B3 warns, upgrade notes document | none (zero-touch) | 0.11.5-fixture upgrade test: boot the seeded guardian state and assert an adapter Basic-auth round-trip succeeds; seed idempotency on re-boot; post-PR-3 grep gate (zero `x-channel-signature`) |
| chat+api compose consolidation (D4) | None — consolidated service carries **both** profiles `[addon.chat, addon.api]` and both host port publishes; old `OP_ENABLED_ADDONS=chat` values keep working | asset refresh | 0.11.5 fixture with `OP_ENABLED_ADDONS=chat` → post-upgrade `docker compose config` renders a listener on `OP_CHAT_PORT` (skipIf no docker CLI) |
| Per-service bind vars get a global default (C1) | **None — nested defaults** `${OP_<SVC>_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}`: existing per-service values keep working as overrides; nothing copied, nothing dropped, no conflict case | asset refresh | Fixture with `OP_CHAT_BIND_ADDRESS=0.0.0.0` keeps LAN exposure post-upgrade with zero env writes; default home renders loopback; mixed override fixture renders per-service value |
| channel→portal env/key renames (D5b) | Release migration writes new keys copied from old; old keys left in place, unread. Refreshed `core.compose.yml` defines **both** `portal_net` and deprecated `channel_lan`; migration read-only scans `custom.compose.yml` for `channel_lan` refs and emits a deprecation note; `channel_lan` removal is 0.13, gated on the scan | `OP_RELEASE_VERSION` + asset refresh | Old-key fixture upgrades, stack validates, second run no-op; **fixture: custom service attached to `channel_lan` → post-upgrade compose config validates, service networked** |
| `OP_RELEASE_VERSION` semantics (B2) | No data migration — code change; unstamped homes seed from `OP_IMAGE_TAG` (existing fallback); non-comparable values are never stamped | n/a | Test: ensureMigrated never writes the host lib version; `OP_IMAGE_TAG=latest` never stamped |
| Per-image pins (B3) | Additive `OP_PINNED_IMAGES`; nothing seeded | n/a | Pinned tag survives `performUpgrade`; cross-boundary pin warns |
| SSH bind hardcoded loopback (C1) | Compose asset change only; `OP_ASSISTANT_SSH_BIND_ADDRESS` becomes unread (left in stack.env if present) | asset refresh | compose config renders `127.0.0.1:` literal |

**Composite upgrade proof (milestone exit gate, lands with D5b):** one populated 0.11.5 fixture home — channels enabled, a custom service in `custom.compose.yml` attached to `channel_lan`, one non-default per-service bind var, addon non-secret config stored as secret files — runs the **full upgrade sequence twice**. Assertions: all expected stack.env keys present; no user-file content changes outside documented writes (mtime/byte assertions on `custom.compose.yml`, secret files, user env); guardian principal seed idempotent; `docker compose config` validates (skipIf no docker CLI, per `extends-support.test.ts` precedent — no running stack). Per-slice tests catch local regressions; this catches cross-migration ordering/interaction bugs (C4 copying into a stack.env other migrations touch; D5b key copies; refreshed compose referencing migration-produced vars).

Invariants preserved everywhere: full-home backup before layout migrations; per-file backups before managed-asset overwrite; `migrations.test.ts` idempotency/non-destructive/backup-abort suite must stay green through every WS-B/WS-D change.

---

## 6. Cleanup / simplification pass (every finding → fix → slice)

| Finding | Fix | Slice |
|---|---|---|
| Two wizard-OpenCode spawners; CLI one dead (`dirname` bug) | Delete CLI module + pre-spawn | A4 |
| Three stack.env seeders (CLI `ensureStackEnv`, lib `writeSystemEnv`, `ensureSystemSecrets` header) + name-colliding `ensureSecrets` | One lib writer; delete CLI copies | A2a |
| Two managed-asset lists/refreshers | One list, one routine with a content source | A6 |
| `allServiceImagesPresent` / `missingServiceImages` near-dup | Keep one | A1 |
| Three disjoint error mappers | One lib `mapDockerError` | A1 |
| `buildSecretsFromSetup(connections)` vestige + one-key wrapper | Rename + inline | A2a |
| CLI/UI duplicated deploy sequence + `projectNameForState` copy | Lib deploy spine | A2b |
| `createState` side effects (secrets write + process.env mutation) | Pure factory; explicit calls at entry points | A2a (+C4) |
| Hand-rolled `markSetupComplete` merge | `mergeEnvContent` one-liner | A3 |
| `isSetupComplete` ×2 disk parses per request | Per-request const + terminal memo | A7 |
| Braille-spinner stderr regex fragility | Structured `ps --format json` first; summarize as fallback | A1 |
| `ensureMigrated`/`ensureReleaseMigrated` ~70-line duplication; fast-path unlocked rewrite | One orchestrator; write-on-diff only | B2 |
| 568 lines of shell/PS migration clones | Delete; point guidance at `openpalm migrate --dry-run` | B5 |
| Three Docker-tag scanners | One scanner with constraints | B3 |
| Five source-regex "tests" | Behavior tests | B6 |
| Five backup mechanisms, zero retention | **Not consolidated in 0.12.0** — deliberate: each mechanism guards a different failure mode and consolidation risk exceeds payoff this milestone; A3 reuses the existing `resolveBackupsDir()` convention instead of adding a sixth; snapshot arming now; pruning = explicit owner-approved command only | A3/B5 |
| `--force` prompt says "moved", code copies | Fix wording | B5 |
| ~250 lines dead remote-registry code + 26KB tests | Delete; rename file to `addons.ts` | C3 |
| `deriveSystemEnvFromSpec` dead; "spec" naming vestigial | Delete; rename | C3 |
| Two compose-arg assemblers + two `collectEnvOverrides` + wrong doc comment | One assembler | C3 |
| No-op `NON_SECRET_STACK_KEYS`; three secret regexes; empty allowlist | One predicate; delete the rest | C3 |
| All addon fields as 0600 secret files + process.env mass-injection | Non-sensitive → stack.env; injection deleted in A2a | C4 |
| Write-only schema knobs (DISCORD_CUSTOM_COMMANDS etc.) | Delete or wire (owner pick; default delete) | C2 |
| Dead `addonComposePath`, `buildComposeFileList` alias, unused params | Delete | C3 |
| Unread compose labels; dead `OP_DOCKER_SOCK`/`COMPOSE_PROFILES`/`OP_OLLAMA_BIND_ADDRESS` | Delete | C1/C2 |
| Four broken `textSync()` upstream-auth copies | Delete (latent break) + fix the compose comment that documents the dead path | D0a |
| Dead `generateMessageId` | Delete | D0a |
| Speculative `TURN_IDLE_STATUSES` values | `Set(['idle'])` | D0a |
| Boot-time `bun add` + `@latest` pins (non-reproducible restarts) | Bake per-package workspace COPY layers | D0b |
| Speculative principal columns (persona/rate_policy/protocols) with zero consumers | Trimmed schema; ALTER TABLE when a consumer ships | D1 |
| Two parallel session-reuse subsystems | Buffered one dies with the transport — no pre-unification | D4 |
| `chat`+`api` = identical package as two compose services | One service, both profiles + both ports kept; principals are DB rows | D4 |
| npm channels unit publishing packages with zero stack consumers | Stop publishing; kit is a private workspace package; delete the release-workflow unit | D4 PR-4 |
| Barrel + 13 subpath dual export surface | Package dissolves; kit is subpath-only, private; full export audit before deletion | D4 |
| 222-line BaseChannel framework for 3 adapters | ~30-line serve per adapter + plain kit functions | D4 |
| `secret-mappings` legacy dynamic scan | Delete; migrations.ts is the only legacy reader | D4 |
| `replay.ts` nonce store (only consumer was HMAC transport) | Delete with the transport | D4 PR-3 |
| 1,509-line wizard.css overlay + token divergence + ID hack | Delete file; scoped styles + app.css | E1/E3 |
| ~150 lines dead app.css | Delete | E1 |
| 138-line verbatim markup dup | Snippet | E1 |
| Hidden test-compat inputs in prod DOM | Delete; assert payloads | E1 |
| Constant mirrors + `addonProfileId`×3 | lib `provider-constants` subpath | E4 |
| Wizard providers endpoint re-implements catalog union | Shared helper | E4 |
| 1,790-line wizard monolith + 16-callback props | **Deferred out of 0.12.0** — extraction-only in E2; data-flow rewiring is its own post-gate slice (0.13) so gate failures stay attributable | (deferred) |
| Stale docs (auth.json path, stack.yml, GUARDIAN_SECRETS_PATH, scheduler comment, channel:voice:dev, OPENCODE_AUTH hardening note) | Fix in the slice that touches the area; core-principles edits need owner approval per its header | B4/D0a/D4 |

---

## 7. Risks & mitigations; out of scope

### Risks

| Risk | Mitigation |
|---|---|
| **User-data loss** (the project's defining failure mode) | No slice deletes anything under OP_HOME. Migration invariants (copy-only/backup-first/stamp-last) are pinned tests that must stay green. Unreferenced files (old secrets, `data/registry/`, `vault/`) are left on disk. Backup pruning is explicit-command-only, owner-approved per path. |
| Channels break on upgrade / fresh install during the auth transition | The credential files + compose grants **survive 0.12.0**; guardian seeds principals from them; adapters read the same files as Basic passwords. Pinned by a 0.11.5-fixture round-trip test (§5). |
| User overlay on `channel_lan` fails compose validation post-rename, taking the stack down | D5b keeps both networks for one release + read-only scan + deprecation note; fixture test pins it. |
| Chat-enabled homes silently lose their `:3820` listener in the compose consolidation | Consolidated service carries both profiles + both port publishes; fixture test pins it. |
| Concurrent orchestrators (CLI install during UI deploy) | A2b: install lock held for the whole deploy; re-entrant by explicit handle, with a both-directions test; journal records the lock holder. |
| Fail-closed collision detection causes false refusals on flaky daemons | A2b: retry-before-refuse; friendly mapped error tells the user it's a daemon problem. |
| Slow-but-fine deploy wizard-loops users (`OP_SETUP_COMPLETE=false` + healthy containers) | A7: flag-false+healthy is a routable state, never a forced wizard restart; journal shows the in-flight deploy. |
| `process.env` global-mutation order changes behavior during refactors | A2a/A4 remove the three mutators (createState injection, ensure-route `OP_OPENCODE_URL`, mass secret injection) with per-callsite explicit-call tests; hooks promotion remains the single documented one. |
| Cross-0.12-boundary image pins mix auth schemes | Unsupported, documented; B3 emits a structured warning when a guardian/channel pin straddles 0.12.0. (The draft's "pins prevent skew" claim was backwards — pins *cause* it; baking + the warning are the real mitigations.) |
| Global-frame relaxation leaks cross-tenant content | D2a: explicit type allowlist, never "no sessionID ⇒ forward"; channel tier keeps the hard drop. Test pins it. |
| Prompt-rewrite hides moderation blocks from adapters | Per-tier behavior: rewrite for direct, 403 for channel; both tested, including the moderator-unreachable fail-closed case. |
| Direct tier escapes rate limiting once `/channel/inbound` dies | Gate 1c is tier-matrix tested in D2a: per-principal limit fires before any upstream call. |
| Admin credential CRUD exposed by a LAN bind | Admin API rides a separate listener published with a **literal** `127.0.0.1:` host bind; compose fixture test pins it; B4 grep gate covers both publishes. |
| Guardian test surface (1,284 lines) goes dark during the auth swap | D4 PR-1 re-fixtures the tests to Basic **while dual-accept is still on** — first PR of the phase, not an afterthought. |
| Wizard typography/rendering changes break the just-passed UX gate | E3 requires full 3-judge re-PASS (sequential judges, pre-captured screenshots, free port, vite restart) before merge; E2 is extraction-only so failures stay attributable. |
| `core-principles.md` is authoritative but stale; agents re-introduce dead paths (already happened with auth.json) | B4 fixes it early in the milestone with owner approval; CI grep gates backstop. |
| Upgrade leaves mixed state (new assets + old tags) and snapshot gets overwritten | B5 snapshot arming; in-flight stack.env auto-restore unchanged. |
| Cross-migration interaction bugs on real homes | Composite 0.11.5→0.12.0 twice-run upgrade test (§5) is a milestone exit gate. |
| Hung registries hang Update-now | B2 fetch timeouts. |
| Milestone slip strands a half-migrated transport | Explicit cut-line in §4: F2 → D3 → (D4 PR-3/4 + D5) slip atomically to 0.13.0; dual-accept then ships as a one-release window and the deletions move with it. |
| Dev host `/tmp` is 100% full | Builds/captures may fail spuriously; clear it (owner action — nothing under `/tmp/openpalm/*` may be deleted without per-path approval). |

### Out of scope / deferred (leave seams, build nothing)

- **#439**: verify gate artifacts, close. The owner-approved **nav redesign** is a next-round spec, not 0.12.0.
- **A2A** (#432 optional phase): deferred; the loopback listener's dispatch is the seam.
- **mTLS** on the internal hop: documented upgrade path only.
- **#435 auth layer**: the `authenticate() → Principal` function and the trimmed principals table are the seams; no strategy registry, no plugin system, no speculative columns.
- **Wizard step-collapse** (7→3) and the wizard data-flow rewiring: deferred (post-#425 note; E2 is extraction-only).
- **Guardian nonce/rate persistence**: never (explicit #433 constraint).
- **Automatic backup pruning**: explicit command only, owner-approved.
- **`OP_VOICE_IMAGE_TAG` in the platform chain**: stays out-of-band.
- **akm read-only MCP tools** (#432): deferred behind `ask_assistant`.
- **Ollama host port**: C2 deletes the phantom var; adding real host exposure is a separate opt-in decision.
- **Principals UI admin tab + per-image pin UI/endpoint**: deferred — curl/CLI + hand-editable stack.env are the 0.12.0 surfaces; revisit when the features have users (named owner decisions below).
- **Compose channel-secret block/grant removal + `channel_lan` definition removal + `ensureChannelSecret` retirement**: 0.13.0, gated by the deprecation scan and grep gates.
- **Standalone npm-installable adapters**: not built — publication stops in D4 PR-4. If the owner names a concrete external consumer, that re-opens as an explicit decision; default is delete.

### Owner decisions required before the affected slice starts
1. `config/guardian/` moderation assets: managed **with skip-if-user-modified semantics** (shipped-default hash manifest; user-modified files kept + notice) or fully user-owned? (A6 — recommendation: manage `instructions/moderation.md` with the skip-if-modified mechanism.) - agree with recommendation
2. #436 name: **portals** (recommended) vs paths — **required before D4 starts** (adapters are created once under final names). (D4/D5b.) - agree, name it portals
3. Backup retention policy + the explicit prune command shape. (B5.) - upgrade backups should be kept for one major release and all releases in between. ie. upgrading to 1.0.0 should leave 0.13.x, a minor version upgrade should leave the prevous version 0.13.0 should leave 0.12.x. the goal being a user can always recover data from the last major version upgrade to the current version and minor versions leaving one prior minor version.
4. Per-field verdicts on the write-only addon schema knobs. (C2 — default delete.) - agreed delete anything not valuable/useful
5. Approval to edit `docs/technical/core-principles.md` (its header requires it). (B4/D0a/D4.) - approved
6. **Approve the descope of #465's "transactional install"** to restore-point + resumable journal + the reconcile-on-install acceptance test — no transaction/repair engine is built. (A3/A6.) - agree
7. **#436 Part 2: enumerate the concrete networking symptoms** (the issue says TBD) so D5a can root-cause or record a no-defect disposition. (D5a.) - verify that we are securely partitioning network traffic so that only the guardian, host, and optionally the host lan can access the assistant container directly. The guardian should also be able to be exposed on the host's LAN and enable mDNS that uses the assistant-name-guardian.local if the assistant is enabled for LAN access mDNS should be enabled as assistant-name.local
8. Deferred surfaces: per-image pin admin endpoint/UI picker (B3) and principals UI admin tab (D2b) — confirm deferral or name the consumer.
9. #398 (Azure Container Apps draft PR): close or move to 0.13.0. (§2.3.) - move to 0.13.0
