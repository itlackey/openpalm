import { describe, expect, it } from "bun:test";
import { createDiscordFetch, verifyDiscordSignature, type DiscordServerConfig } from "./server.ts";
import { signPayload } from "@openpalm/lib/shared/crypto.ts";
import { parseIdList, loadPermissionConfig, checkPermissions, extractIdentifiers } from "./permissions.ts";
import { parseCustomCommands, buildCommandRegistry, resolvePromptTemplate, findCommand, BUILTIN_COMMANDS } from "./commands.ts";
import { InteractionType, InteractionResponseType, MessageFlags, type DiscordInteraction, type PermissionConfig } from "./types.ts";
import { handleInteraction, type InteractionDeps } from "./interactions.ts";

/* ── Test helpers ──────────────────────────────────────────────────── */

function emptyPermissions(): PermissionConfig {
  return {
    allowedGuilds: new Set(),
    allowedRoles: new Set(),
    allowedUsers: new Set(),
    blockedUsers: new Set(),
  };
}

function makeConfig(overrides?: Partial<DiscordServerConfig>): DiscordServerConfig {
  return {
    gatewayUrl: "http://gateway",
    sharedSecret: "secret",
    publicKey: "",
    applicationId: "app-123",
    commands: BUILTIN_COMMANDS,
    permissions: emptyPermissions(),
    ...overrides,
  };
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

function interactionRequest(body: unknown): Request {
  return new Request("http://discord/discord/interactions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function webhookRequest(body: unknown): Request {
  return new Request("http://discord/discord/webhook", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/* ── Server: Health ────────────────────────────────────────────────── */

describe("health endpoint", () => {
  it("GET /health returns 200 with service info", async () => {
    const handler = createDiscordFetch(makeConfig());
    const resp = await handler(new Request("http://discord/health"));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("channel-discord");
    expect(body.commands).toBeDefined();
    expect(body.permissions).toBeDefined();
  });
});

/* ── Server: Interactions ──────────────────────────────────────────── */

describe("interactions endpoint", () => {
  it("handles ping interactions (type 1)", async () => {
    const handler = createDiscordFetch(makeConfig());
    const resp = await handler(interactionRequest({ id: "1", type: 1 }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.type).toBe(InteractionResponseType.PONG);
  });

  it("returns 413 for oversized payloads", async () => {
    const handler = createDiscordFetch(makeConfig());
    const resp = await handler(new Request("http://discord/discord/interactions", {
      method: "POST",
      headers: { "content-length": "2000000" },
      body: "x",
    }));
    expect(resp.status).toBe(413);
  });

  it("returns 400 for invalid JSON", async () => {
    const handler = createDiscordFetch(makeConfig());
    const resp = await handler(new Request("http://discord/discord/interactions", {
      method: "POST",
      body: "not-json{{{",
    }));
    expect(resp.status).toBe(400);
  });

  it("handles /help command with ephemeral embed", async () => {
    const handler = createDiscordFetch(makeConfig());
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

  it("handles /clear command with ephemeral response", async () => {
    const handler = createDiscordFetch(makeConfig());
    const resp = await handler(interactionRequest({
      id: "1",
      type: InteractionType.APPLICATION_COMMAND,
      data: { name: "clear" },
      user: { id: "123", username: "testuser" },
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { type: number; data: { flags: number } };
    expect(body.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(body.data.flags).toBe(MessageFlags.EPHEMERAL);
  });

  it("handles /ask command with deferred response", async () => {
    const cap = capturingFetch();
    const handler = createDiscordFetch(makeConfig({ forwardFetch: cap.mockFetch }));
    const resp = await handler(interactionRequest({
      id: "1",
      type: InteractionType.APPLICATION_COMMAND,
      application_id: "app-123",
      token: "interaction-token",
      data: { name: "ask", options: [{ name: "message", type: 3, value: "hello assistant" }] },
      user: { id: "123", username: "testuser" },
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { type: number };
    expect(body.type).toBe(InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);
  });

  it("denies interaction from blocked user", async () => {
    const permissions = emptyPermissions();
    permissions.blockedUsers.add("blocked-user");
    const handler = createDiscordFetch(makeConfig({ permissions }));

    const resp = await handler(interactionRequest({
      id: "1",
      type: InteractionType.APPLICATION_COMMAND,
      data: { name: "help" },
      user: { id: "blocked-user", username: "badactor" },
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { type: number; data: { flags: number; embeds: Array<{ title: string }> } };
    expect(body.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(body.data.flags).toBe(MessageFlags.EPHEMERAL);
    expect(body.data.embeds[0].title).toBe("Error");
  });

  it("denies interaction from unauthorized guild", async () => {
    const permissions = emptyPermissions();
    permissions.allowedGuilds.add("guild-1");
    const handler = createDiscordFetch(makeConfig({ permissions }));

    const resp = await handler(interactionRequest({
      id: "1",
      type: InteractionType.APPLICATION_COMMAND,
      data: { name: "help" },
      user: { id: "123", username: "testuser" },
      guild_id: "unauthorized-guild",
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { type: number; data: { flags: number; embeds: Array<{ title: string }> } };
    expect(body.data.embeds[0].title).toBe("Error");
  });

  it("allows interaction from authorized guild", async () => {
    const permissions = emptyPermissions();
    permissions.allowedGuilds.add("guild-1");
    const handler = createDiscordFetch(makeConfig({ permissions }));

    const resp = await handler(interactionRequest({
      id: "1",
      type: InteractionType.APPLICATION_COMMAND,
      data: { name: "help" },
      user: { id: "123", username: "testuser" },
      guild_id: "guild-1",
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { type: number; data: { flags: number; embeds: Array<{ title: string }> } };
    expect(body.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    // help command returns embeds, not an error
    expect(body.data.embeds.length).toBeGreaterThan(0);
  });

  it("denies interaction when user lacks required role", async () => {
    const permissions = emptyPermissions();
    permissions.allowedRoles.add("admin-role");
    const handler = createDiscordFetch(makeConfig({ permissions }));

    const resp = await handler(interactionRequest({
      id: "1",
      type: InteractionType.APPLICATION_COMMAND,
      data: { name: "help" },
      member: { user: { id: "123", username: "testuser" }, roles: ["member-role"] },
      guild_id: "guild-1",
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { type: number; data: { embeds: Array<{ title: string }> } };
    expect(body.data.embeds[0].title).toBe("Error");
  });

  it("allows interaction when user has required role", async () => {
    const permissions = emptyPermissions();
    permissions.allowedRoles.add("admin-role");
    const handler = createDiscordFetch(makeConfig({ permissions }));

    const resp = await handler(interactionRequest({
      id: "1",
      type: InteractionType.APPLICATION_COMMAND,
      data: { name: "help" },
      member: { user: { id: "123", username: "testuser" }, roles: ["admin-role", "other-role"] },
      guild_id: "guild-1",
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { type: number; data: { embeds: Array<{ title: string }> } };
    // Should not be an error
    expect(body.data.embeds[0].title).not.toBe("Error");
  });
});

/* ── Server: Webhook ───────────────────────────────────────────────── */

describe("webhook endpoint", () => {
  it("/discord/webhook forwards message with discord: userId prefix", async () => {
    const cap = capturingFetch();
    const handler = createDiscordFetch(makeConfig({ forwardFetch: cap.mockFetch }));
    const resp = await handler(webhookRequest({ userId: "456", text: "webhook msg", channelId: "c2" }));
    expect(resp.status).toBe(200);
    const forwarded = JSON.parse(cap.body) as Record<string, unknown>;
    expect(forwarded.userId).toBe("discord:456");
    expect(forwarded.channel).toBe("discord");
    expect(forwarded.text).toBe("webhook msg");
  });

  it("/discord/webhook returns 400 when text missing", async () => {
    const cap = capturingFetch();
    const handler = createDiscordFetch(makeConfig({ forwardFetch: cap.mockFetch }));
    const resp = await handler(webhookRequest({ userId: "456" }));
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe("text_required");
  });

  it("/discord/webhook returns 400 when userId missing", async () => {
    const cap = capturingFetch();
    const handler = createDiscordFetch(makeConfig({ forwardFetch: cap.mockFetch }));
    const resp = await handler(webhookRequest({ text: "hello" }));
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe("missing_user_id");
  });

  it("HMAC: x-channel-signature matches signPayload", async () => {
    const sharedSecret = "hmac-test-secret";
    const cap = capturingFetch();
    const handler = createDiscordFetch(makeConfig({ sharedSecret, forwardFetch: cap.mockFetch }));
    await handler(webhookRequest({ userId: "789", text: "verify hmac" }));
    const expected = signPayload(sharedSecret, cap.body);
    expect(cap.headers["x-channel-signature"]).toBe(expected);
  });
});

/* ── Server: 404 ───────────────────────────────────────────────────── */

describe("routing", () => {
  it("unknown path → 404", async () => {
    const handler = createDiscordFetch(makeConfig());
    const resp = await handler(new Request("http://discord/nope"));
    expect(resp.status).toBe(404);
  });

  it("GET /discord/interactions → 404", async () => {
    const handler = createDiscordFetch(makeConfig());
    const resp = await handler(new Request("http://discord/discord/interactions", { method: "GET" }));
    expect(resp.status).toBe(404);
  });
});

/* ── Permissions ───────────────────────────────────────────────────── */

describe("permissions", () => {
  describe("parseIdList", () => {
    it("returns empty set for undefined", () => {
      expect(parseIdList(undefined).size).toBe(0);
    });

    it("returns empty set for empty string", () => {
      expect(parseIdList("").size).toBe(0);
    });

    it("parses comma-separated IDs", () => {
      const result = parseIdList("id1, id2 , id3");
      expect(result.size).toBe(3);
      expect(result.has("id1")).toBe(true);
      expect(result.has("id2")).toBe(true);
      expect(result.has("id3")).toBe(true);
    });

    it("ignores empty segments", () => {
      const result = parseIdList("id1,,id2,");
      expect(result.size).toBe(2);
    });
  });

  describe("extractIdentifiers", () => {
    it("extracts from guild interaction (member.user)", () => {
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
      expect(ids.username).toBe("bob");
    });

    it("extracts from DM interaction (user)", () => {
      const interaction: DiscordInteraction = {
        id: "1",
        type: 2,
        user: { id: "u2", username: "alice" },
      };
      const ids = extractIdentifiers(interaction);
      expect(ids.userId).toBe("u2");
      expect(ids.guildId).toBe("");
      expect(ids.roles).toEqual([]);
    });
  });

  describe("checkPermissions", () => {
    const baseInteraction: DiscordInteraction = {
      id: "1",
      type: 2,
      guild_id: "guild-1",
      member: { user: { id: "user-1", username: "test" }, roles: ["role-1"] },
    };

    it("allows when no restrictions", () => {
      const result = checkPermissions(emptyPermissions(), baseInteraction);
      expect(result.allowed).toBe(true);
    });

    it("blocks user in blocklist", () => {
      const config = emptyPermissions();
      config.blockedUsers.add("user-1");
      const result = checkPermissions(config, baseInteraction);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("user_blocked");
    });

    it("blocks user not in allowlist", () => {
      const config = emptyPermissions();
      config.allowedUsers.add("other-user");
      const result = checkPermissions(config, baseInteraction);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("user_not_allowed");
    });

    it("allows user in allowlist", () => {
      const config = emptyPermissions();
      config.allowedUsers.add("user-1");
      const result = checkPermissions(config, baseInteraction);
      expect(result.allowed).toBe(true);
    });

    it("blocks guild not in allowlist", () => {
      const config = emptyPermissions();
      config.allowedGuilds.add("other-guild");
      const result = checkPermissions(config, baseInteraction);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("guild_not_allowed");
    });

    it("blocks user without required role", () => {
      const config = emptyPermissions();
      config.allowedRoles.add("admin-role");
      const result = checkPermissions(config, baseInteraction);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("role_not_allowed");
    });

    it("allows user with matching role", () => {
      const config = emptyPermissions();
      config.allowedRoles.add("role-1");
      const result = checkPermissions(config, baseInteraction);
      expect(result.allowed).toBe(true);
    });

    it("blocklist takes priority over allowlist", () => {
      const config = emptyPermissions();
      config.allowedUsers.add("user-1");
      config.blockedUsers.add("user-1");
      const result = checkPermissions(config, baseInteraction);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("user_blocked");
    });
  });
});

/* ── Commands ──────────────────────────────────────────────────────── */

describe("commands", () => {
  describe("parseCustomCommands", () => {
    const emptyCases: [string, string | undefined][] = [
      ["undefined", undefined],
      ["empty string", ""],
      ["invalid JSON", "{invalid"],
      ["non-array JSON", '{"name":"test"}'],
    ];

    for (const [label, input] of emptyCases) {
      it(`returns empty array for ${label}`, () => {
        expect(parseCustomCommands(input)).toEqual([]);
      });
    }

    it("parses valid custom commands", () => {
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
      expect(commands[0].options?.length).toBe(1);
      expect(commands[0].promptTemplate).toBe("Please summarize: {{topic}}");
    });

    it("rejects commands with names conflicting with builtins", () => {
      const json = JSON.stringify([{ name: "ask", description: "Custom ask" }]);
      const commands = parseCustomCommands(json);
      expect(commands.length).toBe(0);
    });

    it("rejects commands with invalid names", () => {
      const json = JSON.stringify([{ name: "invalid name!", description: "Test" }]);
      const commands = parseCustomCommands(json);
      expect(commands.length).toBe(0);
    });
  });

  describe("buildCommandRegistry", () => {
    it("includes all builtin commands", () => {
      const { all, registrationPayload } = buildCommandRegistry([]);
      expect(all.length).toBe(BUILTIN_COMMANDS.length);
      expect(registrationPayload.length).toBe(BUILTIN_COMMANDS.length);
    });

    it("includes custom commands after builtins", () => {
      const custom = [{ name: "custom1", description: "A custom command" }];
      const { all, registrationPayload } = buildCommandRegistry(custom);
      expect(all.length).toBe(BUILTIN_COMMANDS.length + 1);
      expect(registrationPayload.length).toBe(BUILTIN_COMMANDS.length + 1);
      expect(all[all.length - 1].name).toBe("custom1");
    });

    it("generates correct registration payload", () => {
      const { registrationPayload } = buildCommandRegistry([]);
      const askCmd = registrationPayload.find((c) => c.name === "ask");
      expect(askCmd).toBeDefined();
      expect(askCmd!.type).toBe(1); // CHAT_INPUT
      expect(askCmd!.options?.length).toBe(1);
      expect(askCmd!.options![0].name).toBe("message");
    });
  });

  describe("resolvePromptTemplate", () => {
    it("replaces placeholders with option values", () => {
      const result = resolvePromptTemplate("Hello {{name}}, your topic is {{topic}}", {
        name: "Alice",
        topic: "TypeScript",
      });
      expect(result).toBe("Hello Alice, your topic is TypeScript");
    });

    it("replaces missing placeholders with empty string", () => {
      const result = resolvePromptTemplate("Hello {{name}}", {});
      expect(result).toBe("Hello ");
    });
  });

  describe("findCommand", () => {
    it("finds a command by name", () => {
      const cmd = findCommand(BUILTIN_COMMANDS, "ask");
      expect(cmd).toBeDefined();
      expect(cmd!.name).toBe("ask");
    });

    it("returns undefined for unknown command", () => {
      const cmd = findCommand(BUILTIN_COMMANDS, "nonexistent");
      expect(cmd).toBeUndefined();
    });
  });
});

/* ── Interaction handler ───────────────────────────────────────────── */

describe("handleInteraction", () => {
  const cap = capturingFetch();

  function makeDeps(overrides?: Partial<InteractionDeps>): InteractionDeps {
    return {
      gatewayUrl: "http://gateway",
      sharedSecret: "secret",
      applicationId: "app-123",
      commands: BUILTIN_COMMANDS,
      permissions: emptyPermissions(),
      forwardFetch: cap.mockFetch,
      ...overrides,
    };
  }

  it("responds with PONG for PING", async () => {
    const result = await handleInteraction(
      { id: "1", type: InteractionType.PING },
      makeDeps(),
    );
    expect(result.type).toBe(InteractionResponseType.PONG);
  });

  it("handles unknown interaction types gracefully", async () => {
    const result = await handleInteraction(
      { id: "1", type: 99 },
      makeDeps(),
    );
    expect(result.type).toBe(InteractionResponseType.PONG);
  });

  it("handles MESSAGE_COMPONENT with unknown custom_id", async () => {
    const result = await handleInteraction(
      {
        id: "1",
        type: InteractionType.MESSAGE_COMPONENT,
        data: { custom_id: "unknown_button" },
        user: { id: "123", username: "test" },
      },
      makeDeps(),
    );
    expect(result.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(result.data?.flags).toBe(MessageFlags.EPHEMERAL);
  });

  it("handles AUTOCOMPLETE with empty choices", async () => {
    const result = await handleInteraction(
      {
        id: "1",
        type: InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE,
        data: { name: "ask", options: [{ name: "message", type: 3, value: "he", focused: true }] },
        user: { id: "123", username: "test" },
      },
      makeDeps(),
    );
    expect(result.type).toBe(InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT);
  });
});

/* ── Signature verification ────────────────────────────────────────── */

describe("verifyDiscordSignature", () => {
  it("returns false for empty public key", async () => {
    expect(await verifyDiscordSignature("", "sig", "ts", "body")).toBe(false);
  });

  it("returns false for empty signature", async () => {
    expect(await verifyDiscordSignature("abc", "", "ts", "body")).toBe(false);
  });

  it("returns false for empty timestamp", async () => {
    expect(await verifyDiscordSignature("abc", "sig", "", "body")).toBe(false);
  });

  it("returns false for invalid signature", async () => {
    // Valid-looking hex but wrong key/sig
    const result = await verifyDiscordSignature(
      "a".repeat(64),
      "b".repeat(128),
      "1234567890",
      "test body",
    );
    expect(result).toBe(false);
  });
});
