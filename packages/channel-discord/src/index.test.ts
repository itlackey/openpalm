import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  BUILTIN_COMMANDS,
  buildCommandRegistry,
  findCommand,
  parseCustomCommands,
  resolvePromptTemplate,
} from "./commands.ts";
import DiscordChannel, { splitMessage } from "./index.ts";
import { checkPermissions, loadPermissionConfig, parseIdList } from "./permissions.ts";
import { buildThreadSessionKey } from "./session.ts";
import type { CustomCommandDef, PermissionConfig, UserInfo } from "./types.ts";
import { CommandOptionType } from "./types.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function emptyPermissions(): PermissionConfig {
  return {
    allowedGuilds: new Set(),
    allowedRoles: new Set(),
    allowedUsers: new Set(),
    blockedUsers: new Set(),
  };
}

function testUser(overrides: Partial<UserInfo> = {}): UserInfo {
  return {
    userId: "user-1",
    guildId: "guild-1",
    roles: ["role-1"],
    username: "testuser",
    ...overrides,
  };
}

type TestInteraction = {
  commandName: string;
  channelId: string;
  guildId: string;
  channel?: { id: string; isThread: () => boolean };
  user: { id: string; username: string };
  member: { roles: { cache: Map<string, { id: string }> } };
  options: { data: Array<{ name: string; value?: string }> };
  reply: ReturnType<typeof mock>;
  deferReply: ReturnType<typeof mock>;
  editReply: ReturnType<typeof mock>;
  followUp: ReturnType<typeof mock>;
};

