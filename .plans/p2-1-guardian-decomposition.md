# P2-1 Implementation Plan: Decompose Guardian Server Monolith

Date: 2026-03-24  
Backlog item: `P2-1` in `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:269`

## Objective

Reduce complexity concentration in the guardian ingress service without changing behavior, by decomposing `core/guardian/src/server.ts` into focused modules for `signature`, `replay`, `rate-limit`, `assistant-forward`, and `audit`, with a strict regression safety net.

Authoritative constraints:

- Guardian-only ingress and fail-closed behavior: `docs/technical/authoritative/core-principles.md:60`
- Keep complexity justified and minimal in core containers: `docs/technical/authoritative/core-principles.md:7`
- Backlog acceptance target (no behavior drift, reduced FTA): `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:287`

## Baseline and Problem Statement

Current baseline:

- `core/guardian/src/server.ts` is 544 lines and currently mixes transport, auth, replay, rate limiting, session forwarding, stats, and audit concerns (`core/guardian/src/server.ts:1`).
- FTA complexity baseline from review report is `70.27` for this file (`docs/reports/end-to-end-solution-review-2026-03-24.md:159`).

Complexity concentration in one file (evidence):

- Config and process state: `core/guardian/src/server.ts:27`, `core/guardian/src/server.ts:35`
- Secrets parse/load/cache and signature prerequisites: `core/guardian/src/server.ts:52`, `core/guardian/src/server.ts:70`
- Rate limiting policy and bucket state: `core/guardian/src/server.ts:102`, `core/guardian/src/server.ts:113`
- Replay cache and nonce validation: `core/guardian/src/server.ts:142`, `core/guardian/src/server.ts:162`
- Audit file setup and append flow: `core/guardian/src/server.ts:176`, `core/guardian/src/server.ts:186`
- Assistant session orchestration: `core/guardian/src/server.ts:206`, `core/guardian/src/server.ts:315`
- Route handling and security pipeline orchestration: `core/guardian/src/server.ts:382`, `core/guardian/src/server.ts:442`

## Proposed Module Boundaries

Keep modules thin and purpose-scoped. Avoid introducing framework layers or abstractions that only wrap single calls.

### 1) Signature module

Proposed file: `core/guardian/src/signature.ts`

Owns:

- Channel secret key parsing and normalization currently in `parseChannelSecrets` (`core/guardian/src/server.ts:54`)
- Secret source loading (file/env fallback) and file mtime cache currently in `loadChannelSecrets` (`core/guardian/src/server.ts:70`)
- Signed payload gate helper (receives `raw`, `sig`, `channel`, returns allow/deny + error code)

Boundary:

- No HTTP or response creation.
- No replay/rate decisions.

### 2) Replay module

Proposed file: `core/guardian/src/replay.ts`

Owns:

- Nonce cache state (`seen`) and skew policy currently in `CLOCK_SKEW`/`checkNonce` (`core/guardian/src/server.ts:142`, `core/guardian/src/server.ts:162`)
- Pruning policy and periodic interval currently at `pruneNonceCache` and `setInterval` (`core/guardian/src/server.ts:145`, `core/guardian/src/server.ts:160`)

Boundary:

- Exposes `checkNonce(nonce, ts)` and `getReplayStats()` only.
- No signature, no rate limiting, no assistant calls.

### 3) Rate-limit module

Proposed file: `core/guardian/src/rate-limit.ts`

Owns:

- User/channel limits and windows currently at `USER_RATE_LIMIT` + `CHANNEL_RATE_LIMIT` (`core/guardian/src/server.ts:102`, `core/guardian/src/server.ts:104`)
- Fixed-window bucket algorithm currently in `allow` (`core/guardian/src/server.ts:113`)
- Active limiter stats currently computed in `/stats` route loop (`core/guardian/src/server.ts:401`)

Boundary:

- Exposes `allowInbound(userId, channel)` and `getRateLimitStats()`.
- Keeps fixed-window behavior unchanged (no algorithm change in this remediation).

### 4) Assistant-forward module

Proposed file: `core/guardian/src/assistant-forward.ts`

Owns:

- Client opts and timeout/session TTL configuration (`core/guardian/src/server.ts:206`, `core/guardian/src/server.ts:207`, `core/guardian/src/server.ts:228`)
- Session target resolution and metadata behavior (`core/guardian/src/server.ts:243`, `core/guardian/src/server.ts:259`)
- Session locking, cache/list reuse, send path, clear path (`core/guardian/src/server.ts:263`, `core/guardian/src/server.ts:315`, `core/guardian/src/server.ts:355`)

