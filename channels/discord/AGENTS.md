# Channel: Discord

## Rules
- Treat Discord updates as untrusted input; validate before forwarding.
- Communicate only with Gateway for message ingestion.
- Keep bot token and signing secrets in env vars; never hardcode credentials.

## Patterns
- Isolate Discord-specific parsing from shared OpenPalm payload construction.
- Handle Discord API failures with clear retry-safe error paths.
- Keep slash command/webhook handling deterministic and idempotent.

## Gotchas
- Discord can redeliver events; avoid duplicate side effects.
- Respect platform rate limits when posting replies/status updates.
- Keep payload mapping stable for mention handling and attachment metadata.
