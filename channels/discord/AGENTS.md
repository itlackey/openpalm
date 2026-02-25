# Channel: Discord

## Rules
- Treat Discord updates as untrusted input; validate before forwarding.
- Communicate only with Gateway for message ingestion.
- Keep bot token, signing secrets, and application ID in env vars; never hardcode credentials.
- Permission checks (guild/role/user) must run before any command processing.
- Blocklists always take priority over allowlists.

## Patterns
- Isolate Discord-specific parsing from shared OpenPalm payload construction.
- Handle Discord API failures with clear retry-safe error paths.
- Keep slash command/webhook handling deterministic and idempotent.
- Use deferred responses (type 5) for assistant queries to avoid the 3-second deadline.
- Follow up via Discord webhook API (editOriginalResponse) after deferred responses.
- Custom commands use prompt templates with {{placeholder}} substitution.
- All log output is structured JSON for aggregator compatibility.

## File Structure
- `types.ts` — Discord API types and custom command/permission types.
- `logger.ts` — Structured JSON logging.
- `permissions.ts` — Guild/role/user constraint checking.
- `discord-api.ts` — Discord REST API client for command registration and follow-ups.
- `commands.ts` — Built-in command definitions and custom command parsing.
- `interactions.ts` — Interaction routing and handler logic.
- `server.ts` — Main entry point, HTTP server, startup validation.

## Gotchas
- Discord can redeliver events; avoid duplicate side effects.
- Respect platform rate limits when posting replies/status updates.
- Keep payload mapping stable for mention handling and attachment metadata.
- Deferred responses have a 15-minute window for follow-up; assistant timeout should be well below this.
- Discord limits slash commands to 100 per application (25 per guild for guild-scoped).
- Embed descriptions are limited to 4096 characters; message content to 2000.
- Custom command names must match /^[\w-]{1,32}$/ and cannot conflict with builtins.
