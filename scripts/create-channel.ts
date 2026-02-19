#!/usr/bin/env bun
/**
 * Channel Starter Kit — scaffold a new channel adapter.
 *
 * Usage:
 *   bun run create:channel my-channel
 *   bun run create:channel my-channel --port 8190
 *
 * This creates:
 *   channels/<name>/server.ts       — adapter + server harness
 *   channels/<name>/server.test.ts  — starter tests
 *   channels/<name>/channel.ts      — ChannelAdapter implementation (edit this)
 *   channels/<name>/package.json
 *   channels/<name>/Dockerfile
 *
 * It also prints instructions for wiring the channel into the gateway,
 * compose files, Caddyfile, and env configuration.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ── CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function usage(): never {
  console.error("Usage: bun run create:channel <channel-name> [--port <number>]");
  console.error("");
  console.error("  channel-name   lowercase alphanumeric + hyphens (e.g. slack, matrix, sms)");
  console.error("  --port         default listening port (default: auto-assigned 8190+)");
  process.exit(1);
}

const nameArg = args.find((a) => !a.startsWith("--"));
if (!nameArg) usage();

const NAME = nameArg.toLowerCase();
if (!/^[a-z][a-z0-9-]*$/.test(NAME)) {
  console.error(`Error: channel name must be lowercase alphanumeric with hyphens, got "${NAME}"`);
  process.exit(1);
}

if (NAME.length > 32) {
  console.error("Error: channel name must be 32 characters or fewer");
  process.exit(1);
}

const RESERVED = new Set(["chat", "discord", "voice", "telegram", "webhook"]);
if (RESERVED.has(NAME)) {
  console.error(`Error: "${NAME}" is an existing built-in channel. Choose a different name.`);
  process.exit(1);
}

const portIdx = args.indexOf("--port");
const DEFAULT_PORT = portIdx !== -1 && args[portIdx + 1] ? Number(args[portIdx + 1]) : 8190;
if (isNaN(DEFAULT_PORT) || DEFAULT_PORT < 1024 || DEFAULT_PORT > 65535) {
  console.error("Error: --port must be a number between 1024 and 65535");
  process.exit(1);
}

// ── Paths ──────────────────────────────────────────────────────────────
const ROOT = resolve(import.meta.dir, "..");
const CHANNEL_DIR = join(ROOT, "channels", NAME);

if (existsSync(CHANNEL_DIR)) {
  console.error(`Error: channels/${NAME}/ already exists.`);
  process.exit(1);
}

// ── Derived names ─────────────────────────────────────────────────────
const ENV_PREFIX = NAME.replace(/-/g, "_").toUpperCase();
const SECRET_VAR = `CHANNEL_${ENV_PREFIX}_SECRET`;
const INBOUND_TOKEN_VAR = `${ENV_PREFIX}_INBOUND_TOKEN`;
const SERVICE_NAME = `channel-${NAME}`;
const CAMEL = NAME.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const PASCAL = CAMEL.charAt(0).toUpperCase() + CAMEL.slice(1);
const CREATE_FN = `create${PASCAL}Channel`;

// ── Templates ──────────────────────────────────────────────────────────

const channelTs = `import type { ChannelAdapter, InboundResult } from "@openpalm/shared";

/**
 * ${PASCAL} channel adapter.
 *
 * Edit this file to implement your platform-specific logic:
 * - Parse inbound requests from your platform (Slack, Matrix, SMS, etc.)
 * - Authenticate the caller (verify webhook signatures, tokens, etc.)
 * - Normalize the request into a ChannelPayload
 *
 * The server harness handles HMAC signing and gateway forwarding for you.
 */

const INBOUND_TOKEN = Bun.env.${INBOUND_TOKEN_VAR} ?? "";

