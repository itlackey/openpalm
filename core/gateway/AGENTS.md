# Core: Gateway

## Rules
- Gateway is the only ingress to assistant runtime from channels.
- Enforce HMAC/auth, validation, and rate limits before intake execution.
- Keep channel-intake contract strict and deterministic.

## Patterns
- Keep handlers small: authenticate → validate → intake → dispatch → audit.
- Prefer explicit error codes for invalid payload/intake outcomes.
- Isolate provider adapters from core routing logic.

## Gotchas
- Never bypass intake validation for convenience paths.
- Be careful with timeout/retry behavior to avoid duplicate assistant calls.
- Preserve auditability (nonce, timestamps, channel metadata) in logs/events.
