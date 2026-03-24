# P0-3 Implementation Plan: Remove Guardian Bypass in Voice Channel

Source: `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:73`

## Objective

Enforce the guardian-only ingress invariant for `@openpalm/channel-voice` by removing any direct LLM fallback path when guardian forwarding fails, and replacing it with explicit, auditable guardian-unavailable failures.

Authoritative constraints:

- `docs/technical/authoritative/core-principles.md:60` (guardian-only ingress)
- `docs/technical/code-quality-principles.md:23` (security checks are non-bypassable)

## Current Flow Analysis (As-Is)

### Request path today

1. `POST /api/pipeline` is handled by `handlePipeline()` in `packages/channel-voice/src/index.ts:74`.
2. STT stage:
   - Uses provided text (`packages/channel-voice/src/index.ts:103`), or
   - Uses server STT provider (`packages/channel-voice/src/index.ts:105`).
3. Guardian stage:
   - Forwards transcript via `this.forward(...)` (`packages/channel-voice/src/index.ts:126`).
   - On non-OK guardian response, throws (`packages/channel-voice/src/index.ts:128`).
4. **Bypass behavior (violation):** catch block logs warning and calls direct LLM `chatCompletion(...)` (`packages/channel-voice/src/index.ts:136`, `packages/channel-voice/src/index.ts:138`).
5. Direct LLM implementation is in `packages/channel-voice/src/providers.ts:132`, with explicit comment that it is a fallback when guardian is unavailable (`packages/channel-voice/src/providers.ts:126`, `packages/channel-voice/src/providers.ts:130`).

### Why this violates P0-3

- It bypasses guardian protections (HMAC verification, replay/rate controls, unified audit path), directly conflicting with `docs/technical/authoritative/core-principles.md:60`.

## Proposed Code Changes (Exact)

## 1) Remove direct fallback branch from voice pipeline

File: `packages/channel-voice/src/index.ts`

- Remove `chatCompletion` import at `packages/channel-voice/src/index.ts:18`.
- Replace guardian step comment at `packages/channel-voice/src/index.ts:123` to reflect guardian-only behavior.
- Replace try/catch block rooted at `packages/channel-voice/src/index.ts:124`:
  - Keep success path using guardian response JSON (`packages/channel-voice/src/index.ts:133`).
  - On guardian non-OK (`packages/channel-voice/src/index.ts:128`) or transport error (`packages/channel-voice/src/index.ts:135`), return explicit 502 response:
    - `error`: human-readable guardian unavailable message
    - `code`: `guardian_unavailable`
    - Optional `guardianStatus` when available
  - Log as error with structured fields for auditability.

Planned response contract for guardian failure:

```json
{
  "error": "Guardian unavailable; voice channel cannot process requests directly",
  "code": "guardian_unavailable",
  "guardianStatus": 503
}
```

(When no status exists, omit `guardianStatus`.)

## 2) Remove no-longer-valid direct LLM provider path

File: `packages/channel-voice/src/providers.ts`

- Delete fallback section header at `packages/channel-voice/src/providers.ts:126`.
- Delete `chatCompletion(prompt)` function defined at `packages/channel-voice/src/providers.ts:132`.

Rationale: dead security-risking path should not remain available in this package.

## 3) Remove now-unused LLM fallback config surface

File: `packages/channel-voice/src/config.ts`

- Remove `llm` type section from `Config` at `packages/channel-voice/src/config.ts:12`.
- Remove `llm` config object from `packages/channel-voice/src/config.ts:69`.

Note: keep STT/TTS and shared key behavior unchanged.

## 4) Update docs/env examples to match guardian-only behavior

File: `packages/channel-voice/.env.example`

- Remove LLM fallback block starting at `packages/channel-voice/.env.example:20`.
- Keep guardian vars at `packages/channel-voice/.env.example:33` and `packages/channel-voice/.env.example:34`.

File: `packages/channel-voice/README.md`

