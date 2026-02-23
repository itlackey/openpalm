# Channel: Chat

## Rules
- Keep this adapter thin: HTTP/WebSocket I/O, normalization, and forwarding only.
- Route all assistant traffic through Gateway; never call assistant or admin directly.
- Validate external input at the edge and return explicit 4xx errors for bad payloads.

## Patterns
- Prefer small pure mappers for platform payload → gateway payload.
- Use Bun-native `Request`/`Response` helpers with JSON responses.
- Keep env-driven configuration explicit with safe defaults.

## Gotchas
- Do not add channel-specific business logic that belongs in Gateway intake.
- Preserve signature/timestamp fields needed for gateway verification.
- Avoid introducing per-message state that can break stateless container restarts.