Boundary:

- Exposes a compact service API:
  - `resolveSessionTarget(userId, channel, metadata)`
  - `shouldClearSession(metadata)`
  - `askAssistant(message, sessionTarget)`
  - `clearAssistantSessions(sessionTarget)`
  - `getAssistantStats()`

### 5) Audit module

Proposed file: `core/guardian/src/audit.ts`

Owns:

- Audit directory initialization and writer lifecycle (`core/guardian/src/server.ts:176`, `core/guardian/src/server.ts:184`)
- `audit(event)` append/flush behavior (`core/guardian/src/server.ts:186`)

Boundary:

- Exposes `audit(event)` only.
- No policy decisions in this module.

### 6) Request metrics module (supporting)

Proposed file: `core/guardian/src/request-metrics.ts`

Owns:

- Uptime start time and request counters currently in `requestCounters`/`countRequest` (`core/guardian/src/server.ts:35`, `core/guardian/src/server.ts:42`)
- `getRequestStats()` for `/stats`

Boundary:

- Purely in-memory counters, no transport.

### 7) HTTP composition module (thin orchestration)

Proposed files:

- `core/guardian/src/routes.ts` (route handlers and security pipeline wiring)
- `core/guardian/src/server.ts` (minimal bootstrap only)

Target end state for `server.ts`:

- Read env/config, build dependencies, call `Bun.serve`, log startup.
- Keep under ~120 lines with no business logic branches.

## Planned File Layout (Post-Refactor)

- `core/guardian/src/server.ts` (bootstrap)
- `core/guardian/src/routes.ts` (health/stats/inbound routing)
- `core/guardian/src/signature.ts`
- `core/guardian/src/replay.ts`
- `core/guardian/src/rate-limit.ts`
- `core/guardian/src/assistant-forward.ts`
- `core/guardian/src/audit.ts`
- `core/guardian/src/request-metrics.ts`
- `core/guardian/src/types.ts` (shared local types only if needed; do not add unless duplication appears)

## Migration Sequence

Perform in small, reversible commits with tests green after each step.

### Step 0: Characterization lock-in (no production code move yet)

1. Add focused tests that pin behavior already covered implicitly in integration flow (`core/guardian/src/server.test.ts:162`).
2. Add tests for branch-heavy helper behavior before extraction (pure helper tests where possible).

Exit criteria:

- Existing integration tests still pass unchanged.
- New tests encode current behavior (including edge handling and status/error codes).

### Step 1: Extract non-HTTP state modules first

1. Extract `request-metrics.ts` from `countRequest` + state (`core/guardian/src/server.ts:35`).
2. Extract `audit.ts` from audit setup/write (`core/guardian/src/server.ts:176`).
3. Wire server through these modules with no logic changes.

Exit criteria:

- `server.test.ts` green.
- No response shape diffs for `/health`, `/stats`, `/channel/inbound`.

### Step 2: Extract replay and rate-limit

1. Move nonce/skew/prune into `replay.ts` from `core/guardian/src/server.ts:142`.
2. Move fixed-window limiter into `rate-limit.ts` from `core/guardian/src/server.ts:102`.
3. Keep sequence order identical in inbound pipeline (`rate-limit` check before `nonce` check per existing contract at `core/guardian/src/server.ts:483`).

Exit criteria:

- Replay/rate tests green (`core/guardian/src/server.test.ts:343`, `core/guardian/src/server.test.ts:364`).
- `/stats` active limiter counts still accurate (`core/guardian/src/server.test.ts:403`).

### Step 3: Extract signature/secrets

1. Move secrets parsing/loading/cache into `signature.ts` from `core/guardian/src/server.ts:52`.
2. Keep unknown-channel timing parity behavior unchanged (dummy secret path) from `core/guardian/src/server.ts:472`.
3. Ensure file cache TTL and mtime behavior remain identical (`core/guardian/src/server.ts:68`, `core/guardian/src/server.ts:75`).

Exit criteria:

- Signature tests green (`core/guardian/src/server.test.ts:307`, `core/guardian/src/server.test.ts:335`).
- Unknown channel still returns `invalid_signature` (no enumeration oracle).

### Step 4: Extract assistant-forward

