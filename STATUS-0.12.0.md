# OpenPalm 0.12.0 — Implementation Status

**Branch:** `release/0.12.2` (targeting 0.12.0 milestone)
**Last Updated:** 2026-06-13
**Test Status:** 935 tests pass, 0 failures
**UI Typecheck:** Clean (0 errors, 0 warnings)

---

## Summary

The 0.12.0 milestone implementation plan is **~25% complete**. The portal refactor (WS-D D0b + partial D5b) was completed prior to this session. This session completed **4 of 28+ slices** from the implementation plan, all in the critical P1 workstreams (WS-A and WS-B).

---

## Completed Work (This Session)

### ✅ WS-A A1: Centralized Docker Error Mapper (`compose-errors.ts`)
- Created `packages/lib/src/control-plane/compose-errors.ts` with `mapDockerError(stderr)`
- Consolidated 3 disparate error mappers (UI setup-deploy, UI complete route, CLI) into one lib function
- Added patterns: platform-mismatch, private-pull/unauthorized, OOM, healthcheck-failure
- Fall-through returns summarized first line, never raw stderr
- **Table test with 21 fixtures** covering all error codes
- Deleted duplicate `allServiceImagesPresent` / kept `missingServiceImages`

### ✅ WS-A A4: Wizard OpenCode Subprocess Sanity
- Dead CLI spawner (`opencode-subprocess.ts`) already deleted
- Removed `setWizardOpencodeUrl()` calls from wizard ensure route — temp OpenCode URL now stays in module state only
- Post-deploy admin UI default endpoint no longer repoints at temp wizard instance
- In-flight promise guard, process reaping, reject-after-resolve cleanup already in place

### ✅ WS-A A5: Port-Check + Runtime Detection Robustness
- `portHeldByOurContainer` already retries once on docker error
- When docker unreachable: `portCheckReliable: false`, conflicts marked non-blocking
- `detectRuntime()` in `launch-status.ts` already identifies OrbStack/Podman from docker version
- SystemCheckStep.svelte gates Continue only on genuinely-reliable conflicts

### ✅ WS-B B1: CLI Correctness Gate
- `state.imageTag` phantom read in `update.ts:53` already fixed (uses `result.imageTag`)
- CLI typecheck script (`tsc --noEmit`) already in `packages/cli/package.json`
- Added regression tests for UI channel selection (prerelease → `next`, stable → `latest`)

### ✅ WS-B B2: Migration Harness Cleanup
- `OP_RELEASE_VERSION` now = deployed platform image tag (not host lib version)
- Non-comparable tags (`latest`, dev tags) never stamped; prior comparable stamp kept
- Deduped orchestration: `ensureMigrated` runs layout migrations → calls `ensureReleaseMigrated`
- Fast path stops writing: stamp only when values differ
- Fixed `opts.homeDir` half-honoring bug
- Added `AbortSignal.timeout(10_000)` to Docker Hub/GitHub fetches
- `uncomment:true` already removed from upgrade-path `mergeEnvContent` calls

---

## Previously Completed (Portal Refactor)

### ✅ WS-D D0b: Channel Image Bakes Adapters
- `containers/portal/Dockerfile` copies `portals/discord` and `portals/slack` from workspace
- `PORTAL_PACKAGE` selects baked package at container start
- Boot-time `bun add` eliminated; no network access at container start

### ✅ Partial WS-D D5b: Rename (Directories Only)
- `core/` → `containers/` (guardian, assistant, portal, voice)
- `packages/*-portal` → `portals/*` (discord, slack)
- Package names: `@openpalm/api-portal`, `@openpalm/discord-portal`, `@openpalm/slack-portal`
- Runtime env: `CHANNEL_PACKAGE` → `PORTAL_PACKAGE`, `OP_CHANNEL_IMAGE_TAG` → `OP_PORTAL_IMAGE_TAG`
- Docs, workflows, release scripts, Electron skeletons updated

### ✅ Removed Dead Packages
- `packages/channel-kit`, `packages/channels-sdk`, `packages/portal-runtime`
- `packages/channel-api`, `packages/channel-discord`, `packages/channel-slack`
- Guardian HMAC dead files (`replay.ts`, `signature.ts`, `forward.ts`)

---

## Pending Work (Per Implementation Plan)

### WS-A: Setup Robustness (P1) — **2/7 slices done**

| Slice | Status | Description |
|-------|--------|-------------|
| A2a | ❌ **Pending** | `createState` purity + single stack.env seeder; delete `packages/cli/src/lib/env.ts` |
| A2b | ❌ **Pending** | Shared deploy spine in lib (fail-closed, label-matched, lock-owned, re-entrant) |
| A3 | ❌ **Pending** | Deploy journal + restart-resume + retry-deploy (`OP_HOME/data/setup/deploy-journal.json`) |
| A6 | ❌ **Pending** | One managed-asset list; refresh on every apply path; reconcile-on-install proof |
| A7 | ❌ **Pending** | #440 consumers: hooks rewrite, splash route, CLI `openpalm status` |

### WS-B: Upgrade/Migration Robustness (P1) — **2/6 slices done**

