# OpenPalm — End-to-End Code Quality Review

> Review date: 2026-07-03. Scope: full monorepo (~40k source lines, ~190 test files).
> Method: systematic per-package deep-dive plus cross-cutting verification.

## Executive summary

OpenPalm is a **mature, security-conscious, unusually well-tested** monorepo. The engineering
fundamentals are strong: `strict: true` TypeScript with only ~8 `any` casts in the whole
codebase, a central path resolver (`paths.ts`) that injects a `ControlPlaneState` object instead
of reading globals, `OP_HOME` resolved through a helper (69 call sites) rather than scattered
`process.env` reads, a clean `citty`-based CLI with lazy-loaded subcommands, and a deliberate
practice of extracting **pure decision functions** (`isProjectOurs`, `decideOwnershipFromCanaries`,
`buildReconcileDecision`) that makes much of the control plane trivially unit-testable. Only 3
TODO/FIXME markers exist in the entire tree.

The debt is **not local code quality — it is missing abstraction boundaries and missing
enforcement.** Five themes dominate, in priority order:

1. **Cross-boundary duplication that a shared package should own.** The two portals contain
   **498 lines that are byte-for-byte identical** (verified by md5) plus ~350 more of rename-only
   structural copy. The UI-server supervisor state machine is reimplemented near-verbatim in both
   the CLI and Electron. `constantTimeEqual` exists three times in guardian (one variant is *not*
   constant-time). In several cases the duplication **has already drifted**.
2. **A handful of god-files that fuse 4–12 responsibilities**, concentrated in a few surfaces while
   the rest of the codebase is clean.
3. **No enforced convention** for linting, data-fetching, or config resolution outside the UI package.
4. **A cluster of correctness-adjacent bugs** (a broken rate-limiter stat, a non-constant-time admin
   token compare, a moderation "block" that silently rewrites instead of blocking).
5. **Testability cliffs** at the orchestrator layer and inside god-components, in contrast to the
   well-injected pure core.

