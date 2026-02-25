# Channel: Webhook

## Most important rules
- Keep adapter ingress-only: authenticate, validate, normalize, forward.
- Enforce signature/auth checks before processing payloads.
- Return structured, retry-safe responses.
- Keep idempotency simple for provider retries/replays.
- Preserve original event IDs/nonces for audit correlation.

## Key links
- `channels/webhook/README.md`
