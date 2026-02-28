# Plan: Prebuilt Channel Container Image

## Goal

Provide a prebuilt "base channel" Docker image so that community developers can create a new OpenPalm channel by writing a **single TypeScript file** that extends a base class. The developer's workflow becomes:

```dockerfile
FROM openpalm/channel-base:latest
COPY my-channel.ts /app/channel.ts
```

And their `my-channel.ts`:

```ts
import { BaseChannel } from "@openpalm/lib/shared/channel-base.ts";

export default class SlackChannel extends BaseChannel {
  name = "slack";
  port = 8185;

  async handleRequest(req: Request): Promise<{ userId: string; text: string; metadata?: Record<string, unknown> }> {
    const body = await req.json();
    return { userId: body.user, text: body.text, metadata: { team: body.team_id } };
  }
}
```

That's it — the base image handles server startup, health checks, HMAC signing, guardian forwarding, structured logging, and error handling.

---

## Architecture Analysis

### Current State

Each channel (chat, discord, api) is a standalone `server.ts` that:
1. Reads env vars (`PORT`, `GUARDIAN_URL`, `CHANNEL_<NAME>_SECRET`)
2. Starts a Bun HTTP server
3. Parses incoming requests into `{ userId, channel, text, metadata }`
4. Calls `buildChannelMessage()` and `forwardChannelMessage()` from `@openpalm/lib/shared/channel-sdk.ts`
5. Returns the guardian response

There is significant boilerplate duplication across channels: JSON helpers, env var reading, health endpoints, error handling, server startup, and guardian forwarding.

### What the SDK Already Provides

- `@openpalm/lib/shared/channel-sdk.ts` — `buildChannelMessage()` and `forwardChannelMessage()`
- `@openpalm/lib/shared/channel.ts` — Types (`ChannelPayload`, `ChannelMessageInput`, `GuardianSuccessResponse`) and validation
- `@openpalm/lib/shared/crypto.ts` — HMAC signing/verification

### What's Missing

- **No base class** — each channel re-implements the server scaffold
- **No prebuilt container image** — each channel needs its own Dockerfile with the `@openpalm/lib` copy dance
- **No entrypoint loader** — no mechanism to dynamically load a user-provided channel file

---

## Implementation Plan

### Step 1: Create `BaseChannel` abstract class in `@openpalm/lib`

**File:** `packages/lib/src/shared/channel-base.ts`

The abstract base class encapsulates all common channel behavior:

```ts
export abstract class BaseChannel {
  /** Channel name used in payloads (e.g., "slack", "telegram"). Defaults to env CHANNEL_NAME. */
  abstract name: string;

  /** Port to listen on. Defaults to env PORT or 8080. */
  port: number = Number(Bun.env.PORT ?? 8080);

  /** Guardian URL. Defaults to env GUARDIAN_URL. */
  guardianUrl: string = Bun.env.GUARDIAN_URL ?? "http://guardian:8080";

  /** HMAC secret. Auto-resolved from CHANNEL_<NAME>_SECRET env var. */
  get secret(): string { /* resolve from env */ }

  /**
   * The only method community developers MUST implement.
   * Parse an incoming request into the channel message fields.
   * Return null to skip forwarding (e.g., for webhook verification handshakes).
   */
  abstract handleRequest(req: Request): Promise<HandleResult | null>;

  /**
   * Optional: define custom routes (e.g., webhook verification, OAuth callbacks).
   * Return null to fall through to the default handler.
   */
  route?(req: Request, url: URL): Promise<Response | null>;

  /** Start the Bun HTTP server. Called by the entrypoint loader. */
  start(): void { /* sets up Bun.serve with health, routing, forwarding */ }
}

export type HandleResult = {
  userId: string;
  text: string;
  metadata?: Record<string, unknown>;
};
```

Key design decisions:
- `handleRequest` is the single abstract method — keeps the bar as low as possible
- `route()` is optional for channels that need custom endpoints (OAuth, webhook verification)
- Environment variables are auto-resolved by convention (`CHANNEL_<NAME>_SECRET`)
- The `start()` method wires up: health endpoint, custom routes, request parsing, message building, guardian forwarding, error handling, and structured JSON logging

### Step 2: Create the entrypoint loader

**File:** `packages/lib/src/shared/channel-entrypoint.ts`

