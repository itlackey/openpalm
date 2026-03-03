# Community Channels — BaseChannel SDK

OpenPalm includes a channel SDK (`@openpalm/channels-sdk`) that lets developers
create custom channel adapters by extending a single abstract class. Community
channels run in Docker using the prebuilt `channel` image — no boilerplate for
health checks, HMAC signing, guardian forwarding, or structured logging.

---

## Quick Start

1. Write a TypeScript file that extends `BaseChannel`:

```typescript
import { BaseChannel, type HandleResult } from "@openpalm/channels-sdk";

export default class MyChannel extends BaseChannel {
  name = "my-channel";

  async handleRequest(req: Request): Promise<HandleResult | null> {
    const body = await req.json() as Record<string, unknown>;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (!userId || !text) return null;
    return { userId, text };
  }
}
```

2. Publish the file as an npm package (or use `CHANNEL_FILE` for file-based
   channels). Registry channels use `CHANNEL_PACKAGE` to install the package
   at container start.

3. Create a compose overlay (`my-channel.yml`) and optional Caddy route
   (`my-channel.caddy`), then install via the admin API or drop them into
   `CONFIG_HOME/channels/`.

---

## Architecture

```
packages/channels-sdk/src/
├── channel-base.ts        # BaseChannel abstract class
├── channel-entrypoint.ts  # Dynamic loader (CMD of the channel image)
├── channel-sdk.ts         # buildChannelMessage(), forwardChannelMessage()
├── channel.ts             # ChannelPayload type, validatePayload(), ERROR_CODES
├── crypto.ts              # signPayload(), verifySignature()
└── logger.ts              # createLogger() — structured JSON logging

core/channel/
├── Dockerfile             # Unified channel image (oven/bun:1-slim + channels-sdk)
└── start.sh               # Installs CHANNEL_PACKAGE then runs channel-entrypoint
```

### BaseChannel class

`BaseChannel` provides:

- **Server startup** via `Bun.serve()` with a `/health` endpoint
- **HMAC signing** and **guardian forwarding** via `@openpalm/channels-sdk` helpers
- **Structured logging** via `createLogger` from `@openpalm/channels-sdk`
- **Request validation** (text and userId required)
- **Custom routing** via an optional `route()` method
- **Test harness** via `createFetch()` — returns the fetch handler without starting a server

Developers only need to implement `handleRequest(req: Request)` which parses
the incoming request and returns `{ userId, text }` (or `null` to skip).

### Entrypoint loader

The `channel-entrypoint.ts` script is the `CMD` of the channel Docker image:

1. If `CHANNEL_PACKAGE` is set, imports the npm package
2. Otherwise imports the file at `CHANNEL_FILE` (default: `/app/channel.ts`)
3. Validates the default export extends `BaseChannel`
4. Calls `channel.start()`

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `GUARDIAN_URL` | `http://guardian:8080` | Guardian endpoint for message forwarding |
| `CHANNEL_<NAME>_SECRET` | (auto-generated) | HMAC secret — resolved from env by BaseChannel |
| `CHANNEL_PACKAGE` | — | npm package name to install and load |
| `CHANNEL_FILE` | `/app/channel.ts` | Path to a local channel `.ts` file (fallback) |

---

## Testing

BaseChannel exposes `createFetch()` for testing without starting a real server:

```typescript
import { describe, test, expect, mock } from "bun:test";
import MyChannel from "./my-channel.ts";

const channel = new MyChannel();
const handler = channel.createFetch(mockFetch);

const resp = await handler(new Request("http://localhost/", {
  method: "POST",
  body: JSON.stringify({ userId: "u1", text: "hello" }),
}));
expect(resp.status).toBe(200);
```

See `packages/channels-sdk/src/channel-base.test.ts` for a full test suite.

---

## Built-in channel packages

| Package | Description |
|---|---|
| [`@openpalm/channel-chat`](../packages/channel-chat/) | OpenAI/Anthropic-compatible chat API |
| [`@openpalm/channel-api`](../packages/channel-api/) | Full OpenAI + Anthropic API facade |
| [`@openpalm/channel-discord`](../packages/channel-discord/) | Discord webhook adapter |
