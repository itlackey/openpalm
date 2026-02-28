# Channel: Discord

## Most important rules
- Validate Discord interactions/events before forwarding.
- Enforce permission checks before command execution.
- Blocklists override allowlists.
- Keep bot/app/signing secrets in env only.
- Use deferred responses for assistant queries and follow up via webhook API.
- Keep handlers idempotent for redeliveries and deadline-safe for platform limits.

## Key files
- `channels/discord/server.ts`

## Key links
- `channels/discord/README.md`
