# Testing Plan Dispatch Board

This board breaks `docs/testing-plan.md` into parallel tracks so implementation can proceed concurrently.

## Dispatched Tracks

- **Agent 1 — Controller unit tests**
  - Added route-level seams via `createControllerFetch(...)` and unit tests for health, auth rejection, allowed service filtering, and compose response shaping.

- **Agent 2 — Channel adapter unit tests**
  - Added per-adapter tests for health/auth, payload normalization, HMAC signing, validation, and forwarding behavior.

- **Agent 3 — Integration + contract suites**
  - Added integration tests for channel-to-gateway forwarding and admin/controller auth/list flows.
  - Added contract tests for channel message shape plus doc parity checks for controller/admin endpoints.

- **Agent 4 — Security tests**
  - Added security-layer tests for auth enforcement, HMAC validation behavior, and input bounds.

- **Agent 5 — Admin UI Playwright coverage scaffolding**
  - Added initial Playwright UI suite stubs and helpers under `admin/ui/tests/` as the foundation for full Layer 5 implementation.

## Remaining Work (next dispatch wave)

1. Expand UI Playwright stubs into full route/page-object coverage listed in `docs/testing-plan.md`.
2. Add gateway-centered integration tests that exercise intake/core timeout paths in one in-process harness.
3. Add explicit contract schema validators for IntakeDecision and full admin/controller response bodies.
4. Add replay-defense and per-user independence assertions for deeper security coverage.