export function ${CREATE_FN}(): ChannelAdapter {
  return {
    name: "${NAME}",

    routes: [
      {
        method: "POST",
        path: "/${NAME}/inbound",
        handler: async (req: Request): Promise<InboundResult> => {
          // Step 1: Authenticate the caller (optional but recommended)
          if (INBOUND_TOKEN && req.headers.get("x-${NAME}-token") !== INBOUND_TOKEN) {
            return { ok: false, status: 401, body: { error: "unauthorized" } };
          }

          // Step 2: Parse the platform-specific request body
          const body = (await req.json()) as {
            userId?: string;
            text?: string;
            metadata?: Record<string, unknown>;
          };

          if (!body.text) {
            return { ok: false, status: 400, body: { error: "text_required" } };
          }

          // Step 3: Return the normalized payload
          return {
            ok: true,
            payload: {
              userId: body.userId ?? "${NAME}-user",
              channel: "${NAME}",
              text: body.text,
              metadata: body.metadata ?? {},
            },
          };
        },
      },
    ],

    health: () => ({ ok: true, service: "${SERVICE_NAME}" }),
  };
}
`;

const serverTs = `import { createHmac } from "node:crypto";
import { ${CREATE_FN} } from "./channel.ts";
import type { ChannelAdapter } from "@openpalm/shared";

const PORT = Number(Bun.env.PORT ?? ${DEFAULT_PORT});
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.${SECRET_VAR} ?? "";

