import { beforeEach, describe, expect, it, mock } from "bun:test";
import { signPayload } from "@openpalm/channels-sdk";
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
import type { PermissionConfig, UserInfo } from "./types.ts";

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
});

describe("routing", () => {
  it("unknown path → 404", async () => {
    const channel = new DiscordChannel();
    const handler = channel.createFetch();
    const resp = await handler(new Request("http://discord/nope"));
    expect(resp.status).toBe(404);
  });
});

describe("permissions", () => {
  it("parseIdList parses and trims IDs", () => {
    const result = parseIdList("id1, id2 , id3");
    expect(result.size).toBe(3);
    expect(result.has("id2")).toBe(true);
  });

  it("parseIdList returns empty set for undefined", () => {
    const result = parseIdList(undefined);
    expect(result.size).toBe(0);
  });

  it("blocks blocked users", () => {
    const config = emptyPermissions();
    config.blockedUsers.add("user-1");
    const result = checkPermissions(config, testUser({ userId: "user-1" }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("user_blocked");
  });

  it("allows all when no restrictions configured", () => {
    const config = emptyPermissions();
    const result = checkPermissions(config, testUser());
    expect(result.allowed).toBe(true);
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

  it("loadPermissionConfig reads from env", () => {
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
});

describe("commands", () => {
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

  it("parseCustomCommands rejects uppercase command names", () => {
    const json = JSON.stringify([{ name: "Summarize", description: "Invalid name" }]);
    const commands = parseCustomCommands(json);
    expect(commands.length).toBe(0);
  });

  it("parseCustomCommands rejects builtin name conflicts", () => {
    const json = JSON.stringify([{ name: "ask", description: "conflicts with builtin" }]);
    const commands = parseCustomCommands(json);
    expect(commands.length).toBe(0);
  });

  it("parseCustomCommands returns empty for invalid JSON", () => {
    const commands = parseCustomCommands("not-json");
    expect(commands.length).toBe(0);
  });

  it("parseCustomCommands returns empty for undefined", () => {
    const commands = parseCustomCommands(undefined);
    expect(commands.length).toBe(0);
  });

  it("buildCommandRegistry includes builtins", () => {
    const { all, registrationPayload } = buildCommandRegistry([]);
    expect(all.length).toBe(BUILTIN_COMMANDS.length);
    expect(registrationPayload.length).toBe(BUILTIN_COMMANDS.length);
    expect(all.some((cmd) => cmd.name === "queue")).toBe(true);
  });

  it("buildCommandRegistry includes custom commands", () => {
    const custom = [{ name: "custom", description: "A custom command" }];
    const { all } = buildCommandRegistry(custom);
    expect(all.length).toBe(BUILTIN_COMMANDS.length + 1);
  });

  it("resolvePromptTemplate replaces placeholders", () => {
    const result = resolvePromptTemplate("Hello {{name}}", { name: "Alice" });
    expect(result).toBe("Hello Alice");
  });

  it("resolvePromptTemplate replaces missing placeholders with empty string", () => {
    const result = resolvePromptTemplate("Hello {{name}}", {});
    expect(result).toBe("Hello ");
  });

  it("findCommand returns command by name", () => {
    const cmd = findCommand(BUILTIN_COMMANDS, "ask");
    expect(cmd?.name).toBe("ask");
  });

  it("findCommand returns undefined for unknown command", () => {
    const cmd = findCommand(BUILTIN_COMMANDS, "nonexistent");
    expect(cmd).toBeUndefined();
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

describe("splitMessage", () => {
  it("returns single chunk for short messages", () => {
    const chunks = splitMessage("hello", 2000);
    expect(chunks).toEqual(["hello"]);
  });

  it("splits long messages at newline boundaries", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${"x".repeat(50)}`);
    const text = lines.join("\n");
    const chunks = splitMessage(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(510); // small buffer for code block handling
    }
  });

  it("handles code blocks across splits", () => {
    const code = "```js\n" + "x".repeat(2500) + "\n```";
    const chunks = splitMessage(code, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should have balanced code blocks
    for (const chunk of chunks) {
      const count = (chunk.match(/```/g) || []).length;
      expect(count % 2).toBe(0);
    }
  });

  it("returns empty array for empty string", () => {
    const chunks = splitMessage("", 2000);
    expect(chunks).toEqual([""]);
  });
});
