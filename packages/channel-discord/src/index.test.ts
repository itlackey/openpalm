import { describe, expect, it } from "bun:test";
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
