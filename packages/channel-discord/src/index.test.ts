import { describe, expect, it } from "bun:test";
import { signPayload } from "@openpalm/channels-sdk";
import {
  BUILTIN_COMMANDS,
  buildCommandRegistry,
  findCommand,
  parseCustomCommands,
  resolvePromptTemplate,
} from "./commands.ts";
import DiscordChannel, { verifyDiscordSignature } from "./index.ts";
import { checkPermissions, extractIdentifiers, parseIdList } from "./permissions.ts";
import { InteractionType, InteractionResponseType, MessageFlags, type DiscordInteraction, type PermissionConfig } from "./types.ts";

function webhookRequest(body: unknown): Request {
  return new Request("http://discord/discord/webhook", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function interactionRequest(body: unknown): Request {
  return new Request("http://discord/discord/interactions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function capturingFetch() {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  let capturedBody = "";
  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
    capturedBody = String(init?.body);
    return new Response(JSON.stringify({ answer: "ok" }), { status: 200 });
  };
  return {
    mockFetch: mockFetch as typeof fetch,
    get url() { return capturedUrl; },
    get headers() { return capturedHeaders; },
    get body() { return capturedBody; },
  };
}

function emptyPermissions(): PermissionConfig {
  return {
    allowedGuilds: new Set(),
    allowedRoles: new Set(),
    allowedUsers: new Set(),
    blockedUsers: new Set(),
  };
}

describe("health endpoint", () => {
  it("GET /health returns 200 with service info", async () => {
    const channel = new DiscordChannel();
    const handler = channel.createFetch();
    const resp = await handler(new Request("http://discord/health"));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("channel-discord");
  });
});

describe("interactions endpoint", () => {
  it("handles ping interactions (type 1)", async () => {
    const channel = new DiscordChannel();
    const handler = channel.createFetch();
    const resp = await handler(interactionRequest({ id: "1", type: 1 }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.type).toBe(InteractionResponseType.PONG);
  });

  it("returns 401 for invalid signature when public key configured", async () => {
    const channel = new DiscordChannel();
    Object.defineProperty(channel, "publicKey", { get: () => "a".repeat(64) });
    const handler = channel.createFetch();
    const resp = await handler(new Request("http://discord/discord/interactions", {
      method: "POST",
      headers: {
        "x-signature-ed25519": "b".repeat(128),
        "x-signature-timestamp": "1234567890",
      },
      body: JSON.stringify({ id: "1", type: 1 }),
    }));
    expect(resp.status).toBe(401);
  });

  it("handles /help command with ephemeral embed", async () => {
    const channel = new DiscordChannel();
    const handler = channel.createFetch();
    const resp = await handler(interactionRequest({
      id: "1",
      type: InteractionType.APPLICATION_COMMAND,
      data: { name: "help" },
      user: { id: "123", username: "testuser" },
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { type: number; data: { flags: number; embeds: unknown[] } };
    expect(body.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(body.data.flags).toBe(MessageFlags.EPHEMERAL);
    expect(body.data.embeds).toBeDefined();
  });

  it("denies interaction from blocked user", async () => {
    const channel = new DiscordChannel();
    Object.defineProperty(channel, "permissions", {
      value: {
        allowedGuilds: new Set(),
        allowedRoles: new Set(),
        allowedUsers: new Set(),
        blockedUsers: new Set(["blocked-user"]),
      },
    });

    const handler = channel.createFetch();
    const resp = await handler(interactionRequest({
      id: "1",
      type: InteractionType.APPLICATION_COMMAND,
      data: { name: "help" },
      user: { id: "blocked-user", username: "badactor" },
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { data: { embeds: Array<{ title: string }> } };
    expect(body.data.embeds[0].title).toBe("Error");
  });
});

describe("webhook endpoint", () => {
  it("forwards message with discord: userId prefix", async () => {
    const cap = capturingFetch();
    const channel = new DiscordChannel();
    const handler = channel.createFetch(cap.mockFetch);
    const resp = await handler(webhookRequest({ userId: "456", text: "webhook msg", channelId: "c2" }));
    expect(resp.status).toBe(200);
    const forwarded = JSON.parse(cap.body) as Record<string, unknown>;
    expect(forwarded.userId).toBe("discord:456");
    expect(forwarded.channel).toBe("discord");
    expect(forwarded.text).toBe("webhook msg");
  });

  it("returns 400 when text missing", async () => {
    const cap = capturingFetch();
    const channel = new DiscordChannel();
    const handler = channel.createFetch(cap.mockFetch);
    const resp = await handler(webhookRequest({ userId: "456" }));
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe("text_required");
  });

  it("returns 400 when userId missing", async () => {
    const cap = capturingFetch();
    const channel = new DiscordChannel();
    const handler = channel.createFetch(cap.mockFetch);
    const resp = await handler(webhookRequest({ text: "hello" }));
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe("missing_user_id");
  });

  it("returns 400 for invalid JSON", async () => {
    const channel = new DiscordChannel();
    const handler = channel.createFetch();
    const resp = await handler(new Request("http://discord/discord/webhook", {
      method: "POST",
      body: "not-json{{{",
    }));
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_request");
  });

  it("HMAC: x-channel-signature matches signPayload", async () => {
    const sharedSecret = "hmac-test-secret";
    const cap = capturingFetch();
    const channel = new DiscordChannel();
    Object.defineProperty(channel, "secret", { get: () => sharedSecret });
    const handler = channel.createFetch(cap.mockFetch);
    await handler(webhookRequest({ userId: "789", text: "verify hmac" }));
    const expected = signPayload(sharedSecret, cap.body);
    expect(cap.headers["x-channel-signature"]).toBe(expected);
  });

  it("forwards to guardian /channel/inbound", async () => {
    const cap = capturingFetch();
    const channel = new DiscordChannel();
    const handler = channel.createFetch(cap.mockFetch);
    await handler(webhookRequest({ userId: "1", text: "hello" }));
    expect(cap.url).toBe("http://guardian:8080/channel/inbound");
  });
});

describe("routing", () => {
  it("unknown path → 404", async () => {
    const channel = new DiscordChannel();
    const handler = channel.createFetch();
    const resp = await handler(new Request("http://discord/nope"));
    expect(resp.status).toBe(404);
  });

  it("GET /discord/webhook → 404", async () => {
    const channel = new DiscordChannel();
    const handler = channel.createFetch();
    const resp = await handler(new Request("http://discord/discord/webhook", { method: "GET" }));
    expect(resp.status).toBe(404);
  });
});

describe("permissions and commands helpers", () => {
  it("parseIdList parses and trims IDs", () => {
    const result = parseIdList("id1, id2 , id3");
    expect(result.size).toBe(3);
    expect(result.has("id2")).toBe(true);
  });

  it("extractIdentifiers extracts ids from guild interaction", () => {
    const interaction: DiscordInteraction = {
      id: "1",
      type: 2,
      guild_id: "g1",
      member: { user: { id: "u1", username: "bob" }, roles: ["r1", "r2"] },
    };
    const ids = extractIdentifiers(interaction);
    expect(ids.userId).toBe("u1");
    expect(ids.guildId).toBe("g1");
    expect(ids.roles).toEqual(["r1", "r2"]);
  });

  it("checkPermissions blocks blocked users", () => {
    const config = emptyPermissions();
    config.blockedUsers.add("user-1");
    const result = checkPermissions(config, {
      id: "1",
      type: 2,
      user: { id: "user-1", username: "test" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("user_blocked");
  });

  it("parseCustomCommands parses valid command", () => {
    const json = JSON.stringify([
      {
        name: "summarize",
        description: "Summarize a topic",
        options: [{ name: "topic", description: "The topic", type: 3, required: true }],
        promptTemplate: "Please summarize: {{topic}}",
      },
    ]);
    const commands = parseCustomCommands(json);
    expect(commands.length).toBe(1);
    expect(commands[0].name).toBe("summarize");
  });

  it("buildCommandRegistry includes builtins", () => {
    const { all, registrationPayload } = buildCommandRegistry([]);
    expect(all.length).toBe(BUILTIN_COMMANDS.length);
    expect(registrationPayload.length).toBe(BUILTIN_COMMANDS.length);
  });

  it("resolvePromptTemplate replaces placeholders", () => {
    const result = resolvePromptTemplate("Hello {{name}}", { name: "Alice" });
    expect(result).toBe("Hello Alice");
  });

  it("findCommand returns command by name", () => {
    const cmd = findCommand(BUILTIN_COMMANDS, "ask");
    expect(cmd?.name).toBe("ask");
  });
});

describe("verifyDiscordSignature", () => {
  it("returns false when required inputs are missing", async () => {
    expect(await verifyDiscordSignature("", "sig", "ts", "body")).toBe(false);
    expect(await verifyDiscordSignature("abc", "", "ts", "body")).toBe(false);
    expect(await verifyDiscordSignature("abc", "sig", "", "body")).toBe(false);
  });

  it("returns false for invalid signature data", async () => {
    const result = await verifyDiscordSignature(
      "a".repeat(64),
      "b".repeat(128),
      "1234567890",
      "test body",
    );
    expect(result).toBe(false);
  });
});
