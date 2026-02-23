# Core Workspace

## Rules
- Preserve strict service boundaries: Admin orchestration, Gateway ingress/security, Assistant runtime.
- Keep Gateway as the only channel-to-assistant entry path.
- Keep generated runtime artifacts and host path contracts deterministic.

## Patterns
- Place shared validation/generation logic in `packages/lib`.
- Keep HTTP handlers thin and push complex rules into reusable helpers.
- Prefer explicit errors and deterministic state transitions.

## Gotchas
- Do not bypass auth/rate-limit/intake checks.
- Do not write derived runtime state into intent configuration.
- Avoid hidden coupling between core services.
