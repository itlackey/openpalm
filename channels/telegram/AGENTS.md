# Channel: Telegram

## Rules
- Accept Telegram updates, normalize, and forward only to Gateway.
- Validate update types explicitly; ignore unsupported events safely.
- Keep secrets scoped to this adapter's env file.

## Patterns
- Use focused parsers for update/message/callback variants.
- Prefer explicit guards for optional Telegram fields.
- Return fast 2xx acknowledgements when work is delegated.

## Gotchas
- Telegram retries webhook delivery on non-2xx responses.
- Non-text updates are common; handle them without crashing.
- Preserve chat/user identifiers exactly for downstream auditing.
