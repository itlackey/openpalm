# Channel: Voice

## Rules
- Keep voice channel responsibilities limited to transport and normalization.
- Route every assistant-bound request through Gateway.
- Validate media/session metadata at ingress boundaries.

## Patterns
- Separate transcription/voice transport concerns from gateway payload formatting.
- Use timeout-aware calls for external voice providers.
- Normalize timestamps and session IDs consistently.

## Gotchas
- Voice payloads can be large; avoid unnecessary copies in memory.
- Handle partial/interim events without triggering duplicate final sends.
- Never embed provider credentials in code or logs.