export function signPayload(secret: string, body: string) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createFetch(
  adapter: ChannelAdapter,
  gatewayUrl: string,
  sharedSecret: string,
  forwardFetch: typeof fetch = fetch,
) {
  // Build a route lookup for O(1) matching.
  const routeMap = new Map(
    adapter.routes.map((r) => [\`\${r.method} \${r.path}\`, r.handler]),
  );

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Health endpoint — always available.
    if (url.pathname === "/health") return json(200, adapter.health());

    // Match the request to a route.
    const handler = routeMap.get(\`\${req.method} \${url.pathname}\`);
    if (!handler) return json(404, { error: "not_found" });

    // Run the adapter's handler.
    const result = await handler(req);
    if (!result.ok) return json(result.status, result.body);

    // Build the gateway payload with nonce + timestamp.
    const gatewayPayload = {
      ...result.payload,
      nonce: crypto.randomUUID(),
      timestamp: Date.now(),
    };

    // HMAC-sign and forward to gateway.
    const serialized = JSON.stringify(gatewayPayload);
    const sig = signPayload(sharedSecret, serialized);

    const resp = await forwardFetch(\`\${gatewayUrl}/channel/inbound\`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-signature": sig,
      },
      body: serialized,
    });

    return new Response(await resp.text(), {
      status: resp.status,
      headers: { "content-type": "application/json" },
    });
  };
}

if (import.meta.main) {
  const adapter = ${CREATE_FN}();
  Bun.serve({ port: PORT, fetch: createFetch(adapter, GATEWAY_URL, SHARED_SECRET) });
  console.log(\`${NAME} channel listening on \${PORT}\`);
}
`;

const testTs = `import { describe, expect, it } from "bun:test";
import { ${CREATE_FN} } from "./channel.ts";
import { createFetch, signPayload } from "./server.ts";

describe("${NAME} adapter", () => {
  const adapter = ${CREATE_FN}();

  it("returns health status", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(new Request("http://test/health"));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { ok: boolean; service: string };
    expect(data.ok).toBe(true);
    expect(data.service).toBe("${SERVICE_NAME}");
  });

  it("returns 404 for unknown routes", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(new Request("http://test/unknown"));
    expect(resp.status).toBe(404);
  });

  it("returns 400 when text is missing", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(
      new Request("http://test/${NAME}/inbound", {
        method: "POST",
        body: JSON.stringify({ userId: "u1" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(resp.status).toBe(400);
  });

  it("normalizes payload and forwards with valid HMAC", async () => {
    let capturedUrl = "";
    let capturedSig = "";
    let capturedBody = "";

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedSig = String(
        (init?.headers as Record<string, string>)["x-channel-signature"],
      );
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const handler = createFetch(
      adapter,
      "http://gateway",
      "test-secret",
      mockFetch as typeof fetch,
    );

    const resp = await handler(
      new Request("http://test/${NAME}/inbound", {
        method: "POST",
        body: JSON.stringify({ userId: "u1", text: "hello" }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(resp.status).toBe(200);
    expect(capturedUrl).toBe("http://gateway/channel/inbound");

    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(parsed.channel).toBe("${NAME}");
    expect(parsed.text).toBe("hello");
    expect(parsed.userId).toBe("u1");
    expect(typeof parsed.nonce).toBe("string");
    expect(typeof parsed.timestamp).toBe("number");

    // Verify HMAC matches.
    expect(capturedSig).toBe(signPayload("test-secret", capturedBody));
  });
});
`;

const packageJson = `{
  "name": "@openpalm/channel-${NAME}",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "bun run server.ts",
    "test": "bun test"
  }
}
`;

const dockerfile = `FROM oven/bun:1.1.42
WORKDIR /app
COPY package.json ./
COPY server.ts ./server.ts
COPY channel.ts ./channel.ts
RUN bun install --production
CMD ["bun", "run", "server.ts"]
`;

const envFile = `# Channel-specific overrides managed by admin UI
${INBOUND_TOKEN_VAR}=
`;

// ── Write files ────────────────────────────────────────────────────────
mkdirSync(CHANNEL_DIR, { recursive: true });

const files: Array<[string, string]> = [
  ["channel.ts", channelTs],
  ["server.ts", serverTs],
  ["server.test.ts", testTs],
  ["package.json", packageJson],
  ["Dockerfile", dockerfile],
];

for (const [name, content] of files) {
  writeFileSync(join(CHANNEL_DIR, name), content, "utf8");
}

// Write the env template if the config/channels dir exists.
const channelEnvDir = join(ROOT, "assets", "config", "channels");
if (existsSync(channelEnvDir)) {
  writeFileSync(join(channelEnvDir, `${NAME}.env`), envFile, "utf8");
}

// ── Print next steps ───────────────────────────────────────────────────
console.log(`
✔ Channel scaffolded: channels/${NAME}/

  channels/${NAME}/
  ├── channel.ts        ← edit this — your adapter logic
  ├── server.ts         ← server harness (handles HMAC + gateway forwarding)
  ├── server.test.ts    ← starter tests
  ├── package.json
  └── Dockerfile

Next steps to wire it into OpenPalm:

1. Register the workspace in the root package.json:

   "workspaces": [
     ...,
     "channels/${NAME}"
   ]

2. Add the channel secret to your .env file:

   ${SECRET_VAR}=$(openssl rand -hex 32)

3. Register the secret in the gateway's environment
   (assets/state/docker-compose.yml → gateway → environment):

   - ${SECRET_VAR}=\${${SECRET_VAR}:-}

4. Add "${NAME}" to the gateway's ALLOWED_CHANNELS set
   (gateway/src/server.ts):

   const ALLOWED_CHANNELS = new Set([..., "${NAME}"]);

   And add it to CHANNEL_SHARED_SECRETS:

   ${NAME}: Bun.env.${SECRET_VAR} ?? "",

5. Add the service to docker-compose.yml:

   ${SERVICE_NAME}:
     image: \${OPENPALM_IMAGE_NAMESPACE:-openpalm}/${SERVICE_NAME}:\${OPENPALM_IMAGE_TAG:-latest}
     restart: unless-stopped
     profiles: ["channels"]
     env_file:
       - \${OPENPALM_CONFIG_HOME}/channels/${NAME}.env
     environment:
       - PORT=${DEFAULT_PORT}
       - GATEWAY_URL=http://gateway:8080
       - ${SECRET_VAR}=\${${SECRET_VAR}:-}
     networks: [assistant_net]
     depends_on: [gateway]

6. Add the build target to the dev docker-compose.yml overlay:

   ${SERVICE_NAME}:
     build: ./channels/${NAME}

7. Add a Caddy route (assets/config/caddy/Caddyfile):

   handle /channels/${NAME}/* {
     reverse_proxy ${SERVICE_NAME}:${DEFAULT_PORT}
   }

8. Run tests:

   bun test channels/${NAME}/

9. Build and run:

   bun run dev:build

Happy hacking!
`);