1. Move session target, lock, caches, and assistant calls from `core/guardian/src/server.ts:206` into `assistant-forward.ts`.
2. Preserve session key semantics and clear-session behavior (`core/guardian/src/server.ts:243`, `core/guardian/src/server.ts:259`).
3. Keep best-effort delete behavior unchanged (`core/guardian/src/server.ts:367`).

Exit criteria:

- Session behavior tests green (`core/guardian/src/server.test.ts:182`, `core/guardian/src/server.test.ts:208`, `core/guardian/src/server.test.ts:289`).
- Assistant-down behavior still returns 502 (`core/guardian/src/server.test.ts:452`).

### Step 5: Extract route composition and slim bootstrap

1. Create `routes.ts` with handler wiring for `/health`, `/stats`, and `/channel/inbound` from `core/guardian/src/server.ts:388`.
2. Reduce `server.ts` to bootstrap and dependency construction.
3. Keep request-id generation and JSON response format identical (`core/guardian/src/server.ts:386`, `core/guardian/src/server.ts:378`).

Exit criteria:

- Full guardian test suite green.
- Public behavior diff is empty (status codes, error codes, response keys).

## Test Safety Net

### Existing regression suite to keep intact

- `core/guardian/src/server.test.ts:162` to `core/guardian/src/server.test.ts:497` is the main behavior contract and should remain the primary no-drift gate.

### Additional tests to add during extraction

1. `core/guardian/src/signature.test.ts`
   - parse/load file/env fallback behavior
   - unknown channel handling parity
2. `core/guardian/src/replay.test.ts`
   - skew rejection, nonce reuse rejection, prune cap behavior
3. `core/guardian/src/rate-limit.test.ts`
   - user/channel limits, reset-after-window, map cap pruning
4. `core/guardian/src/assistant-forward.test.ts`
   - lock serialization, cache reuse, list fallback, clear-session deletion semantics
5. `core/guardian/src/audit.test.ts` (lightweight)
   - append format and best-effort failure handling

Safety principles:

- Do not replace integration tests with only unit tests.
- Add unit tests to reduce risk while moving code, not to redefine behavior.
- Keep error codes from `@openpalm/channels-sdk/channel` stable across modules.

## Measurable Complexity Goals

Primary goal (from backlog intent): lower FTA risk concentration while preserving behavior.

### Quantitative targets

1. File-level FTA
   - `core/guardian/src/server.ts` from baseline `70.27` to `< 30`.
   - No newly introduced guardian file over `60` FTA.
2. File size
   - `core/guardian/src/server.ts` <= 120 lines.
   - Each new module ideally <= 220 lines; if exceeded, require explicit justification.
3. Cyclomatic spread
   - No single guardian module with cyclomatic complexity > 20.
   - Security branches are distributed by concern (signature/replay/rate-limit isolated).
4. Test resilience
   - Existing guardian suite remains green.
   - Added module tests cover edge branches currently embedded in monolith.

### Complexity guardrails (must call out unjustified complexity)

- Avoid creating dependency injection frameworks for a single service.
- Avoid creating shared "utils" buckets that blur ownership.
- Prefer straightforward function modules with explicit inputs/outputs.
- If a module starts accumulating multiple unrelated concerns, split immediately.

## Verification Commands

Run from repo root unless noted.

1. Guardian regression and new module tests:

```bash
cd core/guardian && bun test
```

2. Required project guardrail check from backlog checklist:

```bash
cd packages/admin && npm run check
```

3. Workspace complexity report (FTA) after refactor:

```bash
bun run analysis:fta
```

4. Optional machine-readable FTA artifact for PR notes:

```bash
bun run analysis:fta:json
```

## Acceptance Mapping (P2-1)

- "Split into modules (`signature`, `replay`, `rate-limit`, `assistant-forward`, `audit`)": satisfied by target files listed in Proposed Module Boundaries.
- "Preserve behavior with snapshot/regression tests": satisfied by retaining `core/guardian/src/server.test.ts` as primary contract plus added module tests.
- "No behavior drift in existing guardian tests": enforced by unchanged integration expectations and status/error contracts.
- "Reduced FTA score and clearer ownership boundaries": enforced via measurable goals and file-level ownership map.

## Deliverable Definition of Done

- Guardian route behavior is unchanged for `/health`, `/stats`, and `/channel/inbound`.
- Security invariants remain fail-closed (signature, replay, rate limit before assistant forwarding).
- `core/guardian/src/server.ts` is bootstrap-focused and materially less complex.
- FTA and test checks pass with documented before/after complexity in PR notes.
