# Channel: Chat

## Most important rules
- Keep adapter thin: HTTP/WebSocket I/O, normalization, forwarding.
- Validate external input at boundary; return explicit 4xx for invalid payloads.
- Route all assistant-bound traffic through Gateway.
- Preserve signature/timestamp fields needed for gateway verification.
- Avoid per-message mutable state that breaks stateless restarts.

## Key links
- `channels/chat/README.md`
