# Architecture Simplification Proposals (Implemented Scope)

This document now tracks the **three approved simplifications** and provides a complete implementation specification for each.

> Removed from scope per review feedback:
> - Previous Proposal 3 (unified extension package-manager flow)
> - Previous Proposal 5 (separate operations-plane service)

The remaining proposals are intentionally designed to preserve the current deployment model and security boundaries while significantly reducing complexity.

---

## Proposal 1 — Canonical stack blueprint and one-way rendering

### Goal
Make runtime behavior derivable from one configuration model only.

### Design
Use one canonical typed spec (`stack blueprint`) as the only mutable intent source. All runtime artifacts (compose, caddy config, env files, cron files) are generated artifacts and never edited directly.

**Flow:**

`stack spec (intent) -> generator (pure render) -> rendered artifacts (immutable) -> apply`

### Required implementation rules

1. **Intent-only schema boundary**
   - Keep stack spec limited to user intent fields:
     - global access scope
     - channels (enabled/exposure/config)
     - automations
   - Never persist derived runtime fields into stack spec.

2. **Generated artifact immutability**
   - All output files under rendered state paths are generator-owned.
   - No API endpoint writes ad-hoc changes into rendered files.

3. **Secret resolution contract**
   - Channel config values support direct `${SECRET_NAME}` references.
   - Resolution happens at render time from `secrets.env` only.
   - Missing secret references fail render with structured diagnostics.

4. **Deterministic render output**
   - Stable ordering for services, env files, and Caddy snippets.
   - Same inputs must produce byte-identical artifacts.

5. **Render diagnostics artifact**
   - Write `render-report.json` on each render/apply with:
     - missing refs
     - warnings
     - changed artifact list
     - apply-safe/blocked status

### File-level implementation checklist

- `packages/lib/admin/stack-spec.ts`
  - enforce strict intent-only schema and validation.
- `packages/lib/admin/stack-generator.ts`
  - centralize reference resolution and diagnostics production.
  - guarantee deterministic ordering.
- `packages/lib/admin/stack-manager.ts`
  - ensure writes mutate only stack spec intent.
- `admin/src/server.ts`
  - return structured render diagnostics from preview/apply paths.
- `assets/config/stack-spec.json`
  - retain simplified, intent-only baseline example.

### Acceptance criteria

- Rendering fails for unresolved secret refs with clear machine-readable errors.
- Render output is deterministic for identical input.
- Stack spec round-trip never introduces derived fields.
- Generated artifacts are recreated from spec + secrets without manual edits.

---

## Proposal 2 — Capability-based Admin API surface

### Goal
Reduce endpoint sprawl and make admin behavior easier to reason about and test.

### Design
Introduce a compact capability API while keeping existing routes as compatibility wrappers.

### New canonical surface

- `POST /admin/command`
  - Accepts typed commands:
    - `stack.apply`
    - `stack.render`
    - `channel.configure`
    - `secret.upsert`
    - `secret.delete`
    - `automation.upsert`
    - `automation.delete`
    - `service.restart`
- `GET /admin/state`
  - Returns normalized admin state snapshot.
- `GET /admin/events` (SSE)
  - Streams command progress, warnings, and completion events.

### Required implementation rules

1. **Single command dispatcher**
   - All mutating operations flow through one dispatcher.
   - Legacy endpoints call dispatcher internally.

2. **Uniform response shape**
   - Success: `{ ok: true, data, warnings? }`
   - Error: `{ ok: false, error, code, details? }`

3. **Idempotency and correlation**
   - Every command supports request correlation ID.
   - Safe retries for idempotent commands.

4. **Auth and audit parity**
   - Command API enforces existing admin token rules.
   - Audit logs preserve action intent and result, not only endpoint path.

5. **Compatibility window**
   - Existing endpoints remain supported while UI migrates.
   - Add explicit deprecation metadata in docs and responses.

### File-level implementation checklist

- `admin/src/server.ts`
  - add canonical command/state/events routes.
  - convert existing mutating routes to dispatcher wrappers.
- `packages/lib/admin/*`
  - introduce command handler modules grouped by capability.
  - standardize result/error envelope types.
- `dev/docs/api-reference.md`
  - document only canonical routes and command types.

### Acceptance criteria

- All mutating admin actions execute through the dispatcher.
- Legacy endpoints and canonical command endpoint produce equivalent side effects.
- Response schema is consistent across routes.
- Contract tests validate command payload/response compatibility.

---

## Proposal 4 — Unified channel adapter contract and generation model

### Goal
Make channels predictable and mostly configuration-driven.

### Design
Standardize adapter behavior with a shared channel contract package and generate channel wiring from spec data.

### Required implementation rules

1. **Shared adapter SDK contract**
   - Provide a shared package for:
     - canonical `ChannelMessage` schema
     - HMAC signing + request helper
     - retry/error policy
     - health endpoint helper

2. **Generator-driven channel onboarding**
   - New standard channels are declared through spec snippets.
   - Compose + Caddy + scoped env generation are data-driven.

3. **Strict gateway-only communication**
   - Channels never call assistant/admin/openmemory directly.
   - SDK defaults gateway destination and signing behavior.

4. **Scoped secret emission**
   - Generator emits only referenced secrets into each channel `.env`.

5. **Conformance testing**
   - Every channel must pass contract tests proving schema/signature behavior.

### File-level implementation checklist

- `packages/lib` (new shared channel contract module)
  - define schema and gateway client helpers.
- `channels/*`
  - migrate adapters to shared SDK for normalize/sign/forward behavior.
- `packages/lib/admin/stack-generator.ts`
  - ensure channel config produces compose/caddy/env from spec only.
- `dev/docs/api-reference.md` and `dev/docs/architecture.md`
  - align docs with SDK-based adapter contract and onboarding model.

### Acceptance criteria

- Existing channels use the shared contract path for gateway forwarding.
- Adding a standard channel requires only spec + adapter metadata (no bespoke infra edits).
- Channel env output contains only required referenced secrets.
- Contract tests enforce request schema + signature compatibility.

---

## Rollout sequence (approved scope)

1. Implement Proposal 1 schema/render/diagnostics guarantees.
2. Add Proposal 2 command dispatcher and route compatibility layer.
3. Migrate channels onto Proposal 4 shared contract and conformance tests.

This sequence provides the highest simplification impact first while minimizing migration risk.
