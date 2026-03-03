# @openpalm/channels-sdk

Public SDK for building OpenPalm channel adapters. Extend `BaseChannel` and implement `handleRequest()` to create a new channel — boilerplate for health checks, HMAC signing, guardian forwarding, and structured logging is handled for you.

## Install

```bash
bun add @openpalm/channels-sdk
```

## Quick start

```typescript
import { BaseChannel, type HandleResult } from "@openpalm/channels-sdk";

export default class MyChannel extends BaseChannel {
  name = "my-channel"; // used to resolve CHANNEL_MY_CHANNEL_SECRET

  async handleRequest(req: Request): Promise<HandleResult | null> {
    const body = await req.json() as Record<string, unknown>;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (!userId || !text) return null;
    return { userId, text };
  }
}
```

Set `CHANNEL_PACKAGE=@scope/my-channel` in your registry overlay to have the channel image install and run it automatically.

## API

### `BaseChannel` (abstract)

| Member | Description |
|---|---|
| `name` | Channel identifier — used to resolve the `CHANNEL_<NAME>_SECRET` env var |
| `port` | Listen port (default: `PORT` env or `8080`) |
| `guardianUrl` | Guardian target (default: `GUARDIAN_URL` env) |
| `secret` | HMAC secret — auto-resolved from env |
| `handleRequest(req)` | **Implement this** — parse request, return `{ userId, text }` or `null` |
| `route(req, url)` | Optional — override for custom routing before `handleRequest` |
| `start()` | Start the Bun HTTP server |
| `createFetch(mockFetch?)` | Return fetch handler for unit testing (no server started) |
| `forward(result)` | Sign and POST to guardian (called by base class automatically) |
| `log(level, event, ctx)` | Structured JSON logger |
| `json(status, body)` | Build a JSON `Response` |

### Exports

```typescript
export { BaseChannel, type HandleResult } from "./channel-base.ts";
export { ERROR_CODES, validatePayload, type ChannelPayload, ... } from "./channel.ts";
export { buildChannelMessage, forwardChannelMessage } from "./channel-sdk.ts";
export { signPayload, verifySignature } from "./crypto.ts";
export { createLogger, type LogLevel } from "./logger.ts";
```

## Testing

```typescript
import { describe, test, expect } from "bun:test";
import MyChannel from "./my-channel.ts";

const channel = new MyChannel();
const handler = channel.createFetch();

const resp = await handler(new Request("http://localhost/", {
  method: "POST",
  body: JSON.stringify({ userId: "u1", text: "hello" }),
}));
expect(resp.status).toBe(200);
```

See `src/channel-base.test.ts` for a full test suite.

## Full guide

[`docs/community-channels.md`](../../docs/community-channels.md)
