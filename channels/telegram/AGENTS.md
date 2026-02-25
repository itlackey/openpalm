# Channel: Telegram

## Most important rules
- Accept Telegram updates, normalize payloads, and forward only to Gateway.
- Validate update type variants explicitly; ignore unsupported events safely.
- Return fast 2xx responses when processing is delegated.
- Preserve chat/user/message identifiers for auditing.
- Keep adapter secrets scoped to container env.

## Key links
- `channels/telegram/README.md`