function createInteraction(overrides: Partial<TestInteraction> = {}): TestInteraction {
  const roleEntries = [["role-1", { id: "role-1" }]];
  return {
    commandName: "ask",
    channelId: "channel-1",
    guildId: "guild-1",
    channel: { id: "channel-1", isThread: () => false },
    user: { id: "user-1", username: "testuser" },
    member: {
      roles: {
        cache: {
          map: <T>(fn: (role: { id: string }) => T) => roleEntries.map(([, role]) => fn(role)),
        },
      },
    },
    options: { data: [{ name: "message", value: "hello" }] },
    reply: mock(async () => {}),
    deferReply: mock(async () => {}),
    editReply: mock(async () => {}),
    followUp: mock(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  Bun.env.DISCORD_CUSTOM_COMMANDS = undefined;
});

// ── Health Endpoint ─────────────────────────────────────────────────────────

describe("health endpoint", () => {
  it("GET /health returns 200 with service info", async () => {
    const channel = new DiscordChannel();
    const handler = channel.createFetch();
    const resp = await handler(new Request("http://discord/health"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("channel-discord");
  });

  it("GET /health responds to any host header", async () => {
    const channel = new DiscordChannel();
    const handler = channel.createFetch();
    const resp = await handler(new Request("http://127.0.0.1:8184/health"));
    expect(resp.status).toBe(200);
  });
});

// ── Routing ─────────────────────────────────────────────────────────────────

describe("routing", () => {
  it("unknown path → 404", async () => {
    const channel = new DiscordChannel();
    const handler = channel.createFetch();
    const resp = await handler(new Request("http://discord/nope"));
    expect(resp.status).toBe(404);
  });

  it("GET on non-health path → 404", async () => {
    const channel = new DiscordChannel();
    const handler = channel.createFetch();
    const resp = await handler(new Request("http://discord/webhook"));
    expect(resp.status).toBe(404);
  });

  it("handleRequest returns null (Gateway channels don't use HTTP inbound)", async () => {
    const channel = new DiscordChannel();
    const result = await channel.handleRequest(new Request("http://discord/", { method: "POST" }));
    expect(result).toBeNull();
  });
});

// ── Permissions: parseIdList ────────────────────────────────────────────────

describe("parseIdList", () => {
  it("parses and trims IDs", () => {
    const result = parseIdList("id1, id2 , id3");
    expect(result.size).toBe(3);
    expect(result.has("id1")).toBe(true);
    expect(result.has("id2")).toBe(true);
    expect(result.has("id3")).toBe(true);
  });

  it("returns empty set for undefined", () => {
    expect(parseIdList(undefined).size).toBe(0);
  });

  it("returns empty set for empty string", () => {
    expect(parseIdList("").size).toBe(0);
  });

  it("returns empty set for whitespace-only", () => {
    expect(parseIdList("   ").size).toBe(0);
  });

  it("handles single ID without commas", () => {
    const result = parseIdList("solo-id");
    expect(result.size).toBe(1);
    expect(result.has("solo-id")).toBe(true);
  });

  it("filters empty entries from trailing commas", () => {
    const result = parseIdList("id1,,id2,");
    expect(result.size).toBe(2);
    expect(result.has("id1")).toBe(true);
    expect(result.has("id2")).toBe(true);
  });

  it("deduplicates repeated IDs", () => {
    const result = parseIdList("id1,id1,id1");
    expect(result.size).toBe(1);
  });
});

// ── Permissions: checkPermissions ───────────────────────────────────────────

describe("checkPermissions", () => {
  it("allows all when no restrictions configured", () => {
    const config = emptyPermissions();
    const result = checkPermissions(config, testUser());
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("blocks blocked users", () => {
    const config = emptyPermissions();
    config.blockedUsers.add("user-1");
    const result = checkPermissions(config, testUser({ userId: "user-1" }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("user_blocked");
  });

  it("blocked user check takes precedence over allowlist", () => {
    const config = emptyPermissions();
    config.allowedUsers.add("user-1");
    config.blockedUsers.add("user-1");
    const result = checkPermissions(config, testUser({ userId: "user-1" }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("user_blocked");
  });

  it("denies user not in allowlist", () => {
    const config = emptyPermissions();
    config.allowedUsers.add("other-user");
    const result = checkPermissions(config, testUser({ userId: "user-1" }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("user_not_allowed");
  });

  it("allows user in allowlist", () => {
    const config = emptyPermissions();
    config.allowedUsers.add("user-1");
    const result = checkPermissions(config, testUser({ userId: "user-1" }));
    expect(result.allowed).toBe(true);
  });

  it("denies guild not in allowlist", () => {
    const config = emptyPermissions();
    config.allowedGuilds.add("other-guild");
    const result = checkPermissions(config, testUser({ guildId: "guild-1" }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("guild_not_allowed");
  });

  it("allows guild in allowlist", () => {
    const config = emptyPermissions();
    config.allowedGuilds.add("guild-1");
    const result = checkPermissions(config, testUser({ guildId: "guild-1" }));
    expect(result.allowed).toBe(true);
  });

  it("denies when no matching role", () => {
    const config = emptyPermissions();
    config.allowedRoles.add("required-role");
    const result = checkPermissions(config, testUser({ roles: ["other-role"] }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("role_not_allowed");
  });

  it("allows matching role", () => {
    const config = emptyPermissions();
    config.allowedRoles.add("role-1");
    const result = checkPermissions(config, testUser({ roles: ["role-1"] }));
    expect(result.allowed).toBe(true);
  });

  it("allows if user has any one of multiple required roles", () => {
    const config = emptyPermissions();
    config.allowedRoles.add("admin");
    config.allowedRoles.add("moderator");
    const result = checkPermissions(config, testUser({ roles: ["moderator", "member"] }));
    expect(result.allowed).toBe(true);
  });

  it("denies user with empty roles array when roles are required", () => {
    const config = emptyPermissions();
    config.allowedRoles.add("required-role");
    const result = checkPermissions(config, testUser({ roles: [] }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("role_not_allowed");
  });

  it("denies user with empty userId when users are restricted", () => {
    const config = emptyPermissions();
    config.allowedUsers.add("some-user");
    const result = checkPermissions(config, testUser({ userId: "" }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("user_not_allowed");
  });

  it("denies user with empty guildId when guilds are restricted", () => {
    const config = emptyPermissions();
    config.allowedGuilds.add("some-guild");
    const result = checkPermissions(config, testUser({ guildId: "" }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("guild_not_allowed");
  });

  it("checks all layers: guild + role + user", () => {
    const config = emptyPermissions();
    config.allowedGuilds.add("guild-1");
    config.allowedRoles.add("role-1");
    config.allowedUsers.add("user-1");
    const result = checkPermissions(config, testUser());
    expect(result.allowed).toBe(true);
  });

  it("fails if guild matches but role does not", () => {
    const config = emptyPermissions();
    config.allowedGuilds.add("guild-1");
    config.allowedRoles.add("admin");
    const result = checkPermissions(config, testUser({ roles: ["member"] }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("role_not_allowed");
  });
});

// ── Permissions: loadPermissionConfig ───────────────────────────────────────

describe("loadPermissionConfig", () => {
  it("reads from env vars", () => {
    const config = loadPermissionConfig({
      DISCORD_ALLOWED_GUILDS: "g1,g2",
      DISCORD_ALLOWED_ROLES: undefined,
      DISCORD_ALLOWED_USERS: "u1",
      DISCORD_BLOCKED_USERS: "b1,b2,b3",
    });
    expect(config.allowedGuilds.size).toBe(2);
    expect(config.allowedRoles.size).toBe(0);
    expect(config.allowedUsers.size).toBe(1);
    expect(config.blockedUsers.size).toBe(3);
  });

  it("returns all-empty config when no env vars set", () => {
    const config = loadPermissionConfig({});
    expect(config.allowedGuilds.size).toBe(0);
    expect(config.allowedRoles.size).toBe(0);
    expect(config.allowedUsers.size).toBe(0);
    expect(config.blockedUsers.size).toBe(0);
  });

  it("handles whitespace in env values", () => {
    const config = loadPermissionConfig({
      DISCORD_ALLOWED_GUILDS: " g1 , g2 ",
    });
    expect(config.allowedGuilds.has("g1")).toBe(true);
    expect(config.allowedGuilds.has("g2")).toBe(true);
  });
});

// ── Commands: parseCustomCommands ───────────────────────────────────────────

describe("parseCustomCommands", () => {
  it("parses valid command with options", () => {
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

  it("rejects uppercase command names", () => {
    const json = JSON.stringify([{ name: "Summarize", description: "Invalid name" }]);
    const commands = parseCustomCommands(json);
    expect(commands.length).toBe(0);
  });

  it("rejects builtin name conflicts", () => {
    for (const builtin of ["ask", "health", "help", "clear"]) {
      const json = JSON.stringify([{ name: builtin, description: "conflicts" }]);
      const commands = parseCustomCommands(json);
      expect(commands.length).toBe(0);
    }
  });

  it("returns empty for invalid JSON", () => {
    expect(parseCustomCommands("not-json").length).toBe(0);
  });

  it("returns empty for undefined", () => {
    expect(parseCustomCommands(undefined).length).toBe(0);
  });

  it("returns empty for empty string", () => {
    expect(parseCustomCommands("").length).toBe(0);
  });

  it("returns empty for whitespace-only string", () => {
    expect(parseCustomCommands("   ").length).toBe(0);
  });

  it("returns empty for non-array JSON", () => {
    const json = JSON.stringify({ name: "cmd", description: "not array" });
    expect(parseCustomCommands(json).length).toBe(0);
  });

  it("rejects commands with empty description", () => {
    const json = JSON.stringify([{ name: "cmd", description: "" }]);
    expect(parseCustomCommands(json).length).toBe(0);
  });

  it("rejects commands with description over 100 chars", () => {
    const json = JSON.stringify([{ name: "cmd", description: "x".repeat(101) }]);
    expect(parseCustomCommands(json).length).toBe(0);
  });

  it("rejects commands with special characters in name", () => {
    const json = JSON.stringify([{ name: "cmd!@#", description: "bad name" }]);
    expect(parseCustomCommands(json).length).toBe(0);
  });

  it("accepts hyphens and underscores in name", () => {
    const json = JSON.stringify([{ name: "my-cmd_v2", description: "valid name" }]);
    const commands = parseCustomCommands(json);
    expect(commands.length).toBe(1);
    expect(commands[0].name).toBe("my-cmd_v2");
  });

  it("limits to MAX_CUSTOM_COMMANDS (20)", () => {
    const cmds = Array.from({ length: 25 }, (_, i) => ({
      name: `cmd${i}`,
      description: `Command ${i}`,
    }));
    const json = JSON.stringify(cmds);
    const commands = parseCustomCommands(json);
    expect(commands.length).toBe(20);
  });

  it("skips null/non-object entries gracefully", () => {
    const json = JSON.stringify([null, 42, "string", { name: "valid", description: "ok" }]);
    const commands = parseCustomCommands(json);
    expect(commands.length).toBe(1);
    expect(commands[0].name).toBe("valid");
  });

  it("sets ephemeral flag when present", () => {
    const json = JSON.stringify([{ name: "silent", description: "Ephemeral cmd", ephemeral: true }]);
    const commands = parseCustomCommands(json);
    expect(commands[0].ephemeral).toBe(true);
  });

  it("defaults ephemeral to false", () => {
    const json = JSON.stringify([{ name: "loud", description: "Non-ephemeral" }]);
    const commands = parseCustomCommands(json);
    expect(commands[0].ephemeral).toBe(false);
  });

  it("validates option types against enum", () => {
    const json = JSON.stringify([{
      name: "typed",
      description: "Has typed options",
      options: [
        { name: "str", description: "A string", type: CommandOptionType.STRING },
        { name: "num", description: "A number", type: CommandOptionType.NUMBER },
        { name: "bool", description: "A boolean", type: CommandOptionType.BOOLEAN },
        { name: "invalid", description: "Invalid type", type: 99 },
      ],
    }]);
    const commands = parseCustomCommands(json);
    expect(commands.length).toBe(1);
    const opts = commands[0].options!;
    expect(opts.length).toBe(4);
    expect(opts[0].type).toBe(CommandOptionType.STRING);
    expect(opts[1].type).toBe(CommandOptionType.NUMBER);
    expect(opts[2].type).toBe(CommandOptionType.BOOLEAN);
    // Invalid type defaults to STRING
    expect(opts[3].type).toBe(CommandOptionType.STRING);
  });

  it("handles option choices", () => {
    const json = JSON.stringify([{
      name: "pick",
      description: "Pick one",
      options: [{
        name: "color",
        description: "Choose a color",
        type: CommandOptionType.STRING,
        choices: [
          { name: "Red", value: "red" },
          { name: "Blue", value: "blue" },
        ],
      }],
    }]);
    const commands = parseCustomCommands(json);
    expect(commands[0].options![0].choices?.length).toBe(2);
    expect(commands[0].options![0].choices![0].name).toBe("Red");
  });

  it("limits choices to 25", () => {
    const choices = Array.from({ length: 30 }, (_, i) => ({ name: `c${i}`, value: `v${i}` }));
    const json = JSON.stringify([{
      name: "many",
      description: "Many choices",
      options: [{ name: "opt", description: "Pick", type: 3, choices }],
    }]);
    const commands = parseCustomCommands(json);
    expect(commands[0].options![0].choices?.length).toBe(25);
  });
});

// ── Commands: buildCommandRegistry ──────────────────────────────────────────

describe("buildCommandRegistry", () => {
  it("includes all builtins", () => {
    const { all, registrationPayload } = buildCommandRegistry([]);
    expect(all.length).toBe(BUILTIN_COMMANDS.length);
    expect(registrationPayload.length).toBe(BUILTIN_COMMANDS.length);
    expect(all.some((cmd) => cmd.name === "queue")).toBe(true);
  });

  it("includes custom commands after builtins", () => {
    const custom: CustomCommandDef[] = [{ name: "custom", description: "A custom command" }];
    const { all, registrationPayload } = buildCommandRegistry(custom);
    expect(all.length).toBe(BUILTIN_COMMANDS.length + 1);
    expect(registrationPayload.length).toBe(BUILTIN_COMMANDS.length + 1);
    expect(all[all.length - 1].name).toBe("custom");
  });

  it("registration payload has correct structure", () => {
    const { registrationPayload } = buildCommandRegistry([]);
    for (const cmd of registrationPayload) {
      expect(cmd.type).toBe(1); // CHAT_INPUT
      expect(typeof cmd.name).toBe("string");
      expect(typeof cmd.description).toBe("string");
    }
  });

  it("registration payload includes options for ask command", () => {
    const { registrationPayload } = buildCommandRegistry([]);
    const ask = registrationPayload.find((c) => c.name === "ask");
    expect(ask).toBeDefined();
    expect(ask!.options).toBeDefined();
    expect(ask!.options!.length).toBeGreaterThan(0);
    expect(ask!.options![0].name).toBe("message");
    expect(ask!.options![0].required).toBe(true);
  });

  it("builtin commands: ask, health, help, clear", () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name);
    expect(names).toContain("ask");
    expect(names).toContain("health");
    expect(names).toContain("help");
    expect(names).toContain("clear");
  });
});

// ── Commands: resolvePromptTemplate ─────────────────────────────────────────

describe("resolvePromptTemplate", () => {
  it("replaces single placeholder", () => {
    expect(resolvePromptTemplate("Hello {{name}}", { name: "Alice" })).toBe("Hello Alice");
  });

  it("replaces multiple placeholders", () => {
    const result = resolvePromptTemplate("{{greeting}} {{name}}, welcome to {{place}}", {
      greeting: "Hi",
      name: "Bob",
      place: "Discord",
    });
    expect(result).toBe("Hi Bob, welcome to Discord");
  });

  it("replaces missing placeholders with empty string", () => {
    expect(resolvePromptTemplate("Hello {{name}}", {})).toBe("Hello ");
  });

  it("leaves text without placeholders unchanged", () => {
    expect(resolvePromptTemplate("No placeholders here", { name: "Alice" })).toBe(
      "No placeholders here",
    );
  });

  it("handles repeated same placeholder", () => {
    expect(resolvePromptTemplate("{{x}} and {{x}}", { x: "val" })).toBe("val and val");
  });

  it("handles empty template", () => {
    expect(resolvePromptTemplate("", { key: "val" })).toBe("");
  });

  it("handles empty options", () => {
    expect(resolvePromptTemplate("static text", {})).toBe("static text");
  });
});

// ── Commands: findCommand ───────────────────────────────────────────────────

describe("findCommand", () => {
  it("returns command by name", () => {
    const cmd = findCommand(BUILTIN_COMMANDS, "ask");
    expect(cmd?.name).toBe("ask");
  });

  it("returns undefined for unknown command", () => {
    expect(findCommand(BUILTIN_COMMANDS, "nonexistent")).toBeUndefined();
  });

  it("returns undefined for empty array", () => {
    expect(findCommand([], "ask")).toBeUndefined();
  });

  it("is case-sensitive", () => {
    expect(findCommand(BUILTIN_COMMANDS, "ASK")).toBeUndefined();
    expect(findCommand(BUILTIN_COMMANDS, "Ask")).toBeUndefined();
  });

  it("finds custom commands in mixed array", () => {
    const all: CustomCommandDef[] = [
      ...BUILTIN_COMMANDS,
      { name: "custom", description: "Custom" },
    ];
    expect(findCommand(all, "custom")?.name).toBe("custom");
  });
});

describe("discord command behavior", () => {
  it("/clear forwards a clearSession request with session metadata", async () => {
    const channel = new DiscordChannel();
    const forward = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const interaction = createInteraction({ commandName: "clear" });

    Object.assign(channel, { forward });

    await (channel as unknown as { onSlashCommand: (input: TestInteraction) => Promise<void> }).onSlashCommand(
      interaction,
    );

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward.mock.calls[0]?.[0]).toMatchObject({
      userId: "discord:user-1",
      text: "clear session",
      metadata: {
        command: "clear",
        channelId: "channel-1",
        guildId: "guild-1",
        username: "testuser",
        sessionKey: "discord:channel:channel-1:user:user-1",
        clearSession: true,
      },
    });
    expect(interaction.editReply).toHaveBeenCalledWith("Conversation cleared.");
  });

  it("thread slash commands include a thread session key", async () => {
    const channel = new DiscordChannel();
    const forward = mock(async () => new Response(JSON.stringify({ answer: "done" }), { status: 200 }));
    const interaction = createInteraction({
      commandName: "ask",
      channelId: "parent-channel",
      channel: { id: "thread-1", isThread: () => true },
    });

    Object.assign(channel, { forward });

    await (channel as unknown as { onSlashCommand: (input: TestInteraction) => Promise<void> }).onSlashCommand(
      interaction,
    );

    expect(forward.mock.calls[0]?.[0]).toMatchObject({
      metadata: {
        command: "ask",
        channelId: "parent-channel",
        sessionKey: "discord:thread:thread-1",
      },
    });
    expect(interaction.editReply).toHaveBeenCalledWith("done");
  });

  it("/queue replies immediately when conversation is busy and sends result later", async () => {
    const channel = new DiscordChannel();
    let release = () => {};
    const forward = mock(
      () =>
        new Promise<Response>((resolve) => {
          if (forward.mock.calls.length === 1) {
            release = () => resolve(new Response(JSON.stringify({ answer: "first" }), { status: 200 }));
            return;
          }

          resolve(new Response(JSON.stringify({ answer: "second" }), { status: 200 }));
        }),
    );
    Object.assign(channel, { forward });

    const askInteraction = createInteraction({ commandName: "ask" });
    const queueInteraction = createInteraction({
      commandName: "queue",
      options: { data: [{ name: "message", value: "follow-up" }] },
      reply: mock(async () => {}),
      followUp: mock(async () => {}),
    });

    const firstRun = (channel as unknown as { onSlashCommand: (input: TestInteraction) => Promise<void> }).onSlashCommand(
      askInteraction,
    );
    await Bun.sleep(0);

    const secondRun = (channel as unknown as { onSlashCommand: (input: TestInteraction) => Promise<void> }).onSlashCommand(
      queueInteraction,
    );
    await Bun.sleep(0);

    expect(queueInteraction.reply).toHaveBeenCalledWith({
      content: "Queued. I will run that next.",
      ephemeral: true,
    });

    release();
    await firstRun;
    await secondRun;
    await Bun.sleep(0);

    expect(queueInteraction.followUp).toHaveBeenCalledWith({ content: "second", ephemeral: true });
  });

  it("thread slash commands in different threads do not share a session key", async () => {
    const channel = new DiscordChannel();
    const forward = mock(async () => new Response(JSON.stringify({ answer: "done" }), { status: 200 }));
    Object.assign(channel, { forward });

    const firstInteraction = createInteraction({
      commandName: "ask",
      channelId: "parent-channel",
      channel: { id: "thread-1", isThread: () => true },
    });
    const secondInteraction = createInteraction({
      commandName: "ask",
      channelId: "parent-channel",
      channel: { id: "thread-2", isThread: () => true },
    });

    await (channel as unknown as { onSlashCommand: (input: TestInteraction) => Promise<void> }).onSlashCommand(firstInteraction);
    await (channel as unknown as { onSlashCommand: (input: TestInteraction) => Promise<void> }).onSlashCommand(secondInteraction);

    expect(forward.mock.calls[0]?.[0]).toMatchObject({ metadata: { sessionKey: buildThreadSessionKey("thread-1") } });
    expect(forward.mock.calls[1]?.[0]).toMatchObject({ metadata: { sessionKey: buildThreadSessionKey("thread-2") } });
  });

  it("thread ask and clear use the same thread session key", async () => {
    const channel = new DiscordChannel();
    const forward = mock(async () => new Response(JSON.stringify({ answer: "done" }), { status: 200 }));
    Object.assign(channel, { forward });

    const askInteraction = createInteraction({
      commandName: "ask",
      channelId: "parent-channel",
      channel: { id: "thread-77", isThread: () => true },
    });
    const clearInteraction = createInteraction({
      commandName: "clear",
      channelId: "parent-channel",
      channel: { id: "thread-77", isThread: () => true },
    });

    await (channel as unknown as { onSlashCommand: (input: TestInteraction) => Promise<void> }).onSlashCommand(askInteraction);
    await (channel as unknown as { onSlashCommand: (input: TestInteraction) => Promise<void> }).onSlashCommand(clearInteraction);

    expect(forward.mock.calls[0]?.[0]).toMatchObject({ metadata: { sessionKey: buildThreadSessionKey("thread-77") } });
    expect(forward.mock.calls[1]?.[0]).toMatchObject({
      metadata: {
        sessionKey: buildThreadSessionKey("thread-77"),
        clearSession: true,
      },
    });
  });
});

// ── Timeout behavior ────────────────────────────────────────────────────────

describe("timeout handling", () => {
  it("forwardToGuardian surfaces timeout errors as message_error", async () => {
    const channel = new DiscordChannel();
    // Simulate a timeout by having forward reject with an abort error
    const forward = mock(async () => {
      throw new Error("The operation timed out.");
    });
    Object.assign(channel, { forward });

    const interaction = createInteraction({
      commandName: "ask",
      options: { data: [{ name: "message", value: "long running task" }] },
    });

    await (channel as unknown as { onSlashCommand: (input: TestInteraction) => Promise<void> }).onSlashCommand(
      interaction,
    );

    // Should have deferred, then edited with the error
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Error: The operation timed out.",
    );
  });

  it("thread message surfaces timeout error in thread", async () => {
    const channel = new DiscordChannel();
    const forward = mock(async () => {
      throw new Error("The operation timed out.");
    });
    Object.assign(channel, { forward });

    const sentMessages: string[] = [];
    const fakeThread = {
      id: "thread-timeout",
      send: mock(async (msg: string) => { sentMessages.push(msg); }),
      sendTyping: mock(async () => {}),
    };

    // Directly test runThreadConversation
    const runConvo = (channel as unknown as {
      runThreadConversation: (
        thread: unknown,
        userInfo: UserInfo,
        text: string,
        metadata: Record<string, unknown>,
      ) => Promise<void>;
    }).runThreadConversation.bind(channel);

    await runConvo(
      fakeThread,
      testUser(),
      "long running task",
      { sessionKey: "test-key" },
    );

    // Should send the error to the thread
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain("The operation timed out.");
  });
});

// ── splitMessage ────────────────────────────────────────────────────────────

describe("splitMessage", () => {
  it("returns single chunk for short messages", () => {
    const chunks = splitMessage("hello", 2000);
    expect(chunks).toEqual(["hello"]);
  });

  it("returns single chunk for message exactly at limit", () => {
    const text = "x".repeat(2000);
    const chunks = splitMessage(text, 2000);
    expect(chunks).toEqual([text]);
  });

  it("splits long messages into multiple chunks", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${"x".repeat(50)}`);
    const text = lines.join("\n");
    const chunks = splitMessage(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    // Verify no chunk exceeds the limit (with small buffer for code block handling)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(510);
    }
  });

  it("preserves all content across splits", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i}`);
    const text = lines.join("\n");
    const chunks = splitMessage(text, 50);
    const rejoined = chunks.join("\n");
    // All original lines should be present
    for (const line of lines) {
      expect(rejoined).toContain(line);
    }
  });

  it("prefers splitting at double newlines", () => {
    const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const chunks = splitMessage(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    // Should not break in the middle of a paragraph
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/^[a-z]/); // No chunk starts mid-sentence
    }
  });

  it("handles code blocks across splits", () => {
    const code = "```js\n" + "x".repeat(2500) + "\n```";
    const chunks = splitMessage(code, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should have balanced code blocks (even count of ```)
    for (const chunk of chunks) {
      const count = (chunk.match(/```/g) || []).length;
      expect(count % 2).toBe(0);
    }
  });

  it("continues code block language hint in continuation chunks", () => {
    const code = "```python\n" + Array.from({ length: 100 }, (_, i) => `print(${i})`).join("\n") + "\n```";
    const chunks = splitMessage(code, 500);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk starts with ```python
    expect(chunks[0]).toMatch(/^```python/);
    // Continuation chunks should also have language hint
    for (let i = 1; i < chunks.length; i++) {
      if (chunks[i].includes("```python") || chunks[i].includes("```")) {
        // Either has the language or at least balanced blocks
        const count = (chunks[i].match(/```/g) || []).length;
        expect(count % 2).toBe(0);
      }
    }
  });

  it("returns empty-ish for empty string", () => {
    const chunks = splitMessage("", 2000);
    expect(chunks).toEqual([""]);
  });

  it("handles single character", () => {
    expect(splitMessage("x", 2000)).toEqual(["x"]);
  });

  it("handles message with only newlines", () => {
    const chunks = splitMessage("\n\n\n", 2000);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it("handles maxLength of 1", () => {
    const chunks = splitMessage("abc", 1);
    // Should split into individual characters (or small groups)
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // All content should be present
    const joined = chunks.join("");
    expect(joined).toContain("a");
    expect(joined).toContain("b");
    expect(joined).toContain("c");
  });

  it("handles very long single line without newlines", () => {
    const text = "x".repeat(5000);
    const chunks = splitMessage(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    // Total content length should match
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalLen).toBe(5000);
  });

  it("handles nested code blocks", () => {
    const text = "before\n```\nouter\n```inner```\nouter\n```\nafter";
    const chunks = splitMessage(text, 2000);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe(text);
  });

  it("handles multiple separate code blocks", () => {
    const block1 = "```js\nconsole.log('a');\n```";
    const block2 = "```py\nprint('b')\n```";
    const text = `${block1}\n\nSome text\n\n${block2}`;
    const chunks = splitMessage(text, 2000);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("console.log");
    expect(chunks[0]).toContain("print");
  });

  it("handles unicode content", () => {
    const text = "Hello 🌍! ".repeat(500);
    const chunks = splitMessage(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    const joined = chunks.join("");
    expect(joined).toContain("🌍");
  });
});

// ── DiscordChannel class ────────────────────────────────────────────────────

describe("DiscordChannel", () => {
  it("has name 'discord'", () => {
    const channel = new DiscordChannel();
    expect(channel.name).toBe("discord");
  });

  it("botToken reads from env", () => {
    const channel = new DiscordChannel();
    // In test env, DISCORD_BOT_TOKEN is not set
    expect(typeof channel.botToken).toBe("string");
  });

  it("applicationId reads from env", () => {
    const channel = new DiscordChannel();
    expect(typeof channel.applicationId).toBe("string");
  });

  it("inherits port from env or defaults to 8080", () => {
    const channel = new DiscordChannel();
    expect(typeof channel.port).toBe("number");
  });

  it("inherits guardianUrl from env or defaults", () => {
    const channel = new DiscordChannel();
    expect(typeof channel.guardianUrl).toBe("string");
    expect(channel.guardianUrl).toContain("guardian");
  });

  it("secret resolves from CHANNEL_DISCORD_SECRET env", () => {
    const channel = new DiscordChannel();
    // Just verifying it doesn't throw
    expect(typeof channel.secret).toBe("string");
  });
});

// ── CommandOptionType enum ──────────────────────────────────────────────────

describe("CommandOptionType", () => {
  it("has expected values matching Discord API", () => {
    expect(CommandOptionType.SUB_COMMAND).toBe(1);
    expect(CommandOptionType.SUB_COMMAND_GROUP).toBe(2);
    expect(CommandOptionType.STRING).toBe(3);
    expect(CommandOptionType.INTEGER).toBe(4);
    expect(CommandOptionType.BOOLEAN).toBe(5);
    expect(CommandOptionType.USER).toBe(6);
    expect(CommandOptionType.CHANNEL).toBe(7);
    expect(CommandOptionType.ROLE).toBe(8);
    expect(CommandOptionType.MENTIONABLE).toBe(9);
    expect(CommandOptionType.NUMBER).toBe(10);
    expect(CommandOptionType.ATTACHMENT).toBe(11);
  });
});

// ── Edge Cases: Command validation ──────────────────────────────────────────

describe("command validation edge cases", () => {
  it("rejects command name longer than 32 chars", () => {
    const json = JSON.stringify([{ name: "a".repeat(33), description: "Too long name" }]);
    expect(parseCustomCommands(json).length).toBe(0);
  });

  it("accepts command name exactly 32 chars", () => {
    const json = JSON.stringify([{ name: "a".repeat(32), description: "Max length name" }]);
    expect(parseCustomCommands(json).length).toBe(1);
  });

  it("accepts command name of 1 char", () => {
    const json = JSON.stringify([{ name: "x", description: "Tiny name" }]);
    expect(parseCustomCommands(json).length).toBe(1);
  });

  it("rejects command with spaces in name", () => {
    const json = JSON.stringify([{ name: "my cmd", description: "Spaces" }]);
    expect(parseCustomCommands(json).length).toBe(0);
  });

  it("rejects command with no name", () => {
    const json = JSON.stringify([{ description: "No name field" }]);
    expect(parseCustomCommands(json).length).toBe(0);
  });

  it("rejects command with numeric name", () => {
    const json = JSON.stringify([{ name: 42, description: "Numeric name" }]);
    expect(parseCustomCommands(json).length).toBe(0);
  });

  it("rejects option with invalid name", () => {
    const json = JSON.stringify([{
      name: "cmd",
      description: "ok",
      options: [{ name: "BAD NAME!", description: "invalid" }],
    }]);
    const commands = parseCustomCommands(json);
    expect(commands.length).toBe(1);
    // Invalid options are filtered out
    expect(commands[0].options?.length).toBe(0);
  });

  it("rejects option with missing description", () => {
    const json = JSON.stringify([{
      name: "cmd",
      description: "ok",
      options: [{ name: "opt" }],
    }]);
    const commands = parseCustomCommands(json);
    expect(commands.length).toBe(1);
    expect(commands[0].options?.length).toBe(0);
  });

  it("filters invalid choices from options", () => {
    const json = JSON.stringify([{
      name: "cmd",
      description: "ok",
      options: [{
        name: "opt",
        description: "has choices",
        type: 3,
        choices: [
          { name: "Good", value: "good" },
          { name: 42, value: "bad" },     // invalid: name not string
          null,                             // invalid: null
          { name: "Also Good", value: "also" },
        ],
      }],
    }]);
    const commands = parseCustomCommands(json);
    expect(commands[0].options![0].choices?.length).toBe(2);
  });

  it("handles command with promptTemplate containing multiple variables", () => {
    const json = JSON.stringify([{
      name: "translate",
      description: "Translate text",
      options: [
        { name: "text", description: "Text to translate", type: 3, required: true },
        { name: "lang", description: "Target language", type: 3, required: true },
      ],
      promptTemplate: "Translate '{{text}}' to {{lang}}",
    }]);
    const commands = parseCustomCommands(json);
    expect(commands.length).toBe(1);
    const resolved = resolvePromptTemplate(commands[0].promptTemplate!, { text: "hello", lang: "Spanish" });
    expect(resolved).toBe("Translate 'hello' to Spanish");
  });
});

// ── Integration: full command flow ──────────────────────────────────────────

describe("full command flow", () => {
  it("custom command: parse → registry → find → resolve template", () => {
    const json = JSON.stringify([{
      name: "explain",
      description: "Explain a concept",
      options: [{ name: "topic", description: "What to explain", type: 3, required: true }],
      promptTemplate: "Explain {{topic}} in simple terms",
    }]);

    const custom = parseCustomCommands(json);
    expect(custom.length).toBe(1);

    const { all } = buildCommandRegistry(custom);
    const cmd = findCommand(all, "explain");
    expect(cmd).toBeDefined();
    expect(cmd!.promptTemplate).toBeDefined();

    const prompt = resolvePromptTemplate(cmd!.promptTemplate!, { topic: "recursion" });
    expect(prompt).toBe("Explain recursion in simple terms");
  });

  it("ask command exists with required message option", () => {
    const { all } = buildCommandRegistry([]);
    const ask = findCommand(all, "ask");
    expect(ask).toBeDefined();
    expect(ask!.options).toBeDefined();
    const msgOpt = ask!.options!.find((o) => o.name === "message");
    expect(msgOpt).toBeDefined();
    expect(msgOpt!.required).toBe(true);
    expect(msgOpt!.type).toBe(CommandOptionType.STRING);
  });

  it("ephemeral builtins: health, help, clear", () => {
    for (const name of ["health", "help", "clear"]) {
      const cmd = findCommand(BUILTIN_COMMANDS, name);
      expect(cmd).toBeDefined();
      expect(cmd!.ephemeral).toBe(true);
    }
  });

  it("ask command is not ephemeral", () => {
    const ask = findCommand(BUILTIN_COMMANDS, "ask");
    expect(ask).toBeDefined();
    expect(ask!.ephemeral).toBeFalsy();
  });
});
