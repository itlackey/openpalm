# P1-4 Implementation Plan: Assistant Endpoint Allowlist Policy Enforcement

Date: 2026-03-24  
Backlog item: `P1-4` in `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:243`

## Objective

Enforce a centralized, explicit endpoint policy matrix so assistant-token access is allowlisted per route/action instead of being implicitly granted by scattered `requireAuth(...)` checks.

This directly addresses the backlog problem statement (`docs/reports/end-to-end-remediation-backlog-2026-03-24.md:250`) and aligns with the authoritative requirement that assistant access to admin APIs is authenticated and allowlisted (`docs/technical/authoritative/core-principles.md:83`, `docs/technical/authoritative/core-principles.md:162`).

## Scope and Constraints

- In scope: admin API auth/policy enforcement under `packages/admin/src/routes/admin/**/+server.ts`.
- In scope: shared helper/guard design in `packages/admin/src/lib/server/helpers.ts`.
- In scope: tests for allowed and blocked assistant operations.
- Out of scope: changing business logic for endpoints; this work is authorization-only.
- Out of scope: expanding orchestration behavior or filesystem contract.

## Current State (Why This Is Needed)

- Assistant and admin tokens are both accepted by `requireAuth(...)` (`packages/admin/src/lib/server/helpers.ts:91`).
- `identifyCallerByToken(...)` already identifies `admin|assistant` (`packages/admin/src/lib/server/helpers.ts:82`).
- Route handlers choose either `requireAdmin(...)` or `requireAuth(...)` ad hoc, creating no single auditable policy matrix (`packages/admin/src/lib/server/helpers.ts:64`, `packages/admin/src/lib/server/helpers.ts:91`).
- API conventions still describe protected routes as token-gated but do not define assistant per-endpoint policy (`docs/technical/api-spec.md:9`).

## Policy Matrix Approach

Use one canonical matrix keyed by operation identifier:

- Operation key format: ``<METHOD> <route-pattern>``
  - Examples: `GET /admin/automations`, `POST /admin/memory/config`, `GET /admin/artifacts/:name`
- Principals: `admin`, `assistant`
- Decision: `allow | deny`
- Rule model:
  - `admin`: allowed for all authenticated admin routes unless explicitly denied (none expected in this tranche)
  - `assistant`: default deny, explicit allowlist only

### Proposed matrix location

- New policy module (admin-local):
  - `packages/admin/src/lib/server/assistant-policy.ts` (new)
- Keep policy definition data-only and small:
  - `type EndpointPolicy = { operation: string; assistant: 'allow' | 'deny' }`
  - `const ASSISTANT_ALLOWLIST = new Set<string>(...)`

Rationale: this avoids unjustified abstraction and keeps enforcement simple, auditable, and easy to diff.

## Route Inventory and Proposed Assistant Policy

### A) Endpoints currently assistant-reachable (`requireAuth`) and recommended policy

These are currently reachable by assistant token and become explicitly allowlisted/denied.

Allow (read-only/introspection surfaces):

- `GET /admin/artifacts` (`packages/admin/src/routes/admin/artifacts/+server.ts:9`)
- `GET /admin/artifacts/manifest` (`packages/admin/src/routes/admin/artifacts/manifest/+server.ts:9`)
- `GET /admin/artifacts/:name` (`packages/admin/src/routes/admin/artifacts/[name]/+server.ts:15`)
- `GET /admin/audit` (`packages/admin/src/routes/admin/audit/+server.ts:47`)
- `GET /admin/automations` (`packages/admin/src/routes/admin/automations/+server.ts:20`)
- `GET /admin/config/validate` (`packages/admin/src/routes/admin/config/validate/+server.ts:20`)
- `GET /admin/containers/events` (`packages/admin/src/routes/admin/containers/events/+server.ts:14`)
- `GET /admin/containers/list` (`packages/admin/src/routes/admin/containers/list/+server.ts:13`)
- `GET /admin/containers/stats` (`packages/admin/src/routes/admin/containers/stats/+server.ts:14`)
- `GET /admin/installed` (`packages/admin/src/routes/admin/installed/+server.ts:15`)
- `GET /admin/logs` (`packages/admin/src/routes/admin/logs/+server.ts:17`)
- `GET /admin/memory/config` (`packages/admin/src/routes/admin/memory/config/+server.ts:28`)
- `GET /admin/network/check` (`packages/admin/src/routes/admin/network/check/+server.ts:41`)
- `GET /admin/registry` (`packages/admin/src/routes/admin/registry/+server.ts:25`)

