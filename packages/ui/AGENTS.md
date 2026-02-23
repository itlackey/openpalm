# Package: UI

## Rules
- Prioritize clarity and setup/admin task completion over visual complexity.
- Keep UI state predictable and derived from explicit API contracts.
- Never widen privileged actions in UI without corresponding server validation.

## Patterns
- Build small, composable Svelte components with typed props.
- Keep network/state logic in focused stores or service modules.
- Prefer progressive disclosure in forms and setup flows.

## Gotchas
- Do not rely on client-side checks for security-sensitive behavior.
- Keep editor/config views aligned with current YAML-first stack model.
- Preserve resilient loading/error states for partial backend availability.
