# Package: Lib

## Rules
- `packages/lib` is the shared source of truth for config, generation, and validation logic.
- Keep APIs deterministic and side-effect minimal.
- Changes here must remain backward-safe for admin, CLI, and tests.

## Patterns
- Prefer pure functions and explicit input/output types.
- Centralize schema validation and normalization logic.
- Keep path and env helpers platform-safe and unit-testable.

## Gotchas
- Avoid leaking runtime-only assumptions into intent-level models.
- Be careful with YAML/env interpolation edge cases.
- Do not duplicate constants/contracts already consumed across workspaces.
