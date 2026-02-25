# Core: Gateway

## Most important rules
- Gateway is the only channel-to-assistant ingress path.
- Enforce auth/HMAC, validation, and rate limits before intake execution.
- Keep intake contract strict, deterministic, and auditable.
- Preserve nonce/timestamp/channel metadata for logs and replay safety.
- Avoid duplicate assistant calls by handling retries/timeouts carefully.

## Key links
- `core/gateway/README.md`
- `dev/docs/architecture.md`
- `dev/docs/api-reference.md`
