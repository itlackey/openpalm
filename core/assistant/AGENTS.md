# Core: Assistant

## Rules
- Assistant code should focus on extension packaging/runtime integration.
- Keep built-in extensions safe-by-default with least-privilege tool access.
- Maintain compatibility with host override directories mounted at runtime.

## Patterns
- Keep prompts/skills concise and deterministic.
- Use explicit environment variable reads with sensible fallbacks.
- Keep plugin behavior isolated and testable.

## Gotchas
- Do not assume writable image paths; prefer mounted DATA/STATE locations.
- Avoid introducing hidden coupling between extensions and channel adapters.
- Preserve startup behavior when optional services (e.g., OpenMemory) are unavailable.
