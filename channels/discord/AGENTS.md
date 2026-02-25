# Channel: Discord

## Most important rules
- Validate Discord interactions/events before forwarding.
- Enforce permission checks before command execution.
- Blocklists override allowlists.
- Keep bot/app/signing secrets in env only.
- Use deferred responses for assistant queries and follow up via webhook API.
- Keep handlers idempotent for redeliveries and deadline-safe for platform limits.

## Key files
- `channels/discord/src/server.ts`
- `channels/discord/src/interactions.ts`
- `channels/discord/src/commands.ts`
- `channels/discord/src/permissions.ts`
- `channels/discord/src/discord-api.ts`

## Key links
- `channels/discord/README.md`
