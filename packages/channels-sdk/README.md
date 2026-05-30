# @openpalm/channels-sdk

Public SDK for building OpenPalm channel adapters. Extend `BaseChannel` and implement `handleRequest()` to create a new channel — boilerplate for health checks, HMAC signing, guardian forwarding, and structured logging is handled for you.

> **Bun required.** This package ships TypeScript source and relies on Bun's native TS execution. It does not compile to JavaScript and is not compatible with Node.js.

## Install

```bash
bun add @openpalm/channels-sdk
```

## Quick start

```typescript
import { BaseChannel, type HandleResult } from "@openpalm/channels-sdk";

export default class MyChannel extends BaseChannel {
  name = "my-channel"; // forwarded payload channel identifier

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
| `name` | Channel identifier used in forwarded guardian payloads |
| `port` | Listen port (default: `PORT` env or `8080`) |
| `guardianUrl` | Guardian target — hardcoded to `http://guardian:8080` (the in-network service name) |
| `secret` | HMAC secret — loaded from the file path in `CHANNEL_SECRET_FILE` |
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

## Secret configuration

Channel containers read their outbound HMAC secret from `CHANNEL_SECRET_FILE`, which must point at a mounted secret file. The guardian reads the matching verification secret from `CHANNEL_<NAME>_SECRET_FILE`, where `<NAME>` is the uppercase channel ID used by the addon overlay, for example `CHANNEL_SLACK_SECRET_FILE`.

Do not pass raw HMAC secrets through `stack.env`, service-level `env_file`, or direct environment values. Stack overlays should grant a Docker Compose secret to both the channel service and guardian, then set only the `*_FILE` variables to the in-container secret paths.

## Full guide

[`docs/community-channels.md`](../../docs/community-channels.md)