Deny by default unless product requirement explicitly confirms:

- `POST /admin/memory/models` (`packages/admin/src/routes/admin/memory/models/+server.ts:27`)
  - Although currently `requireAuth`, this calls external providers and may expose broader capability than needed. Keep denied initially, then allowlist only if assistant workflows require it.

### B) Endpoints currently admin-only (`requireAdmin`) and proposed policy

Keep denied for assistant in this tranche (mutation/lifecycle/secret surfaces):

- Lifecycle and container mutation endpoints (`/admin/install`, `/admin/update`, `/admin/uninstall`, `/admin/upgrade`, `/admin/containers/*` POST) including `packages/admin/src/routes/admin/install/+server.ts:28`, `packages/admin/src/routes/admin/update/+server.ts:16`, `packages/admin/src/routes/admin/uninstall/+server.ts:16`, `packages/admin/src/routes/admin/upgrade/+server.ts:30`, `packages/admin/src/routes/admin/containers/up/+server.ts:18`.
- Secret management endpoints (`packages/admin/src/routes/admin/secrets/+server.ts:23`, `packages/admin/src/routes/admin/secrets/generate/+server.ts:18`).
- Addon/registry mutation endpoints (`packages/admin/src/routes/admin/addons/+server.ts:84`, `packages/admin/src/routes/admin/addons/[name]/+server.ts:74`, `packages/admin/src/routes/admin/registry/install/+server.ts:35`, `packages/admin/src/routes/admin/registry/uninstall/+server.ts:29`).
- Provider/auth and connection mutation/export endpoints (`packages/admin/src/routes/admin/opencode/providers/[id]/auth/+server.ts:116`, `packages/admin/src/routes/admin/connections/+server.ts:64`, `packages/admin/src/routes/admin/connections/export/opencode/+server.ts:16`).

Note: this is intentionally conservative for first rollout (least-privilege). Additional assistant write operations can be explicitly added in follow-up PRs.

## Middleware/Guard Design

## 1) Keep token verification centralized, add policy gate after authentication

Extend `helpers.ts` with a new authorization helper while preserving current token verification primitives:

- Existing auth primitives to retain:
  - `identifyCallerByToken(...)` (`packages/admin/src/lib/server/helpers.ts:82`)
  - `requireAdmin(...)` (`packages/admin/src/lib/server/helpers.ts:64`)
  - `requireAuth(...)` (`packages/admin/src/lib/server/helpers.ts:91`)
- New helper (proposed):
  - `authorizeEndpoint(event, requestId, operation)`
  - Behavior:
    1. authenticate caller (`admin|assistant|null`)
    2. reject unauthenticated with existing 401 envelope
    3. if `admin`, allow
    4. if `assistant`, enforce allowlist matrix
    5. on deny, return `403` with stable code (e.g. `assistant_forbidden`), include `operation`

## 2) Route usage pattern

In each route handler, replace `requireAuth(...)` with one operation-specific authorization call:

- Example pattern:
  - from: `const authErr = requireAuth(event, requestId)`
  - to: `const authErr = authorizeEndpoint(event, requestId, 'GET /admin/automations')`

Routes that already use `requireAdmin(...)` can remain unchanged in phase 1; policy matrix applies where assistant access is possible.

## 3) Audit behavior

- Keep existing actor derivation via token (`packages/admin/src/lib/server/helpers.ts:111`).
- On denied assistant operations, add explicit audit entries (or ensure existing route-level audit logs include deny path) for traceability.

