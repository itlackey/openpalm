# Community Channels — BaseChannel SDK

OpenPalm includes a channel SDK that lets developers create custom channel
adapters by extending a single abstract class. Community channels run in Docker
using the prebuilt `channel-base` image — no need to set up boilerplate for
health checks, HMAC signing, guardian forwarding, or structured logging.

---

## Quick Start

1. Write a TypeScript file that extends `BaseChannel`:

```typescript
import { BaseChannel, type HandleResult } from "@openpalm/lib/shared/channel-base.ts";

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

2. Create a Dockerfile:

```dockerfile
FROM openpalm/channel-base:latest
COPY my-channel.ts /app/channel.ts
```

3. Create a compose overlay (`my-channel.yml`) and optional Caddy route
   (`my-channel.caddy`), then install via the admin API or drop them into
   `CONFIG_HOME/channels/`.

---

## Architecture

```
packages/lib/src/shared/
├── channel-base.ts        # BaseChannel abstract class
├── channel-entrypoint.ts  # Dynamic loader (CMD of the base image)
├── channel-sdk.ts         # buildChannelMessage(), forwardChannelMessage()
├── channel.ts             # ChannelPayload type, validatePayload(), ERROR_CODES
├── crypto.ts              # signPayload(), verifySignature()
└── logger.ts              # createLogger() — structured JSON logging

channels/base/
├── Dockerfile             # Prebuilt base image (oven/bun:1-slim + @openpalm/lib)
├── example-channel.ts     # Minimal working example
├── channel-base.test.ts   # Test suite
└── package.json
```

### BaseChannel class

`BaseChannel` provides:

- **Server startup** via `Bun.serve()` with a `/health` endpoint
- **HMAC signing** and **guardian forwarding** via `@openpalm/lib` SDK functions
- **Structured logging** via `createLogger` from `@openpalm/lib/shared/logger.ts`
- **Request validation** (text and userId required)
- **Custom routing** via an optional `route()` method
- **Test harness** via `createFetch()` — returns the fetch handler without starting a server

Developers only need to implement `handleRequest(req: Request)` which parses
the incoming request and returns `{ userId, text }` (or `null` to skip).

### Entrypoint loader

The `channel-entrypoint.ts` script is the `CMD` of the base Docker image:

1. Reads `CHANNEL_FILE` env var (default: `/app/channel.ts`)
2. Dynamically imports the file
3. Validates the default export extends `BaseChannel`
4. Calls `channel.start()`

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `GUARDIAN_URL` | `http://guardian:8080` | Guardian endpoint for message forwarding |
| `CHANNEL_<NAME>_SECRET` | (auto-generated) | HMAC secret — resolved from env by BaseChannel |
| `CHANNEL_FILE` | `/app/channel.ts` | Path to the channel TypeScript file (entrypoint only) |

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

See `channels/base/channel-base.test.ts` for a full test suite.

---

## Example: Complete channel

See `channels/base/example-channel.ts` for a minimal webhook adapter that
accepts `{ userId, text }` JSON payloads and forwards them to the guardian.
