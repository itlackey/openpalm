# Channels Workspace

## Rules
- Channel adapters are ingress translators, not business-logic engines.
- Forward assistant-bound traffic only to Gateway.
- Validate and normalize untrusted platform input before forwarding.

## Patterns
- Keep provider parsing isolated from OpenPalm payload construction.
- Return retry-safe HTTP codes for webhook/event delivery semantics.
- Preserve stable channel/user/event identifiers for auditability.

## Gotchas
- Providers may redeliver events; keep behavior idempotent.
- Avoid coupling channel code to assistant runtime internals.
- Keep secrets in scoped env, never in code/log output.