Crucially, **the good patterns already exist in-repo** (`chat-state.svelte.ts`, `server/endpoints.ts`,
`local-opencode.ts`, the moderation pipeline's dependency injection). The work is largely applying
them uniformly and deleting the copies — low-risk, high-leverage refactoring rather than redesign.

---

## Top architectural problems (cross-cutting)

### A1 — Duplication across module boundaries (CRITICAL)

| Duplication | Location | Size | Status |
|---|---|---|---|
| Portal protocol layer (`runtime.ts`, `oc-events.ts`, `opencode.ts`) | discord vs slack | **498 lines byte-identical** | drift-prone |
| Portal adapter skeleton (`json`, `collectTurnAnswer`, `forward`, `start`, thread-tracking) | discord vs slack `index.ts` | ~250–350 structural | timeout defaults **already diverged** (Slack 30 min, Discord ∞) |
| Portal turn/throttle stream loop | discord vs slack `stream-render.ts` | ~120 structural | comments *claim* it's shared; it isn't |
| UI-server supervisor (`waitForReady`, spawn, SIGUSR2 restart + backup-restore) | `cli/lib/ui-server.ts` vs `electron/main.ts` | whole state machine | **already diverged** (ready timeout 15s vs 60s; grace 5s vs 1.5s) |
| Compose preflight + invocation | `cli/lib/cli-compose.ts` vs `lib/control-plane/docker.ts` | preflight message + spawn | diverged; CLI path has **no timeout**, lib has 30-min budget |
| `constantTimeEqual` | `auth.ts`, `mcp.ts`, `openai-api-crypto.ts` | ×3 | one leaks length |
| SSE frame parser | `event-fanout.ts` vs `openai-api-oc-client.ts` | ×2 | different boundary handling (`\r\n\r\n` vs `\n\n`) |
| npm download/verify/stage/swap pipeline | `ui-assets.ts` (UI vs skeleton) | ~250 lines | twin functions |
| `stack.env` path | `paths.ts`, `home.ts` + 14 inline literals | 3 definitions | `home.ts`'s own header names this exact anti-pattern |
| `LOCAL_PROVIDER_IDS` | 5 UI files | **3 different definitions** | already drifted (`llamacpp`/`localai` in some, not others) |

**Fix:** stand up a `@openpalm/portal-sdk` (or fold into `@openpalm/lib`) with `OcClient`,
`ConversationQueue`, the event interpreters, and a `BasePortal` abstract adapter; extract a
`UiSupervisor` in lib parameterized by spawn strategy; consolidate every duplicated primitive to one
home. This single theme removes ~1,000+ lines.

### A2 — God-files fusing responsibilities (HIGH)
`setup/+page.svelte` (1674 L), `admin/voice/+server.ts` (1041 L), `electron/main.ts` (1292 L),
`guardian/proxy.ts` (741 L), `lib/docker.ts` (877 L), `lib/ui-assets.ts` (847 L), `api.ts` (975 L).
Note the same team wrote `chat/+page.svelte` correctly — 1749 lines but ~970 are `<style>`, ~230
script lines, **zero inline networking**, all logic in the testable `chat-state.svelte.ts` store. The
discipline exists; it isn't applied uniformly.

### A3 — No enforcement / convention (HIGH)
- **No linter or formatter exists outside `packages/ui`.** No root `lint`/`format` script.
- **Three competing data-fetching patterns in the UI** (typed `api.ts`; 18 raw inline fetches in setup; ~14 bespoke fetches in `providers/`).
- **Config re-read instead of centralized** (`OP_ASSISTANT_URL` in 4 guardian modules; 71 direct `process.env` reads in the UI; port/repo constants inlined 4+ places).

### A4 — Correctness-adjacent defects (HIGH — verified)
- **`rate-limit.ts:69,71` classifies by `"ch:"` but `proxy.ts:176` emits `"oc:"`** → `/stats` `active_portal_limiters` is always wrong.
- **`admin.ts:31` compares the admin token with `===`** (timing side-channel); `openai-api-crypto.ts`'s copy early-returns on length mismatch.
- **`proxy.ts:433–486` — a moderation `block` verdict silently *rewrites* the prompt for `direct` principals** instead of returning 403.
- **`PORTAL_ADDON_IDS` disagrees across 3 sites** (`lifecycle.ts:489` has `gateway`; others don't).
- **`setup/+page.svelte:1146` (`handleHostImport`)** returns on failure with a comment promising a message that is never set.
- **~150 lines of `guardian/forward.ts` are dead**.

### A5 — Testability cliffs at the seams (MEDIUM)
Orchestrators (`runDeploy`, `performSetup`, `reconcileStack`, `applyStack`) call `execFile`/`node:fs`
directly with no injection seam (hence `OP_SKIP_COMPOSE_PREFLIGHT` hatches and
`__addonAvailabilityTestHooks`). God-components and module-global state (`electron/main.ts`,
`voice-state.svelte.ts`) are effectively untestable. `process.exit()` is buried inside `ui-server.ts`
and `scan.ts` internals rather than at the entry boundary.

---

## File-by-file findings

### `packages/lib` (control plane)
- **HIGH** `stack.env` path defined 3 ways + inlined ~14× with contradictory "canonical" vs "legacy" semantics → collapse to one helper, ban the literal via lint.
- **HIGH** `ui-assets.ts` — UI and skeleton npm pipelines are copy-paste twins → extract `NpmPackageUpdater(config)`.
- **HIGH** `docker.ts` — privileged-chown ownership-repair subsystem welded to the compose wrapper → move to `volume-ownership.ts`; derive the volume map from compose config.
- **MEDIUM** `performSetup` (~205 L, triple-nested try/catch, repeated `as Record<string,unknown>` casts) → extract `persistSecrets`/`writeAkmConfig`/`enableRequestedAddons`; typed akm-config builder.
- **MEDIUM** `addons.ts` bundles compose parsing + hardware probing + env-state mutation + automation install → split `addon-availability.ts`.
- **MEDIUM** `deploy.ts` reimplements compose-arg assembly and `ps --format json` parsing → share `buildComposeArgs` + one `parseComposePsJson`.
- **MEDIUM** portal-id list hardcoded in 3 places, already inconsistent (`gateway`) → one `PORTAL_ADDON_IDS` in `addon-ids.ts`.
- **MEDIUM** `docker.ts` `run()` coerces error codes (`Number('ENOENT')`→`NaN`; missing `.code`→`0`) → discriminated `{ok, exitCode, signal, spawnError?}`.
- **LOW** `index.ts` 528-line barrel with leaky `export *`; `errMessage()` idiom repeated 20+×; three inline retry strategies → one `retry(fn,{delays})`.

### `packages/guardian` (security ingress)
- **HIGH** `proxy.ts` god-file → extract `session-reuse.ts` and `oc-router.ts`; make moderation/turn-cap side effects injectable.
- **HIGH** a **second, looser allowlist** for `direct` principals skips canonicalization/`%2e%2e` checks + `as AllowlistMatch` casts → route both kinds through hardened `matchAllowlist`.
- **HIGH** moderation "block"→rewrite divergence (A4) → return a verdict; caller decides block-vs-rewrite visibly.
- **HIGH** two divergent turn-execution paths + three ~90%-duplicated handlers → one `runTurn()` core + one templated handler.
- **MEDIUM** `constantTimeEqual` ×3 (one insecure), `asRecord` ×2, `parts[].text` ×4, `ASSISTANT_URL` ×4, SSE parser ×2 → consolidate; add `config.ts`.
- **MEDIUM** `rate-limit.ts` stale `"ch:"` (A4); `admin.ts` non-constant-time compare + per-request file read (A4); policy-error `catch {}` swallows diagnostics; `forwardSessionCreate` duplicate-variable noise.
- **MEDIUM** `forward.ts` largely dead (A4) → delete.
- *Positive:* `moderation.ts`/`content-screen.ts` are the best-factored code in the repo (DI via `ModerateDeps`, pure `screenContent`/`parseModeratorVerdict`).

### `packages/ui` (SvelteKit)
- **CRITICAL** `setup/+page.svelte` (1674 L) → extract `setup-api.ts`, move `buildSetupPayload`/`resolvePreferredModelSelection`/`verifiedProviders` into `lib/client/helpers.ts`, add `setup-state.svelte.ts` store (kills ~20-prop drilling). Round-trip test `buildSetupPayload`/`parseSetupConfig`.
- **HIGH** `api.ts` (975 L) — good core, but owns ~40 endpoints + all DTOs → split domain clients over the core; move DTOs to `types/`; give `requireOk` a typed-error-body variant.
- **HIGH** `admin/voice/+server.ts` (1041 L) inlines a Docker bring-up engine → extract `server/voice/bring-up.ts`, mirroring `server/endpoints.ts`.
- **HIGH** focus-trap + autoscroll actions embedded and duplicated in `chat/+page.svelte` → `lib/a11y/focus-trap.ts` + `lib/actions/autoscroll.ts`.
- **HIGH** `LOCAL_PROVIDER_IDS` and friendly-provider-name duplicated/drifted (A1); ~14 bespoke fetches in `providers/` (A3); swallowed setup errors incl. the message-less host-import failure (A4).
- **MEDIUM** `voice-state.svelte.ts` (750 L) mixes reactive store + imperative audio engine + module-globals → split `AudioPlaybackController`. `UpdatesTab.svelte` six parallel `Record<string,…>` maps → one `Record<string, RowState>`. `getSessionMessages` part-flattening parser → move to `lib/chat/`.
- *Positive:* `chat-state.svelte.ts`, `server/endpoints.ts`+route, and the `api.ts` core are the reference patterns.

### `packages/cli` + `packages/electron`
- **CRITICAL** UI-supervisor duplicated & diverged across CLI/Electron (A1) → `UiSupervisor` in lib.
- **HIGH** compose preflight/invocation duplicated across the CLI/lib boundary → single lib helper; expose stdio-inheriting variant so CLI drops its own `docker.ts`.
- **HIGH** `electron/main.ts` god-file over ~10 module-globals → split `ui-supervisor.ts`/`tray.ts`/`docker-preflight.ts`/`permissions.ts`/`splash.ts`.
- **HIGH** `globalThis.Bun` shim (`electron/main.ts:7`) → make lib's logger read `process.env`/injected env.
- **HIGH** CLI `SUBCOMMAND_NAMES` mirrors `subCommands` keys (misroutes on drift) + duplicated dispatch → derive from `Object.keys`; one dispatch path.
- **MEDIUM** ~12 command files repeat `try/catch/process.exit` → one `defineAction()`; `promptYesNo`, `--format` validation, GitHub-release regex duplicated → move to `cli/lib`. Dead `services` positionals. Buried `process.exit`.
- *Positive:* CLI separates `defineCommand` shells from exported `runXAction` logic (test-backed); `local-opencode.ts` has an injectable `_spawn` seam; CLI already delegates real control-plane logic to lib.

### `portals/` + `containers/`
- **CRITICAL** 498 lines byte-identical + no `BasePortal` (A1) → `@openpalm/portal-sdk`.
- **HIGH** `stream-render.ts` turn-loop + throttle-buffer duplicated → hoist `renderTurn(events, sink)`.
- **HIGH** `containers/portal/start.sh` uses only `set -e` (siblings use `set -euo pipefail`) → fix (guard `${VAR:-}`).
- **MEDIUM** `MAX_MESSAGE_LENGTH` twice per portal; forward-timeout defaults opposite; `forward()` rebuilds `OcClient` per call with a different principal rule; buffered `collectTurnAnswer` ignores `session.error`.
- **MEDIUM** voice Python service import-time global singletons + top-level `onnxruntime` import → move engines to `app.state` via lifespan + `Depends`. `tts._download_if_missing` has no `urlopen` timeout.
- *Positive:* individual portal files are otherwise well-written; the problem is purely the missing shared abstraction.

---

## Recommended refactoring plan

**Consolidate to shared homes (removes the most lines, lowest risk):**
1. `@openpalm/portal-sdk` with `OcClient`, `ConversationQueue`, event interpreters, `BasePortal`, `renderTurn(events, sink)`, `checkPermissions(config, user, scopeChecks[])`, platform-limit constants.
2. `UiSupervisor` in `@openpalm/lib` (parameterized spawn strategy + reload callback); CLI and Electron become adapters. Move `waitForReady` + backup-restore as pure functions immediately.
3. Guardian primitives: one `constantTimeEqual`, one SSE reader, one `config.ts`, one `runTurn()`, one templated OpenAI handler; delete `forward.ts`.
4. lib: one `stack.env` helper, one `PORTAL_ADDON_IDS`, one `NpmPackageUpdater`, one `parseComposePsJson`, `errMessage()`, `retry()`.
5. UI: `setup-api.ts` + `setup-state.svelte.ts`; extract `buildSetupPayload`/`parseSetupConfig`; `server/voice/bring-up.ts`; `lib/a11y/focus-trap.ts`; centralize `LOCAL_PROVIDER_IDS` + `friendlyProviderName`.

**Split god-files along their seams** (`docker.ts`→`volume-ownership.ts`; `addons.ts`→`addon-availability.ts`; `proxy.ts`→`session-reuse.ts`+`oc-router.ts`; `electron/main.ts`→5 modules; `api.ts`→domain clients).

## Design patterns (only where justified)
- **Template Method / Abstract adapter** — `BasePortal` and the guardian templated handler.
- **Strategy (injected port)** — thin `docker`/`fs` port for the orchestrators.
- **Store-per-domain (already in-repo)** — apply `chat-state.svelte.ts` pattern to setup and voice.
- **Registry/data-driven allowlist** — one allowlist keyed by principal kind in guardian.

## Testing improvements
Coverage is strong in `lib` (57) and `ui` (100) but thin where god-files live: guardian (17), CLI (6),
portals (8). The extractions above convert untestable code into pure functions. Add characterization
tests to the CLI/portal seams *before* de-duplicating so the shared extraction is provably
behavior-preserving.

## Technical debt to delete or simplify
- `guardian/forward.ts` dead exports (~150 L).
- One of the two `stack.env` helpers; all 14 inline literals.
- One of the two npm pipelines in `ui-assets.ts`.
- Two of three `constantTimeEqual`; one of two SSE parsers; `asRecord` ×2.
- The `SUBCOMMAND_NAMES` mirror (derive it).
- Dead `services` positional declarations in CLI commands.
- `forwardSessionCreate` duplicate-variable noise.

---

## Prioritized roadmap

**Critical (correctness / security posture — do first):**
1. Fix `rate-limit.ts` `"ch:"`→`"oc:"` classification.
2. Constant-time admin token compare; unify on one secure `constantTimeEqual`.
3. Make the guardian direct-principal moderation block-vs-rewrite explicit and documented; log swallowed policy errors.
4. Reconcile `PORTAL_ADDON_IDS` (`gateway`); set the message on `handleHostImport` failure.
5. `set -euo pipefail` in `containers/portal/start.sh`.

**High (kill the biggest duplications + enforcement):**
6. Add a root linter/formatter (Biome or ESLint) across all packages + a root `lint` script and CI gate.
7. `@openpalm/portal-sdk` (removes ~500+ duplicated lines).
8. `UiSupervisor` in lib (removes the CLI/Electron drift).
9. Unify compose preflight/invocation on lib; remove the `globalThis.Bun` shim.
10. Extract `setup-api.ts` + `buildSetupPayload` + `setup-state` store; route `providers/` fetches through `api.ts`.

**Medium (split god-files, consolidate primitives):**
11. Guardian `runTurn`/templated handler + `session-reuse.ts`/`oc-router.ts` split; single allowlist.
12. `admin/voice/+server.ts` → `server/voice/bring-up.ts`; `voice-state` audio controller split; `api.ts` domain clients.
13. lib splits (`volume-ownership.ts`, `addon-availability.ts`, `NpmPackageUpdater`); one `stack.env`/`PORTAL_ADDON_IDS`.
14. `electron/main.ts` module split; CLI `defineAction` wrapper + shared helpers.

**Low (hygiene):**
15. `errMessage()`/`retry()` utils; `config.ts` in guardian; centralize port/repo constants; move pure utils out of `.svelte` files; typed accessors for repeated `unknown` narrowing.

**Bottom line:** this is a well-built system carrying a specific, tractable kind of debt — *missing
shared boundaries and missing enforcement*, not bad code. The single most valuable action is adding a
repo-wide linter/formatter with a CI gate; after that, the reference patterns already present in-repo
just need to be applied uniformly and the copies deleted.

---

## Implementation progress

**Wave 1 — Critical correctness + enforcement (DONE, merged & pushed):**
- [x] 1. rate-limit `oc:` classification fixed
- [x] 2. one secure `constantTimeEqual`; admin token now constant-time
- [x] 3. moderation block-vs-rewrite made explicit; policy errors logged
- [x] 4. portal addon ids → two named single-source constants (`GUARDIAN_INGRESS_ADDON_IDS` vs `PORTAL_SECRET_ADDON_IDS`; `gateway` correctly belongs only to the former); `handleHostImport` failure now surfaced
- [x] 5. `containers/portal/start.sh` hardened to `set -euo pipefail`
- [x] 6. Biome linter + root scripts + CI gate (additive, green on current tree)

**Wave 2 — High-priority deduplication (DONE, merged & pushed):**
- [x] 7. `@openpalm/portal-sdk` extracted (~1420 duplicated lines removed; `BasePortal`). `renderTurn` sink deferred — the two stream loops diverge in per-frame error handling & message lifecycle.
- [x] 8. UI-supervisor pure primitives (`waitForReady`, `restoreUiBackup`) moved to `@openpalm/lib`; CLI/Electron consume them; drifted 15s/60s timeout unified to 60s. Full `UiSupervisor` class deferred — CLI (`Bun.Subprocess`) and Electron (`child_process`+pid files+renderer reload) shells genuinely diverge.
- [x] 10. `buildSetupPayload`/`parseSetupConfig` (round-trip tested), 5 pure helpers, and typed `setup-api.ts` extracted from the 1674-line setup page (→1377). Full `setup-state.svelte.ts` store + prop-drilling refactor deferred.

**Wave 3 — High/Medium refactors (DONE, merged & pushed):**
- [x] 9. Compose preflight/invocation unified on lib (`buildComposePreflightError` + `runComposeStreaming`; CLI's duplicate `docker.ts` deleted, missing-secret guidance + profile args reconciled, timeout budget applied); `globalThis.Bun` logger shim removed.
- [x] 11. Guardian: dead `forward.ts` deleted (`resolveSessionTarget` → `session-target.ts`); the three OpenAI-compatible handlers unified into one templated `handleTurn`. The two turn-execution paths were deliberately NOT merged — the non-streaming path intentionally omits permission-policy/question-rejection/timeout, so unifying would change security behavior (documented).
- [x] 12. `api.ts` (975 L) split into 11 domain client modules + a transport `core.ts`, behind a barrel that preserves all 31 existing import sites; DTOs co-located; `getSessionMessages` flattening parser extracted to `lib/chat/session-messages.ts` with tests.

**Remaining (not yet started):**
- [ ] 13. lib splits (`volume-ownership.ts` from docker.ts, `addon-availability.ts` from addons.ts, `NpmPackageUpdater` from ui-assets.ts).
- [ ] 12-rest / 14. `admin/voice` route → service module, `voice-state` audio-controller split; `electron/main.ts` module split; CLI `defineAction` wrapper + shared command helpers.
- [ ] 15. Hygiene utils (`errMessage`, `retry`, guardian `config.ts`, centralized port/repo constants).
- Deferred sub-steps from items 7/8/10 (portal `renderTurn` sink, full `UiSupervisor` class, setup-state store + prop-drilling) and the guardian `runTurn`/`session-reuse` extraction (11 step 3-4).

All landed changes preserve behavior, add tests, and keep the lint gate green. Pre-existing test
failures unrelated to this work: 12 root-uid ownership tests (sandbox runs as uid 0), 1 guardian IPv6
sandbox bind, 1 stale portal Dockerfile-bake test.