- Update configuration table entries at:
  - `packages/channel-voice/README.md:61` (remove `OPENAI_API_KEY` fallback phrasing)
  - `packages/channel-voice/README.md:62`
  - `packages/channel-voice/README.md:63`
  - `packages/channel-voice/README.md:64`
- Clarify that guardian reachability is required for transcript-to-answer processing.

## 5) Align health endpoint with actual runtime dependencies

File: `packages/channel-voice/src/index.ts`

- Remove `llm` object from `/api/health` response at `packages/channel-voice/src/index.ts:60`.

Rationale: avoid exposing a dependency that is no longer used by this service.

## Required Tests

## A) Unit regression tests (must fail before fix, pass after)

File: `packages/channel-voice/src/index.test.ts`

1. Add test for guardian transport failure:
   - Inject fetch that throws from guardian forward path (via `createFetch(mockFetch)`).
   - Send text-only pipeline request.
   - Assert `502` and `code === 'guardian_unavailable'`.

2. Add test for guardian non-OK response:
   - Inject fetch returning `503`.
   - Assert `502`, `code === 'guardian_unavailable'`, and `guardianStatus === 503`.

3. Add regression test proving no direct fallback executes:
   - Temporarily monkeypatch `globalThis.fetch` with a counter.
   - Use injected guardian fetch that throws.
   - Assert counter remains `0` (no out-of-band direct LLM call attempted).

Insertion anchor: append new describe block after existing pipeline validation section near `packages/channel-voice/src/index.test.ts:35`.

## B) E2E behavior update

File: `packages/channel-voice/e2e/voice-channel.test.ts`

- Replace permissive text-path test at `packages/channel-voice/e2e/voice-channel.test.ts:73`.
- New expectation in local e2e (no guardian container):
  - `POST /api/pipeline` with `text` returns `502`.
  - Body includes `code === 'guardian_unavailable'`.

Optional hardening for determinism:

File: `packages/channel-voice/playwright.config.ts`

- Set `GUARDIAN_URL` in test webServer env (block starts at `packages/channel-voice/playwright.config.ts:22`) to an explicit unreachable local endpoint, so failure is immediate and predictable.

## C) Health endpoint test update

Files:

- `packages/channel-voice/src/index.test.ts:22`
- `packages/channel-voice/e2e/voice-channel.test.ts:9`

Changes:

- Remove assertions that depend on `body.llm` and keep STT/TTS assertions only.

## Compatibility Notes

- **Behavior change (intentional, breaking for standalone fallback users):** when guardian is down/unreachable, voice now fails closed with `guardian_unavailable` instead of attempting direct LLM.
- **Security improvement:** all text-to-answer processing is guaranteed to pass through guardian controls.
- **Config compatibility:** legacy `LLM_*` and shared fallback key variables in voice package become unused; remove from docs/examples. If left in deployed env, they are benign but ignored.
- **UI compatibility:** existing UI error handling in `packages/channel-voice/web/app.js:610` already surfaces server errors generically; no frontend contract break required.

## Complexity Callout

- The existing fallback path is unjustified complexity in a security-critical boundary.
- Removing `chatCompletion()` from this channel reduces branching in the critical path and removes a second uncontrolled network dependency.

## Validation Commands

Run from repo root unless noted.

1. Unit/type checks for voice package:

```bash
cd packages/channel-voice && bun test src/ && bun run typecheck
```

2. Voice e2e suite:

```bash
cd packages/channel-voice && bun run test:e2e
```

3. Required project-wide guardrails from backlog checklist:

```bash
cd packages/admin && npm run check
cd core/guardian && bun test
```

## Acceptance Mapping (P0-3)

- "Voice channel requests never bypass guardian": satisfied by removal of direct LLM call path in `packages/channel-voice/src/index.ts:136` and deletion of `packages/channel-voice/src/providers.ts:132`.
- "Failure mode is explicit and auditable": satisfied by structured `guardian_unavailable` 502 responses and error logs in pipeline guardian stage.
