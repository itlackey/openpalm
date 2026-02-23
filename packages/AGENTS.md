# Packages Workspace

## Rules
- `packages/*` should provide reusable interfaces (CLI, UI, lib) without duplicating core logic.
- Keep shared contracts centralized and consumed consistently across workspaces.
- Favor simple, deterministic operator experiences.

## Patterns
- Use `packages/lib` as the canonical source for schema/config generation logic.
- Keep CLI and UI thin wrappers around stable admin/lib contracts.
- Write tests around boundary contracts and serialization behavior.

## Gotchas
- Divergent assumptions between CLI/UI/Admin can cause config drift.
- Avoid workspace-specific forks of shared constants/contracts.
- Ensure user-facing tools surface actionable errors.
