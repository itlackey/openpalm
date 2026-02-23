# Package: CLI

## Rules
- CLI should convert simple operator intent into deterministic config/actions.
- Keep commands scriptable: stable flags, predictable stdout/stderr, non-zero exit on failure.
- Do not hide destructive operations; require explicit opt-in.

## Patterns
- Keep command modules small and composable.
- Reuse `packages/lib` primitives instead of duplicating logic.
- Emit concise human output and machine-friendly error messages.

## Gotchas
- Avoid interactive-only flows unless explicitly requested.
- Keep file writes atomic where possible to prevent partial state.
- Ensure CLI defaults match Admin/generator assumptions.
