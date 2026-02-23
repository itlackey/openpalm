# Channel: Webhook

## Rules
- This adapter is ingress-only: authenticate, validate, normalize, forward.
- Enforce signature/auth checks before payload processing.
- Forward only to Gateway; no direct calls to assistant/admin.

## Patterns
- Keep schema validation close to HTTP boundary.
- Return structured error bodies for invalid requests.
- Make idempotency straightforward for replayed webhook events.

## Gotchas
- Webhook providers often retry aggressively; avoid duplicate side effects.
- Preserve original event IDs/nonces for audit correlation.
- Keep per-provider quirks isolated in dedicated mapping functions.