A small script that:
1. Resolves the channel file path from env `CHANNEL_FILE` (default: `/app/channel.ts`)
2. Dynamically imports it: `const mod = await import(path)`
3. Instantiates the default export: `const channel = new mod.default()`
4. Validates it's a `BaseChannel` instance
5. Calls `channel.start()`

This is what the Docker CMD runs.

### Step 3: Export the new modules from `@openpalm/lib`

**File:** `packages/lib/package.json` — add exports:

```json
{
  "exports": {
    "./shared/channel-base.ts": "./src/shared/channel-base.ts",
    "./shared/channel-entrypoint.ts": "./src/shared/channel-entrypoint.ts"
  }
}
```

### Step 4: Create the prebuilt base Dockerfile

**File:** `channels/base/Dockerfile`

```dockerfile
FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pre-install SDK
COPY packages/lib /app/node_modules/@openpalm/lib

# Minimal package.json for the base image (no extra deps needed)
COPY channels/base/package.json ./

USER bun

ENV PORT=8080
ENV CHANNEL_FILE=/app/channel.ts
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:${PORT}/health || exit 1

CMD ["bun", "run", "node_modules/@openpalm/lib/src/shared/channel-entrypoint.ts"]
```

**File:** `channels/base/package.json` — minimal, just declares the `@openpalm/lib` dependency.

### Step 5: Add build entry for docker-compose.override.yml

Add the base image to `docker-compose.override.yml` so it gets built alongside other images:

```yaml
  channel-base:
    build:
      context: .
      dockerfile: channels/base/Dockerfile
    image: openpalm/channel-base:latest
```

### Step 6: Add an example community channel

**File:** `channels/base/example-channel.ts`

A minimal, well-commented example showing how to create a channel:

```ts
import { BaseChannel, type HandleResult } from "@openpalm/lib/shared/channel-base.ts";

/**
 * Example: Minimal webhook channel.
 *
 * Usage:
 *   FROM openpalm/channel-base:latest
 *   COPY my-channel.ts /app/channel.ts
 */
export default class ExampleChannel extends BaseChannel {
  name = "example";

  async handleRequest(req: Request): Promise<HandleResult | null> {
    const body = await req.json() as Record<string, unknown>;
    return {
      userId: String(body.userId ?? "anonymous"),
      text: String(body.text ?? ""),
    };
  }
}
```

### Step 7: Write tests

**File:** `channels/base/channel-base.test.ts`

Test the `BaseChannel` class:
- Health endpoint returns correct JSON
- `handleRequest` result is properly forwarded to guardian
- Null return from `handleRequest` is handled (no forward)
- Custom `route()` method is called when defined
- Missing secret causes startup failure
- Invalid JSON returns 400
- Guardian errors are surfaced as 502

### Step 8: Add workspace entry

**File:** `package.json` (root) — add `"channels/base"` to workspaces.

---

## Files Created/Modified

| File | Action | Purpose |
|------|--------|---------|
| `packages/lib/src/shared/channel-base.ts` | **Create** | Abstract `BaseChannel` class |
| `packages/lib/src/shared/channel-entrypoint.ts` | **Create** | Dynamic loader / CMD entrypoint |
| `packages/lib/package.json` | **Modify** | Add new exports |
| `channels/base/Dockerfile` | **Create** | Prebuilt base image |
| `channels/base/package.json` | **Create** | Minimal package for base image |
| `channels/base/example-channel.ts` | **Create** | Documented example for community devs |
| `channels/base/channel-base.test.ts` | **Create** | Tests for BaseChannel |
| `docker-compose.override.yml` | **Modify** | Add channel-base build |
| `package.json` (root) | **Modify** | Add workspace entry |

---

## Community Developer Experience

After this work, creating a new channel is:

1. **Write one file** (`my-channel.ts`) that extends `BaseChannel` and implements `handleRequest`
2. **Write a 2-line Dockerfile:**
   ```dockerfile
   FROM openpalm/channel-base:latest
   COPY my-channel.ts /app/channel.ts
   ```
3. **If the channel needs extra npm deps**, add a `package.json` and `RUN bun install`:
   ```dockerfile
   FROM openpalm/channel-base:latest
   COPY package.json ./
   RUN bun install --production
   COPY my-channel.ts /app/channel.ts
   ```
4. **Create a registry entry** (`.yml` + optional `.caddy`) to make it installable via the admin API

No need to understand HMAC signing, guardian protocol, health checks, structured logging, or Bun server setup.