## 4) Complexity guardrails

- Do not add framework-level dynamic router introspection.
- Do not build policy engines/DSLs.
- Keep operation keys literal and checked by tests.

## Test Plan

## A) Unit tests for helper/policy logic

Primary file:

- `packages/admin/src/lib/server/helpers.test.ts`

Add test cases:

- assistant token allowed for allowlisted operation -> `null` (authorized)
- assistant token denied for non-allowlisted operation -> `403 assistant_forbidden`
- admin token allowed regardless of assistant allowlist
- unknown token still returns `401 unauthorized`

If policy map is split into a new module, add:

- `packages/admin/src/lib/server/assistant-policy.test.ts` (new)
  - verifies no duplicate operation keys
  - verifies all operation strings are normalized and deterministic

## B) Route-level regression tests (assistant allow + deny)

Existing route test coverage exists for several admin-only endpoints, including assistant deny on secrets (`packages/admin/src/routes/admin/secrets/server.test.ts:103`).

Add/extend tests to prove matrix enforcement at handler boundaries:

- Allowed assistant examples:
  - `GET /admin/automations`
  - `GET /admin/installed`
  - `GET /admin/artifacts`
- Denied assistant examples:
  - `POST /admin/memory/models` (if denied in initial matrix)
  - existing `GET /admin/secrets` deny remains

## C) Route inventory completeness test

Add one guardrail test to prevent policy drift:

- Enumerate all admin route operation keys and assert each has explicit assistant decision.
- Location: `packages/admin/src/lib/server` or `packages/admin/src/routes/admin` test suite (single source test).

This prevents new routes from silently inheriting broad assistant access.

## D) Verification commands

- `cd packages/admin && npm run check`
- `cd packages/admin && bun test`
- `cd core/guardian && bun test`

## Rollout and Safety Plan

## Phase 0: Inventory + matrix commit (no behavior change)

- Land route inventory and matrix definition with tests that validate key coverage.
- Optionally run in report-only mode first (log deny decisions without enforcing) if needed for compatibility checks.

## Phase 1: Enforce on current `requireAuth` routes

- Apply `authorizeEndpoint(...)` to all `requireAuth` routes.
- Keep admin-only (`requireAdmin`) routes unchanged to minimize blast radius.

## Phase 2: Tighten/expand allowlist based on observed assistant workflows

- If specific assistant write paths are required by product workflows, add them explicitly and test each.
- Update API spec to include assistant allowlist policy section.

## Safety controls

- Default deny for assistant when operation key missing from matrix.
- Structured 403 error for quick diagnosis (not generic 401).
- Audit denied events with request id and operation.
- Keep rollback simple: if regressions occur, revert guard callsites; no state migration involved.

## Documentation Updates

- Update authentication/conventions in `docs/technical/api-spec.md:6` to define:
  - admin token behavior
  - assistant token allowlist behavior
  - 403 error shape for blocked assistant operations
- Add a short policy section in the relevant technical docs index/runbook if needed.

## File-Level Change Plan

- Update `packages/admin/src/lib/server/helpers.ts` (new authorization helper)
- Add `packages/admin/src/lib/server/assistant-policy.ts` (new matrix; data-only)
- Update `packages/admin/src/lib/server/helpers.test.ts` (authorization tests)
- Add `packages/admin/src/lib/server/assistant-policy.test.ts` (coverage/guardrail tests)
- Update all `requireAuth` admin route handlers under `packages/admin/src/routes/admin/**/+server.ts`
- Extend route tests under `packages/admin/src/routes/admin/**/server.test.ts`
- Update `docs/technical/api-spec.md`

## Definition of Done for P1-4

- Assistant token access is denied unless explicitly allowlisted per operation.
- Policy decisions are centralized and test-guarded against route drift.
- Existing admin token behavior remains unchanged.
- Blocked assistant calls return consistent `403` with request id.
- Documentation reflects enforced assistant allowlist policy.
