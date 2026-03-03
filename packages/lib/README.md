# @openpalm/lib

Internal shared library used by the guardian and other core services. Provides channel payload types, HMAC crypto, structured logging, env parsing, and the `BaseChannel` / entrypoint helpers.

> **Community channel developers:** use [`@openpalm/channels-sdk`](../channels-sdk/README.md) instead — it is the public-facing SDK with a stable API. `@openpalm/lib` is private (`"private": true`) and its internals may change.

## Exports

| Path | Contents |
|---|---|
| `@openpalm/lib/shared/channel.ts` | `ChannelPayload`, `validatePayload`, `ERROR_CODES` |
| `@openpalm/lib/shared/crypto.ts` | `signPayload`, `verifySignature` |
| `@openpalm/lib/shared/channel-sdk.ts` | `buildChannelMessage`, `forwardChannelMessage` |
| `@openpalm/lib/shared/channel-base.ts` | `BaseChannel`, `HandleResult` |
| `@openpalm/lib/shared/channel-entrypoint.ts` | Dynamic channel loader |
| `@openpalm/lib/shared/logger.ts` | `createLogger`, `LogLevel` |
| `@openpalm/lib/shared/env.ts` | `parseEnvContent` |

## Development

```bash
cd packages/lib && bun test
```

Or from the repo root:

```bash
bun run lib:test
```
