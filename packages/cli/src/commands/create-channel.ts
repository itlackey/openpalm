import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

function usage(): never {
  throw new Error("Usage: openpalm dev create-channel <channel-name> [--port <number>]");
}

export function createChannel(args: string[]): void {
  const nameArg = args.find((arg) => !arg.startsWith("--"));
  if (!nameArg) usage();

  const name = nameArg.toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`Error: channel name must be lowercase alphanumeric with hyphens, got \"${name}\"`);
  }
  if (name.length > 32) throw new Error("Error: channel name must be 32 characters or fewer");

  const reserved = new Set(["chat", "discord", "voice", "telegram", "webhook"]);
  if (reserved.has(name)) {
    throw new Error(`Error: \"${name}\" is an existing built-in channel. Choose a different name.`);
  }

  const portIndex = args.indexOf("--port");
  const defaultPort = portIndex !== -1 && args[portIndex + 1] ? Number(args[portIndex + 1]) : 8190;
  if (Number.isNaN(defaultPort) || defaultPort < 1024 || defaultPort > 65535) {
    throw new Error("Error: --port must be a number between 1024 and 65535");
  }

  const root = process.cwd();
  const channelDir = join(root, "channels", name);
  if (existsSync(channelDir)) throw new Error(`Error: channels/${name}/ already exists.`);

  const envPrefix = name.replace(/-/g, "_").toUpperCase();
  const secretVar = `CHANNEL_${envPrefix}_SECRET`;
  const inboundTokenVar = `${envPrefix}_INBOUND_TOKEN`;
  const serviceName = `channel-${name}`;
  const camel = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const pascal = camel.charAt(0).toUpperCase() + camel.slice(1);
  const createFn = `create${pascal}Channel`;

  const channelTs = `import type { ChannelAdapter, InboundResult } from "@openpalm/lib/channel.ts";

const INBOUND_TOKEN = Bun.env.${inboundTokenVar} ?? "";

export function ${createFn}(): ChannelAdapter {
  return {
    name: "${name}",
    routes: [
      {
        method: "POST",
        path: "/${name}/inbound",
        handler: async (req: Request): Promise<InboundResult> => {
          if (INBOUND_TOKEN && req.headers.get("x-${name}-token") !== INBOUND_TOKEN) {
            return { ok: false, status: 401, body: { error: "unauthorized" } };
          }

          const body = (await req.json()) as {
            userId?: string;
            text?: string;
            metadata?: Record<string, unknown>;
          };

          if (!body.text) {
            return { ok: false, status: 400, body: { error: "text_required" } };
          }

          return {
            ok: true,
            payload: {
              userId: body.userId ?? "${name}-user",
              channel: "${name}",
              text: body.text,
              metadata: body.metadata ?? {},
            },
          };
        },
      },
    ],

    health: () => ({ ok: true, service: "${serviceName}" }),
  };
}
`;

  const serverTs = `import { createHmac } from "node:crypto";
import { ${createFn} } from "./channel.ts";
import type { ChannelAdapter } from "@openpalm/lib/channel.ts";

const PORT = Number(Bun.env.PORT ?? ${defaultPort});
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.${secretVar} ?? "";

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
  const routeMap = new Map(adapter.routes.map((route) => [route.method + " " + route.path, route.handler]));

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json(200, adapter.health());

    const handler = routeMap.get(req.method + " " + url.pathname);
    if (!handler) return json(404, { error: "not_found" });

    const result = await handler(req);
    if (!result.ok) return json(result.status, result.body);

    const gatewayPayload = {
      ...result.payload,
      nonce: crypto.randomUUID(),
      timestamp: Date.now(),
    };

    const serialized = JSON.stringify(gatewayPayload);
    const sig = signPayload(sharedSecret, serialized);

    const resp = await forwardFetch(gatewayUrl + "/channel/inbound", {
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
  const adapter = ${createFn}();
  Bun.serve({ port: PORT, fetch: createFetch(adapter, GATEWAY_URL, SHARED_SECRET) });
  console.log("${name} channel listening on " + PORT);
}
`;

  const testTs = `import { describe, expect, it } from "bun:test";
import { ${createFn} } from "./channel.ts";
import { createFetch, signPayload } from "./server.ts";

describe("${name} adapter", () => {
  const adapter = ${createFn}();

  it("returns health status", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(new Request("http://test/health"));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { ok: boolean; service: string };
    expect(data.ok).toBe(true);
    expect(data.service).toBe("${serviceName}");
  });

  it("returns 404 for unknown routes", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(new Request("http://test/unknown"));
    expect(resp.status).toBe(404);
  });

  it("returns 400 when text is missing", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(new Request("http://test/${name}/inbound", {
      method: "POST",
      body: JSON.stringify({ userId: "u1" }),
      headers: { "content-type": "application/json" },
    }));
    expect(resp.status).toBe(400);
  });

  it("normalizes payload and forwards with valid HMAC", async () => {
    let capturedUrl = "";
    let capturedSig = "";
    let capturedBody = "";

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedSig = String((init?.headers as Record<string, string>)["x-channel-signature"]);
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const handler = createFetch(adapter, "http://gateway", "test-secret", mockFetch as typeof fetch);

    const resp = await handler(new Request("http://test/${name}/inbound", {
      method: "POST",
      body: JSON.stringify({ userId: "u1", text: "hello" }),
      headers: { "content-type": "application/json" },
    }));

    expect(resp.status).toBe(200);
    expect(capturedUrl).toBe("http://gateway/channel/inbound");

    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(parsed.channel).toBe("${name}");
    expect(parsed.text).toBe("hello");
    expect(parsed.userId).toBe("u1");
    expect(typeof parsed.nonce).toBe("string");
    expect(typeof parsed.timestamp).toBe("number");
    expect(capturedSig).toBe(signPayload("test-secret", capturedBody));
  });
});
`;

  const packageJson = `{
  "name": "@openpalm/channel-${name}",
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

  const envFile = `# Channel-specific overrides managed by admin UI\n${inboundTokenVar}=\n`;

  mkdirSync(channelDir, { recursive: true });

  const files: Array<[string, string]> = [
    ["channel.ts", channelTs],
    ["server.ts", serverTs],
    ["server.test.ts", testTs],
    ["package.json", packageJson],
    ["Dockerfile", dockerfile],
  ];

  for (const [fileName, content] of files) {
    writeFileSync(join(channelDir, fileName), content, "utf8");
  }

  const channelEnvDir = join(root, "assets", "config", "channels");
  if (existsSync(channelEnvDir)) {
    writeFileSync(join(channelEnvDir, `${name}.env`), envFile, "utf8");
  }

  console.log(`✔ Channel scaffolded: channels/${name}/`);
}