| Slice | Status | Description |
|-------|--------|-------------|
| B3 | ❌ **Pending** | Per-image pinning (`OP_PINNED_IMAGES`), CLI `openpalm pin`, release workflow outputs (Issue #477) |
| B4 | ❌ **Pending** | Docs + CI grep gates: fix `core-principles.md` §1b, `CLAUDE.md`, add CI hygiene job |
| B5 | ❌ **Pending** | Snapshot arming, delete 0.10 shell/PS migrators, `openpalm backups prune --keep N` |
| B6 | ❌ **Pending** | Replace 5 source-regex tests with behavior tests |

### WS-C: Env/Compose Simplification (P2) — **0/4 slices done**

| Slice | Status | Description |
|-------|--------|-------------|
| C1 | ❌ **Pending** | `OP_BIND_ADDRESS` nested defaults + CI grep gate for `:-127.0.0.1` |
| C2 | ❌ **Pending** | Compose honesty pass: dead labels, vars, schema fields |
| C3 | ❌ **Pending** | Lib dead-code purge (~250 lines registry, duplicate assemblers, no-op allowlists) |
| C4 | ❌ **Pending** | Addon config → stack.env (non-sensitive), kill `process.env` injection |

### WS-D: Standards-Based Ingress (P3) — **~30% done (D0b + partial D5b)**

| Slice | Status | Description |
|-------|--------|-------------|
| D0a | ❌ **Pending** | Delete 4 broken `Bun.file().textSync()` auth copies, `generateMessageId`, `TURN_IDLE_STATUSES` → `Set(['idle'])` |
| D1 | ❌ **Pending** | Principal registry (bun:sqlite at `data/guardian/state.db`) |
| D2a | ❌ **Pending** | Front-door delta: direct tier, event fanout global-frame allowlist, prompt-rewrite block |
| D2b | ❌ **Pending** | Two container listeners (direct on 3830, admin on 3831 loopback), admin CRUD API |
| D3 | ❌ **Pending** | MCP gateway (`/mcp` on direct listener, static bearer, `ask_assistant` tool) |
| D4 | ❌ **Pending** | Dissolve bespoke transport (4 PRs: test re-fixture → adapters → HMAC removal → deletions) |
| D5a | ❌ **Pending** | Networking symptoms root-cause (owner decision #7) |
| D5b | ⚠️ **Partial** | Network rename: `channel_lan` → `portal_net` (dual-network for 1 release), migration copies old keys |

### WS-E: Wizard Dedup + Design System (P4) — **0/4 slices done**

| Slice | Status | Description |
|-------|--------|-------------|
| E1 | ❌ **Pending** | Delete dead CSS (app.css: `.model-toggle`, `.provider-card`, `.provider-grid`, `.filter-pills`, `.model-row`, `.provider-group summary`; wizard.css: `.adv-toggle`, `.review-json*`) |
| E2 | ❌ **Pending** | Shared components: `SelectableCard`, `RadioRow`, `SettingToggle` |
| E3 | ❌ **Pending** | Delete `wizard.css` (1,509 lines) + full 3-judge UX gate re-pass |
| E4 | ❌ **Pending** | Client constants/endpoint dedup: extend `provider-constants.ts` browser subpath |

### WS-F: Assistant Extras (Opportunistic) — **0/3 slices done**

| Slice | Status | Description |
|-------|--------|-------------|
| F1 | ❌ **Pending** | CLI agents in assistant image (codex, claude-code, pi, copilot) |
| F2 | ❌ **Pending** | Connections subtab (detect configured state, write credentials from auth.json) |
| F3 | ❌ **Pending** | MCP consumption docs + commented example in `opencode.jsonc` |

---

## Milestone Exit Gate (Not Started)

### Composite Upgrade Proof Test
- One populated 0.11.5 fixture home → full upgrade sequence runs twice
- Assertions: stack.env keys present, user files preserved, guardian seed idempotent, `docker compose config` validates
- Catches cross-migration ordering/interaction bugs

---

## Key Decisions Made / Owner Approvals Needed

| Decision | Status | Notes |
|----------|--------|-------|
| Portal naming: `portals` (not `paths`) | ✅ **Decided** | Directories renamed, packages scoped `@openpalm/*-portal` |
| Transactional install descope | ✅ **Approved** | Restore-point + resumable journal + reconcile test only |
| `config/guardian/` moderation assets | ⚠️ **Needed** | Skip-if-user-modified via shipped-default hash manifest (A6) |
| Backup retention policy | ⚠️ **Needed** | Keep backups for 1 major + all intermediate minors |
| Write-only addon schema knobs | ⚠️ **Needed** | Default: delete unused fields (C2) |
| Networking symptoms for #436 Part 2 | ⚠️ **Needed** | Verify secure partitioning: guardian/host/LAN ↔ assistant; mDNS for LAN |
| #398 Azure Container Apps PR | ⚠️ **Needed** | Close or move to 0.13.0 |

---

## Test & Quality Gates

| Gate | Status |
|------|--------|
| `bun run test` (all packages) | ✅ 935 pass, 0 fail |
| `cd packages/ui && npm run check` | ✅ Clean |
| `bun run guardian:test` | ✅ Pass |
| `bun run cli:test` | ✅ Pass |

---

## Next Recommended Actions

1. **WS-A A2a** — `createState` purity (unblocks C4, A2b)
2. **WS-A A2b** — Shared deploy spine (unblocks A3, A7)
3. **WS-B B3** — Per-image pinning (Issue #477, tracked separately)
4. **WS-D D0a** — Pre-work deletions (cleans guardian before auth work)
5. **WS-C C3** — Lib dead-code purge (low risk, high impact)
6. **WS-E E1** — Dead CSS cleanup (no rendering risk, quick win)

---

## Implementation Plan Reference

Full plan: `.github/roadmap/0.12.0/implementation-plan.md` (467 lines)
- 28+ slices across 6 workstreams (WS-A through WS-F)
- Explicit sequencing, dependencies, and cut-line for slip scenarios
- Composite migration test is the milestone exit gate