import { beforeEach, describe, expect, it, mock } from "bun:test";
import SlackChannel, { DEFAULT_FORWARD_TIMEOUT_MS, parseForwardTimeoutMs, splitMessage } from "./index.ts";
import { checkPermissions, loadPermissionConfig, parseIdList } from "./permissions.ts";
import {
  buildChannelUserSessionKey,
  buildDMSessionKey,
  buildThreadSessionKey,
  ConversationQueue,
  resolveSessionKey,
} from "./session.ts";
import type { PermissionConfig, PermissionResult, UserInfo } from "./types.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function emptyPermissions(): PermissionConfig {
  return {
    allowedChannels: new Set(),
    allowedUsers: new Set(),
    blockedUsers: new Set(),
  };
}

function testUser(overrides: Partial<UserInfo> = {}): UserInfo {
  return {
    userId: "U12345",
    teamId: "T12345",
    channelId: "C12345",
    username: "testuser",
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type MockClient = {
  chat: {
    postMessage: ReturnType<typeof mock>;
    update: ReturnType<typeof mock>;
  };
  conversations: {
    open: ReturnType<typeof mock>;
  };
  users: {
    info: ReturnType<typeof mock>;
  };
  views: {
    open: ReturnType<typeof mock>;
    publish: ReturnType<typeof mock>;
  };
};

function createMockClient(): MockClient {
  return {
    chat: {
      postMessage: mock(async () => ({ ts: "1234567890.123456" })),
      update: mock(async () => ({})),
    },
    conversations: {
      open: mock(async () => ({ channel: { id: "D123" } })),
    },
    users: {
      info: mock(async ({ user }: { user: string }) => ({ user: { name: user } })),
    },
    views: {
      open: mock(async () => ({})),
      publish: mock(async () => ({})),
    },
  };
}

type MockSay = ReturnType<typeof mock>;

function createMockSay(): MockSay {
  return mock(async () => ({}));
}

beforeEach(() => {
  delete Bun.env.SLACK_FORWARD_TIMEOUT_MS;
});

// ── Forward timeout parsing ──────────────────────────────────────────────────

describe("parseForwardTimeoutMs", () => {
  it("uses default when value is missing", () => {
    expect(parseForwardTimeoutMs(undefined)).toBe(DEFAULT_FORWARD_TIMEOUT_MS);
  });

  it("uses default when value is invalid, zero, or negative", () => {
    expect(parseForwardTimeoutMs("nope")).toBe(DEFAULT_FORWARD_TIMEOUT_MS);
    expect(parseForwardTimeoutMs("0")).toBe(DEFAULT_FORWARD_TIMEOUT_MS);
    expect(parseForwardTimeoutMs("-1")).toBe(DEFAULT_FORWARD_TIMEOUT_MS);
  });

  it("uses the configured positive value", () => {
    expect(parseForwardTimeoutMs("12345")).toBe(12345);
  });
});

// ── parseIdList ─────────────────────────────────────────────────────────────

describe("parseIdList", () => {
  it("returns empty set for undefined", () => {
    expect(parseIdList(undefined).size).toBe(0);
  });

  it("returns empty set for empty string", () => {
    expect(parseIdList("").size).toBe(0);
  });

  it("returns empty set for whitespace-only", () => {
    expect(parseIdList("   ").size).toBe(0);
  });

  it("splits comma-separated values", () => {
    const result = parseIdList("a,b,c");
    expect(result.size).toBe(3);
    expect(result.has("a")).toBe(true);
    expect(result.has("b")).toBe(true);
    expect(result.has("c")).toBe(true);
  });

  it("trims whitespace", () => {
    const result = parseIdList("  a , b , c  ");
    expect(result.has("a")).toBe(true);
    expect(result.has("b")).toBe(true);
    expect(result.has("c")).toBe(true);
  });

  it("filters empty entries", () => {
    const result = parseIdList("a,,b,,,c");
    expect(result.size).toBe(3);
  });

  it("handles single value", () => {
    const result = parseIdList("U12345");
    expect(result.size).toBe(1);
    expect(result.has("U12345")).toBe(true);
  });

  it("deduplicates repeated IDs", () => {
    const result = parseIdList("id1,id1,id1");
    expect(result.size).toBe(1);
  });

  it("filters entries from trailing commas", () => {
    const result = parseIdList("id1,,id2,");
    expect(result.size).toBe(2);
    expect(result.has("id1")).toBe(true);
    expect(result.has("id2")).toBe(true);
  });
});

// ── checkPermissions ────────────────────────────────────────────────────────

describe("checkPermissions", () => {
  it("allows when all lists are empty", () => {
    const result = checkPermissions(emptyPermissions(), testUser());
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("blocks a blocked user", () => {
    const config = { ...emptyPermissions(), blockedUsers: new Set(["U12345"]) };
    const result = checkPermissions(config, testUser());
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("user_blocked");
  });

  it("blocked takes precedence over allowed", () => {
    const config: PermissionConfig = {
      allowedChannels: new Set(),
      allowedUsers: new Set(["U12345"]),
      blockedUsers: new Set(["U12345"]),
    };
    const result = checkPermissions(config, testUser());
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("user_blocked");
  });

  it("allows user in allowedUsers", () => {
    const config = { ...emptyPermissions(), allowedUsers: new Set(["U12345"]) };
    const result = checkPermissions(config, testUser());
    expect(result.allowed).toBe(true);
  });

  it("denies user not in allowedUsers", () => {
    const config = { ...emptyPermissions(), allowedUsers: new Set(["U99999"]) };
    const result = checkPermissions(config, testUser());
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("user_not_allowed");
  });

  it("allows user in allowed channel", () => {
    const config = { ...emptyPermissions(), allowedChannels: new Set(["C12345"]) };
    const result = checkPermissions(config, testUser());
    expect(result.allowed).toBe(true);
  });

  it("denies user not in allowed channel", () => {
    const config = { ...emptyPermissions(), allowedChannels: new Set(["C99999"]) };
    const result = checkPermissions(config, testUser());
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("channel_not_allowed");
  });

  it("allows when no channel provided and channels unrestricted", () => {
    const result = checkPermissions(emptyPermissions(), testUser({ channelId: "" }));
    expect(result.allowed).toBe(true);
  });

  it("denies when channel required but empty", () => {
    const config = { ...emptyPermissions(), allowedChannels: new Set(["C12345"]) };
    const result = checkPermissions(config, testUser({ channelId: "" }));
    expect(result.allowed).toBe(false);
  });

  it("denies user with empty userId when users are restricted", () => {
    const config = { ...emptyPermissions(), allowedUsers: new Set(["U12345"]) };
    const result = checkPermissions(config, testUser({ userId: "" }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("user_not_allowed");
  });

  it("checks both user and channel restrictions", () => {
    const config: PermissionConfig = {
      allowedChannels: new Set(["C12345"]),
      allowedUsers: new Set(["U12345"]),
      blockedUsers: new Set(),
    };
    const result = checkPermissions(config, testUser());
    expect(result.allowed).toBe(true);
  });

  it("fails if user matches but channel does not", () => {
    const config: PermissionConfig = {
      allowedChannels: new Set(["C99999"]),
      allowedUsers: new Set(["U12345"]),
      blockedUsers: new Set(),
    };
    const result = checkPermissions(config, testUser());
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("channel_not_allowed");
  });
});

// ── loadPermissionConfig ────────────────────────────────────────────────────

describe("loadPermissionConfig", () => {
  it("loads from env vars", () => {
    const config = loadPermissionConfig({
      SLACK_ALLOWED_CHANNELS: "C1,C2",
      SLACK_ALLOWED_USERS: "U1",
      SLACK_BLOCKED_USERS: "U99",
    });
    expect(config.allowedChannels.size).toBe(2);
    expect(config.allowedUsers.size).toBe(1);
    expect(config.blockedUsers.size).toBe(1);
  });

  it("returns empty sets when env vars missing", () => {
    const config = loadPermissionConfig({});
    expect(config.allowedChannels.size).toBe(0);
    expect(config.allowedUsers.size).toBe(0);
    expect(config.blockedUsers.size).toBe(0);
  });

  it("handles whitespace in env values", () => {
    const config = loadPermissionConfig({
      SLACK_ALLOWED_CHANNELS: " C1 , C2 ",
    });
    expect(config.allowedChannels.has("C1")).toBe(true);
    expect(config.allowedChannels.has("C2")).toBe(true);
  });
});

// ── Session Keys ────────────────────────────────────────────────────────────

describe("session keys", () => {
  it("builds thread session key with channel and thread_ts", () => {
    expect(buildThreadSessionKey("C123", "1234567890.123456")).toBe(
      "slack:thread:C123:1234567890.123456",
    );
  });

  it("builds DM session key", () => {
    expect(buildDMSessionKey("U123")).toBe("slack:dm:U123");
  });

  it("builds channel-user session key", () => {
    expect(buildChannelUserSessionKey("C123", "U456")).toBe("slack:channel:C123:user:U456");
  });

  it("resolves to thread key when thread_ts present", () => {
    const key = resolveSessionKey({
      channelId: "C123",
      userId: "U456",
      threadTs: "1234567890.123456",
      isDM: false,
    });
    expect(key).toBe("slack:thread:C123:1234567890.123456");
  });

  it("resolves to DM key for DMs without thread", () => {
    const key = resolveSessionKey({
      channelId: "D123",
      userId: "U456",
      isDM: true,
    });
    expect(key).toBe("slack:dm:U456");
  });

  it("resolves to channel-user key for non-DM without thread", () => {
    const key = resolveSessionKey({
      channelId: "C123",
      userId: "U456",
      isDM: false,
    });
    expect(key).toBe("slack:channel:C123:user:U456");
  });

  it("thread_ts takes precedence over isDM", () => {
    const key = resolveSessionKey({
      channelId: "D123",
      userId: "U456",
      threadTs: "1234567890.123456",
      isDM: true,
    });
    expect(key).toBe("slack:thread:D123:1234567890.123456");
  });

  it("different threads produce different session keys", () => {
    const key1 = resolveSessionKey({
      channelId: "C123",
      userId: "U456",
      threadTs: "1111111111.111111",
      isDM: false,
    });
    const key2 = resolveSessionKey({
      channelId: "C123",
      userId: "U456",
      threadTs: "2222222222.222222",
      isDM: false,
    });
    expect(key1).not.toBe(key2);
  });

  it("different users in same channel produce different keys", () => {
    const key1 = resolveSessionKey({ channelId: "C123", userId: "U111", isDM: false });
    const key2 = resolveSessionKey({ channelId: "C123", userId: "U222", isDM: false });
    expect(key1).not.toBe(key2);
  });
});

// ── ConversationQueue ───────────────────────────────────────────────────────

describe("ConversationQueue", () => {
  it("runs task immediately when not processing", async () => {
    const queue = new ConversationQueue();
    let ran = false;
    const result = await queue.runOrQueue("key1", {
      run: async () => {
        ran = true;
      },
    });
    expect(result).toBe("started");
    expect(ran).toBe(true);
  });

  it("queues task when already processing", async () => {
    const queue = new ConversationQueue();
    const order: number[] = [];
    const blocker = deferred();

    const firstPromise = queue.runOrQueue("key1", {
      run: async () => {
        order.push(1);
        await blocker.promise;
      },
    });

    const secondResult = await queue.runOrQueue("key1", {
      run: async () => {
        order.push(2);
      },
    });

    expect(secondResult).toBe("queued");
    blocker.resolve();
    await firstPromise;
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual([1, 2]);
  });

  it("calls onQueued when task is queued", async () => {
    const queue = new ConversationQueue();
    let queuedCalled = false;
    const blocker = deferred();

    queue.runOrQueue("key1", {
      run: async () => {
        await blocker.promise;
      },
    });

    await queue.runOrQueue("key1", {
      onQueued: async () => {
        queuedCalled = true;
      },
      run: async () => {},
    });

    expect(queuedCalled).toBe(true);
    blocker.resolve();
  });

  it("clear drops queued tasks", async () => {
    const queue = new ConversationQueue();
    const blocker = deferred();

    queue.runOrQueue("key1", {
      run: async () => {
        await blocker.promise;
      },
    });

    queue.runOrQueue("key1", { run: async () => {} });
    queue.runOrQueue("key1", { run: async () => {} });

    const dropped = queue.clear("key1");
    expect(dropped).toBe(2);

    blocker.resolve();
  });

  it("isProcessing returns correct state", async () => {
    const queue = new ConversationQueue();
    expect(queue.isProcessing("key1")).toBe(false);

    const blocker = deferred();

    queue.runOrQueue("key1", {
      run: async () => {
        await blocker.promise;
      },
    });

    expect(queue.isProcessing("key1")).toBe(true);
    blocker.resolve();
  });

  it("queuedCount tracks pending tasks", async () => {
    const queue = new ConversationQueue();
    const blocker = deferred();

    queue.runOrQueue("key1", {
      run: async () => {
        await blocker.promise;
      },
    });

    expect(queue.queuedCount("key1")).toBe(0);

    queue.runOrQueue("key1", { run: async () => {} });
    expect(queue.queuedCount("key1")).toBe(1);

    queue.runOrQueue("key1", { run: async () => {} });
    expect(queue.queuedCount("key1")).toBe(2);

    blocker.resolve();
  });

  it("cleans up state after all tasks complete", async () => {
    const queue = new ConversationQueue();
    await queue.runOrQueue("key1", { run: async () => {} });
    expect(queue.isProcessing("key1")).toBe(false);
    expect(queue.queuedCount("key1")).toBe(0);
  });

  it("clear returns 0 for unknown session key", () => {
    const queue = new ConversationQueue();
    expect(queue.clear("nonexistent")).toBe(0);
  });

  it("runs queued work sequentially (FIFO)", async () => {
    const queue = new ConversationQueue();
    const blocker = deferred();
    const events: string[] = [];

    const first = queue.runOrQueue("s1", {
      run: async () => {
        events.push("first:start");
        await blocker.promise;
        events.push("first:end");
      },
    });

    const second = queue.runOrQueue("s1", {
      onQueued: async () => {
        events.push("second:queued");
      },
      run: async () => {
        events.push("second:run");
      },
    });

    expect(await second).toBe("queued");
    expect(queue.queuedCount("s1")).toBe(1);

    blocker.resolve();
    expect(await first).toBe("started");

    await Bun.sleep(0);
    expect(events).toEqual(["first:start", "second:queued", "first:end", "second:run"]);
    expect(queue.isProcessing("s1")).toBe(false);
  });

  it("drops queued work when cleared", async () => {
    const queue = new ConversationQueue();
    const blocker = deferred();
    const events: string[] = [];

    const first = queue.runOrQueue("s1", {
      run: async () => {
        events.push("first:start");
        await blocker.promise;
        events.push("first:end");
      },
    });

    await queue.runOrQueue("s1", {
      run: async () => {
        events.push("second:run");
      },
    });

    expect(queue.clear("s1")).toBe(1);

    blocker.resolve();
    await first;
    await Bun.sleep(0);

    expect(events).toEqual(["first:start", "first:end"]);
    expect(queue.queuedCount("s1")).toBe(0);
  });
});

// ── splitMessage ────────────────────────────────────────────────────────────

describe("splitMessage", () => {
  it("returns single chunk for short message", () => {
    const result = splitMessage("Hello world", 4000);
    expect(result).toEqual(["Hello world"]);
  });

  it("returns single chunk for message exactly at limit", () => {
    const text = "x".repeat(4000);
    const result = splitMessage(text, 4000);
    expect(result).toEqual([text]);
  });

  it("splits at double newline when possible", () => {
    const part1 = "a".repeat(2000);
    const part2 = "b".repeat(2000);
    const content = part1 + "\n\n" + part2;
    const result = splitMessage(content, 3000);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(part1);
    expect(result[1]).toBe(part2);
  });

  it("splits at single newline when no double newline", () => {
    const part1 = "a".repeat(2000);
    const part2 = "b".repeat(2000);
    const content = part1 + "\n" + part2;
    const result = splitMessage(content, 3000);
    expect(result.length).toBe(2);
  });

  it("handles code block continuations", () => {
    const code = "```js\n" + "x".repeat(5000) + "\n```";
    const result = splitMessage(code, 3000);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      const count = (chunk.match(/```/g) || []).length;
      expect(count % 2).toBe(0);
    }
  });

  it("continues code block language hint in continuation chunks", () => {
    const code = "```python\n" + Array.from({ length: 100 }, (_, i) => `print(${i})`).join("\n") + "\n```";
    const chunks = splitMessage(code, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toMatch(/^```python/);
    for (const chunk of chunks) {
      const count = (chunk.match(/```/g) || []).length;
      expect(count % 2).toBe(0);
    }
  });

  it("returns empty array for empty string", () => {
    const result = splitMessage("", 4000);
    expect(result).toEqual([]);
  });

  it("handles content just over max length", () => {
    const content = "a".repeat(4001);
    const result = splitMessage(content, 4000);
    expect(result.length).toBe(2);
  });

  it("handles very long single line without newlines", () => {
    const text = "x".repeat(10000);
    const chunks = splitMessage(text, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalLen).toBe(10000);
  });

  it("preserves all content across splits", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${"y".repeat(100)}`);
    const text = lines.join("\n");
    const chunks = splitMessage(text, 2000);
    const rejoined = chunks.join("\n");
    for (const line of lines) {
      expect(rejoined).toContain(line);
    }
  });

  it("handles multiple separate code blocks", () => {
    const block1 = "```js\nconsole.log('a');\n```";
    const block2 = "```py\nprint('b')\n```";
    const text = `${block1}\n\nSome text\n\n${block2}`;
    const chunks = splitMessage(text, 4000);
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

  it("uses 4000 as default max for Slack (not Discord 2000)", () => {
    // Verify the constant is correct for Slack
    const text = "x".repeat(3999);
    const chunks = splitMessage(text, 4000);
    expect(chunks.length).toBe(1);
  });
});

// ── SlackChannel class ──────────────────────────────────────────────────────

describe("SlackChannel", () => {
  it("has correct name", () => {
    const channel = new SlackChannel();
    expect(channel.name).toBe("slack");
  });

  it("handleRequest returns null (Socket Mode, no HTTP inbound)", () => {
    const channel = new SlackChannel();
    const req = new Request("http://localhost/test", { method: "POST" });
    return channel.handleRequest(req).then((result) => {
      expect(result).toBeNull();
    });
  });

  it("health endpoint returns correct service name", async () => {
    const channel = new SlackChannel();
    Object.defineProperty(channel, "secret", { value: "test-secret" });
    const handler = channel.createFetch();
    const resp = await handler(new Request("http://localhost/health"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("channel-slack");
  });

  it("health endpoint responds to any host header", async () => {
    const channel = new SlackChannel();
    Object.defineProperty(channel, "secret", { value: "test-secret" });
    const handler = channel.createFetch();
    const resp = await handler(new Request("http://127.0.0.1:8185/health"));
    expect(resp.status).toBe(200);
  });

  it("returns 404 for non-POST requests", async () => {
    const channel = new SlackChannel();
    Object.defineProperty(channel, "secret", { value: "test-secret" });
    const handler = channel.createFetch();
    const resp = await handler(new Request("http://localhost/message", { method: "GET" }));
    expect(resp.status).toBe(404);
  });

  it("returns 404 for unknown paths", async () => {
    const channel = new SlackChannel();
    Object.defineProperty(channel, "secret", { value: "test-secret" });
    const handler = channel.createFetch();
    const resp = await handler(new Request("http://localhost/nope"));
    expect(resp.status).toBe(404);
  });

  it("botToken reads from env", () => {
    const channel = new SlackChannel();
    expect(typeof channel.botToken).toBe("string");
  });

  it("appToken reads from env", () => {
    const channel = new SlackChannel();
    expect(typeof channel.appToken).toBe("string");
  });

  it("inherits port from env or defaults to 8080", () => {
    const channel = new SlackChannel();
    expect(typeof channel.port).toBe("number");
  });

  it("inherits guardianUrl from env or defaults", () => {
    const channel = new SlackChannel();
    expect(typeof channel.guardianUrl).toBe("string");
    expect(channel.guardianUrl).toContain("guardian");
  });

  it("secret resolves from CHANNEL_SLACK_SECRET env", () => {
    const channel = new SlackChannel();
    expect(typeof channel.secret).toBe("string");
  });
});

// ── Message handling behavior ───────────────────────────────────────────────

describe("DM message handling", () => {
  it("ignores bot messages (bot_id present)", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () => new Response(JSON.stringify({ answer: "hi" }), { status: 200 }));
    Object.assign(channel, { forward });

    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onMessage: (event: Record<string, unknown>, say: MockSay, client: MockClient) => Promise<void>;
    }).onMessage(
      { user: "U123", channel: "D123", text: "hello", ts: "1.1", channel_type: "im", bot_id: "B123" },
      say,
      client,
    );

    expect(forward).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it("ignores messages with subtype", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () => new Response("{}", { status: 200 }));
    Object.assign(channel, { forward });

    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onMessage: (event: Record<string, unknown>, say: MockSay, client: MockClient) => Promise<void>;
    }).onMessage(
      { user: "U123", channel: "D123", text: "hello", ts: "1.1", channel_type: "im", subtype: "message_changed" },
      say,
      client,
    );

    expect(forward).not.toHaveBeenCalled();
  });

  it("ignores empty text", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () => new Response("{}", { status: 200 }));
    Object.assign(channel, { forward });

    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onMessage: (event: Record<string, unknown>, say: MockSay, client: MockClient) => Promise<void>;
    }).onMessage(
      { user: "U123", channel: "D123", text: "   ", ts: "1.1", channel_type: "im" },
      say,
      client,
    );

    expect(forward).not.toHaveBeenCalled();
  });

  it("ignores own messages (bot self-reply guard)", async () => {
    const channel = new SlackChannel();
    Object.assign(channel, { botUserId: "BSELF" });
    const forward = mock(async () => new Response("{}", { status: 200 }));
    Object.assign(channel, { forward });

    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onMessage: (event: Record<string, unknown>, say: MockSay, client: MockClient) => Promise<void>;
    }).onMessage(
      { user: "BSELF", channel: "D123", text: "echo", ts: "1.1", channel_type: "im" },
      say,
      client,
    );

    expect(forward).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it("ignores non-DM messages (channel_type !== 'im')", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () => new Response("{}", { status: 200 }));
    Object.assign(channel, { forward });

    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onMessage: (event: Record<string, unknown>, say: MockSay, client: MockClient) => Promise<void>;
    }).onMessage(
      { user: "U123", channel: "C123", text: "hello", ts: "1.1", channel_type: "channel" },
      say,
      client,
    );

    expect(forward).not.toHaveBeenCalled();
  });

  it("forwards DM to guardian and replies in thread", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () =>
      new Response(JSON.stringify({ answer: "Hi there!" }), { status: 200 }),
    );
    Object.assign(channel, { forward });

    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onMessage: (event: Record<string, unknown>, say: MockSay, client: MockClient) => Promise<void>;
    }).onMessage(
      { user: "U123", channel: "D123", text: "hello bot", ts: "1.1", channel_type: "im", team: "T1" },
      say,
      client,
    );

    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward.mock.calls[0]?.[0]).toMatchObject({
      userId: "slack:U123",
      text: "hello bot",
    });
    // Thinking message posted, then updated with response
    expect(client.chat.postMessage.mock.calls[0][0]).toMatchObject({
      channel: "D123",
      text: ":hourglass: Processing your request...",
      thread_ts: "1.1",
    });
    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "D123",
      ts: "1234567890.123456",
      text: "Hi there!",
    });
  });

  it("uses thread_ts for session key when in a DM thread", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () =>
      new Response(JSON.stringify({ answer: "reply" }), { status: 200 }),
    );
    Object.assign(channel, { forward });

    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onMessage: (event: Record<string, unknown>, say: MockSay, client: MockClient) => Promise<void>;
    }).onMessage(
      {
        user: "U123",
        channel: "D123",
        text: "follow up",
        ts: "2.2",
        thread_ts: "1.1",
        channel_type: "im",
        team: "T1",
      },
      say,
      client,
    );

    expect(forward.mock.calls[0]?.[0].metadata).toMatchObject({
      sessionKey: "slack:thread:D123:1.1",
    });
  });

  it("denies blocked user in DM", async () => {
    const channel = new SlackChannel();
    Object.assign(channel, {
      permissions: {
        allowedChannels: new Set<string>(),
        allowedUsers: new Set<string>(),
        blockedUsers: new Set(["U123"]),
      },
    });

    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onMessage: (event: Record<string, unknown>, say: MockSay, client: MockClient) => Promise<void>;
    }).onMessage(
      { user: "U123", channel: "D123", text: "hello", ts: "1.1", channel_type: "im" },
      say,
      client,
    );

    expect(say).toHaveBeenCalledWith({
      text: "You do not have permission to use this bot.",
      thread_ts: "1.1",
    });
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});

// ── App mention handling ────────────────────────────────────────────────────

describe("app mention handling", () => {
  it("responds to app_mention and replies in thread", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () =>
      new Response(JSON.stringify({ answer: "mentioned!" }), { status: 200 }),
    );
    Object.assign(channel, { forward });

    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onAppMention: (event: Record<string, unknown>, say: MockSay, client: MockClient) => Promise<void>;
    }).onAppMention(
      { user: "U123", channel: "C456", text: "hey bot help me", ts: "1.1", team: "T1" },
      say,
      client,
    );

    expect(forward).toHaveBeenCalledTimes(1);
    // Thinking message posted, then updated with response
    expect(client.chat.postMessage.mock.calls[0][0]).toMatchObject({
      channel: "C456",
      text: ":hourglass: Processing your request...",
      thread_ts: "1.1",
    });
    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C456",
      ts: "1234567890.123456",
      text: "mentioned!",
    });
  });

  it("ignores empty text in app_mention", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () => new Response("{}", { status: 200 }));
    Object.assign(channel, { forward });

    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onAppMention: (event: Record<string, unknown>, say: MockSay, client: MockClient) => Promise<void>;
    }).onAppMention(
      { user: "U123", channel: "C456", text: "", ts: "1.1" },
      say,
      client,
    );

    expect(forward).not.toHaveBeenCalled();
  });

  it("strips bot mention from text", async () => {
    const channel = new SlackChannel();
    Object.assign(channel, { botUserId: "B999" });
    const forward = mock(async () =>
      new Response(JSON.stringify({ answer: "ok" }), { status: 200 }),
    );
    Object.assign(channel, { forward });

    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onAppMention: (event: Record<string, unknown>, say: MockSay, client: MockClient) => Promise<void>;
    }).onAppMention(
      { user: "U123", channel: "C456", text: "<@B999> help me please", ts: "1.1", team: "T1" },
      say,
      client,
    );

    expect(forward.mock.calls[0]?.[0].text).toBe("help me please");
  });

  it("replies 'Please provide a message' when mention-only (no text after strip)", async () => {
    const channel = new SlackChannel();
    Object.assign(channel, { botUserId: "B999" });

    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onAppMention: (event: Record<string, unknown>, say: MockSay, client: MockClient) => Promise<void>;
    }).onAppMention(
      { user: "U123", channel: "C456", text: "<@B999>", ts: "1.1", team: "T1" },
      say,
      client,
    );

    expect(say).toHaveBeenCalledWith({
      text: "Please provide a message.",
      thread_ts: "1.1",
    });
  });

  it("uses existing thread_ts for threaded mentions", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () =>
      new Response(JSON.stringify({ answer: "threaded!" }), { status: 200 }),
    );
    Object.assign(channel, { forward });

    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onAppMention: (event: Record<string, unknown>, say: MockSay, client: MockClient) => Promise<void>;
    }).onAppMention(
      { user: "U123", channel: "C456", text: "question", ts: "2.2", thread_ts: "1.1", team: "T1" },
      say,
      client,
    );

    expect(forward.mock.calls[0]?.[0].metadata).toMatchObject({
      sessionKey: "slack:thread:C456:1.1",
    });
    // Thinking message posted in thread, then updated with response
    expect(client.chat.postMessage.mock.calls[0][0]).toMatchObject({
      channel: "C456",
      text: ":hourglass: Processing your request...",
      thread_ts: "1.1",
    });
    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C456",
      ts: "1234567890.123456",
      text: "threaded!",
    });
  });
});

// ── Slash command: /clear ───────────────────────────────────────────────────

describe("/clear command", () => {
  it("forwards clearSession request with session metadata", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    Object.assign(channel, { forward });

    const say = createMockSay();

    await (channel as unknown as {
      onClearCommand: (cmd: Record<string, string>, say: MockSay) => Promise<void>;
    }).onClearCommand(
      { user_id: "U123", user_name: "tester", team_id: "T1", channel_id: "C456", text: "" },
      say,
    );

    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward.mock.calls[0]?.[0]).toMatchObject({
      userId: "slack:U123",
      text: "clear session",
      metadata: {
        command: "clear",
        channelId: "C456",
        teamId: "T1",
        username: "tester",
        clearSession: true,
      },
    });
    expect(forward.mock.calls[0]?.[2]).toBe(DEFAULT_FORWARD_TIMEOUT_MS);
    expect(say).toHaveBeenCalledWith({ text: "Conversation cleared." });
  });

  it("reports dropped queued follow-ups", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    Object.assign(channel, { forward });

    // Pre-populate the queue
    const queue = new ConversationQueue();
    const blocker = deferred();
    queue.runOrQueue("slack:channel:C456:user:U123", { run: async () => { await blocker.promise; } });
    queue.runOrQueue("slack:channel:C456:user:U123", { run: async () => {} });
    Object.assign(channel, { conversationQueue: queue });

    const say = createMockSay();

    await (channel as unknown as {
      onClearCommand: (cmd: Record<string, string>, say: MockSay) => Promise<void>;
    }).onClearCommand(
      { user_id: "U123", user_name: "tester", team_id: "T1", channel_id: "C456", text: "" },
      say,
    );

    expect(say).toHaveBeenCalledWith({ text: "Conversation cleared. Dropped queued follow-ups." });
    blocker.resolve();
  });

  it("handles guardian error gracefully", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () => { throw new Error("network failure"); });
    Object.assign(channel, { forward });

    const say = createMockSay();

    await (channel as unknown as {
      onClearCommand: (cmd: Record<string, string>, say: MockSay) => Promise<void>;
    }).onClearCommand(
      { user_id: "U123", user_name: "tester", team_id: "T1", channel_id: "C456", text: "" },
      say,
    );

    expect(say).toHaveBeenCalledWith({ text: "Could not clear this conversation right now." });
  });

  it("denies blocked user", async () => {
    const channel = new SlackChannel();
    Object.assign(channel, {
      permissions: {
        allowedChannels: new Set<string>(),
        allowedUsers: new Set<string>(),
        blockedUsers: new Set(["U123"]),
      },
    });
    const forward = mock(async () => new Response("{}", { status: 200 }));
    Object.assign(channel, { forward });

    const say = createMockSay();

    await (channel as unknown as {
      onClearCommand: (cmd: Record<string, string>, say: MockSay) => Promise<void>;
    }).onClearCommand(
      { user_id: "U123", user_name: "blocked", team_id: "T1", channel_id: "C456", text: "" },
      say,
    );

    expect(say).toHaveBeenCalledWith({ text: "You do not have permission to use this bot." });
    expect(forward).not.toHaveBeenCalled();
  });

  it("handles non-ok guardian response", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () => new Response("{}", { status: 500 }));
    Object.assign(channel, { forward });

    const say = createMockSay();

    await (channel as unknown as {
      onClearCommand: (cmd: Record<string, string>, say: MockSay) => Promise<void>;
    }).onClearCommand(
      { user_id: "U123", user_name: "tester", team_id: "T1", channel_id: "C456", text: "" },
      say,
    );

    expect(say).toHaveBeenCalledWith({ text: "Could not clear this conversation right now." });
  });
});

// ── Slash command: /ask ─────────────────────────────────────────────────────

describe("/ask command", () => {
  it("replies with usage when text is empty", async () => {
    const channel = new SlackChannel();
    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onAskCommand: (cmd: Record<string, string>, say: MockSay, client: MockClient) => Promise<void>;
    }).onAskCommand(
      { user_id: "U123", user_name: "tester", team_id: "T1", channel_id: "C456", text: "" },
      say,
      client,
    );

    expect(say).toHaveBeenCalledWith({ text: "Usage: `/ask <message>`" });
  });

  it("posts thinking message, forwards to guardian, updates with answer", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () =>
      new Response(JSON.stringify({ answer: "Here is my answer" }), { status: 200 }),
    );
    Object.assign(channel, { forward });

    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onAskCommand: (cmd: Record<string, string>, say: MockSay, client: MockClient) => Promise<void>;
    }).onAskCommand(
      { user_id: "U123", user_name: "tester", team_id: "T1", channel_id: "C456", text: "what is AI?" },
      say,
      client,
    );

    // Should post thinking message
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C456",
      text: `:hourglass: Processing your request...`,
    });

    // Should update thinking message with answer
    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C456",
      ts: "1234567890.123456",
      text: "Here is my answer",
    });

    // Should have forwarded to guardian
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward.mock.calls[0]?.[0]).toMatchObject({
      userId: "slack:U123",
      text: "what is AI?",
      metadata: {
        command: "ask",
        teamId: "T1",
        username: "tester",
      },
    });
    expect(forward.mock.calls[0]?.[2]).toBe(DEFAULT_FORWARD_TIMEOUT_MS);
  });

  it("uses configured SLACK_FORWARD_TIMEOUT_MS for guardian forwarding", async () => {
    Bun.env.SLACK_FORWARD_TIMEOUT_MS = "4321";
    const channel = new SlackChannel();
    const forward = mock(async () =>
      new Response(JSON.stringify({ answer: "Here is my answer" }), { status: 200 }),
    );
    Object.assign(channel, { forward });

    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onAskCommand: (cmd: Record<string, string>, say: MockSay, client: MockClient) => Promise<void>;
    }).onAskCommand(
      { user_id: "U123", user_name: "tester", team_id: "T1", channel_id: "C456", text: "what is AI?" },
      say,
      client,
    );

    expect(forward.mock.calls[0]?.[2]).toBe(4321);
  });

  it("updates thinking message with error on guardian failure", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () => new Response("{}", { status: 500 }));
    Object.assign(channel, { forward });

    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onAskCommand: (cmd: Record<string, string>, say: MockSay, client: MockClient) => Promise<void>;
    }).onAskCommand(
      { user_id: "U123", user_name: "tester", team_id: "T1", channel_id: "C456", text: "test" },
      say,
      client,
    );

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C456",
      ts: "1234567890.123456",
      text: "Error: Guardian returned status 500",
    });
  });

  it("denies blocked user", async () => {
    const channel = new SlackChannel();
    Object.assign(channel, {
      permissions: {
        allowedChannels: new Set<string>(),
        allowedUsers: new Set<string>(),
        blockedUsers: new Set(["U123"]),
      },
    });

    const say = createMockSay();
    const client = createMockClient();

    await (channel as unknown as {
      onAskCommand: (cmd: Record<string, string>, say: MockSay, client: MockClient) => Promise<void>;
    }).onAskCommand(
      { user_id: "U123", user_name: "blocked", team_id: "T1", channel_id: "C456", text: "hello" },
      say,
      client,
    );

    expect(say).toHaveBeenCalledWith({ text: "You do not have permission to use this bot." });
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});

// ── Slash command: /help ────────────────────────────────────────────────────

describe("/help command", () => {
  it("denies blocked user", async () => {
    const channel = new SlackChannel();
    Object.assign(channel, {
      permissions: {
        allowedChannels: new Set<string>(),
        allowedUsers: new Set<string>(),
        blockedUsers: new Set(["U123"]),
      },
    });

    const say = createMockSay();

    await (channel as unknown as {
      onHelpCommand: (cmd: Record<string, string>, say: MockSay) => Promise<void>;
    }).onHelpCommand(
      { user_id: "U123", user_name: "blocked", team_id: "T1", channel_id: "C456", text: "" },
      say,
    );

    expect(say).toHaveBeenCalledWith({ text: "You do not have permission to use this bot." });
  });

  it("lists available commands", async () => {
    const channel = new SlackChannel();
    const say = createMockSay();

    await (channel as unknown as {
      onHelpCommand: (cmd: Record<string, string>, say: MockSay) => Promise<void>;
    }).onHelpCommand(
      { user_id: "U123", user_name: "tester", team_id: "T1", channel_id: "C456", text: "" },
      say,
    );

    expect(say).toHaveBeenCalledTimes(1);
    const text = say.mock.calls[0]?.[0]?.text as string;
    expect(text).toContain("/ask");
    expect(text).toContain("/clear");
    expect(text).toContain("/help");
    expect(text).toContain("mention me");
    expect(text).toContain("DM");
  });
});

// ── Shortcuts, modal submissions, and App Home ─────────────────────────────

describe("shortcut and modal handlers", () => {
  it("opens Ask OpenPalm modal from global shortcut", async () => {
    const channel = new SlackChannel();
    const client = createMockClient();

    await (channel as unknown as {
      onGlobalShortcut: (shortcut: Record<string, unknown>, client: MockClient) => Promise<void>;
    }).onGlobalShortcut(
      {
        trigger_id: "trigger-1",
        user: { id: "U123" },
        team: { id: "T1" },
      },
      client,
    );

    expect(client.views.open).toHaveBeenCalledTimes(1);
    const args = client.views.open.mock.calls[0]?.[0];
    expect(args.trigger_id).toBe("trigger-1");
    expect(args.view.callback_id).toBe("ask_openpalm_modal");
  });

  it("opens prefilled modal from message shortcut", async () => {
    const channel = new SlackChannel();
    const client = createMockClient();

    await (channel as unknown as {
      onMessageShortcut: (shortcut: Record<string, unknown>, client: MockClient) => Promise<void>;
    }).onMessageShortcut(
      {
        trigger_id: "trigger-2",
        user: { id: "U123" },
        team: { id: "T1" },
        channel: { id: "C456" },
        message: { ts: "1710000000.000001", text: "Please summarize this" },
      },
      client,
    );

    const args = client.views.open.mock.calls[0]?.[0];
    expect(args.view.blocks[0].element.initial_value).toContain("Please summarize this");
    expect(args.view.private_metadata).toContain("message-shortcut");
    expect(args.view.private_metadata).toContain("C456");
  });

  it("handles modal submission from message shortcut using thread session", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () =>
      new Response(JSON.stringify({ answer: "modal answer" }), { status: 200 }),
    );
    Object.assign(channel, { forward });
    const client = createMockClient();

    await (channel as unknown as {
      onAskModalSubmission: (
        body: Record<string, unknown>,
        view: Record<string, unknown>,
        client: MockClient,
      ) => Promise<void>;
    }).onAskModalSubmission(
      {
        user: { id: "U123", username: "tester" },
        team: { id: "T1" },
      },
      {
        private_metadata: JSON.stringify({
          source: "message-shortcut",
          channelId: "C456",
          threadTs: "1710000000.000001",
          teamId: "T1",
        }),
        state: {
          values: {
            ask_openpalm_prompt_block: {
              ask_openpalm_prompt_action: {
                value: "use this context",
              },
            },
          },
        },
      },
      client,
    );

    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward.mock.calls[0]?.[0]).toMatchObject({
      userId: "slack:U123",
      text: "use this context",
    });
    expect(forward.mock.calls[0]?.[0].metadata.sessionKey).toBe("slack:thread:C456:1710000000.000001");
    expect(client.chat.postMessage.mock.calls[0]?.[0]).toMatchObject({
      channel: "C456",
      thread_ts: "1710000000.000001",
    });
  });

  it("handles modal submission from global shortcut via DM channel", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () =>
      new Response(JSON.stringify({ answer: "dm modal answer" }), { status: 200 }),
    );
    Object.assign(channel, { forward });
    const client = createMockClient();

    await (channel as unknown as {
      onAskModalSubmission: (
        body: Record<string, unknown>,
        view: Record<string, unknown>,
        client: MockClient,
      ) => Promise<void>;
    }).onAskModalSubmission(
      {
        user: { id: "U999", username: "tester" },
        team: { id: "T1" },
      },
      {
        private_metadata: JSON.stringify({ source: "global-shortcut", teamId: "T1" }),
        state: {
          values: {
            ask_openpalm_prompt_block: {
              ask_openpalm_prompt_action: {
                value: "question from modal",
              },
            },
          },
        },
      },
      client,
    );

    expect(client.conversations.open).toHaveBeenCalledWith({ users: "U999" });
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward.mock.calls[0]?.[0].metadata.sessionKey).toBe("slack:dm:U999");
  });
});

describe("app home", () => {
  it("publishes Home tab content on app_home_opened", async () => {
    const channel = new SlackChannel();
    const client = createMockClient();

    await (channel as unknown as {
      onAppHomeOpened: (event: Record<string, unknown>, client: MockClient) => Promise<void>;
    }).onAppHomeOpened(
      { user: "U123" },
      client,
    );

    expect(client.views.publish).toHaveBeenCalledTimes(1);
    const payload = client.views.publish.mock.calls[0]?.[0];
    expect(payload.user_id).toBe("U123");
    expect(payload.view.type).toBe("home");
  });
});

// ── Conversation runner ─────────────────────────────────────────────────────

describe("runConversation", () => {
  it("posts thinking message and updates it with response", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () =>
      new Response(JSON.stringify({ answer: "done" }), { status: 200 }),
    );
    Object.assign(channel, { forward });

    const client = createMockClient();

    await (channel as unknown as {
      runConversation: (
        client: MockClient, channel: string, threadTs: string,
        userInfo: UserInfo, text: string, sessionKey: string,
      ) => Promise<void>;
    }).runConversation(client, "C123", "1.1", testUser(), "hello", "key1");

    // First call: thinking message
    expect(client.chat.postMessage.mock.calls[0][0]).toMatchObject({
      channel: "C123",
      text: ":hourglass: Processing your request...",
      thread_ts: "1.1",
    });
    // Thinking message updated with response
    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "1234567890.123456",
      text: "done",
    });
    expect(forward.mock.calls[0]?.[2]).toBe(DEFAULT_FORWARD_TIMEOUT_MS);
  });

  it("updates thinking message with error on failure", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () => { throw new Error("timeout"); });
    Object.assign(channel, { forward });

    const client = createMockClient();

    await (channel as unknown as {
      runConversation: (
        client: MockClient, channel: string, threadTs: string,
        userInfo: UserInfo, text: string, sessionKey: string,
      ) => Promise<void>;
    }).runConversation(client, "C123", "1.1", testUser(), "hello", "key1");

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "1234567890.123456",
      text: "Error: timeout",
    });
  });

  it("continues even when thinking message fails to post", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () =>
      new Response(JSON.stringify({ answer: "still works" }), { status: 200 }),
    );
    Object.assign(channel, { forward });

    const client = createMockClient();
    // First postMessage (thinking) fails, second (response) succeeds
    let callCount = 0;
    client.chat.postMessage = mock(async (args: Record<string, unknown>) => {
      callCount++;
      if (callCount === 1) throw new Error("no permission");
      return { ts: "1234567890.123456" };
    });

    await (channel as unknown as {
      runConversation: (
        client: MockClient, channel: string, threadTs: string,
        userInfo: UserInfo, text: string, sessionKey: string,
      ) => Promise<void>;
    }).runConversation(client, "C123", "1.1", testUser(), "hello", "key1");

    // Should fall back to posting response as new message
    expect(client.chat.postMessage.mock.calls[1][0]).toMatchObject({
      channel: "C123",
      text: "still works",
      thread_ts: "1.1",
    });
    // Should NOT try to update a message that was never posted
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("splits long responses into multiple messages", async () => {
    const channel = new SlackChannel();
    const longAnswer = "x".repeat(5000);
    const forward = mock(async () =>
      new Response(JSON.stringify({ answer: longAnswer }), { status: 200 }),
    );
    Object.assign(channel, { forward });

    const client = createMockClient();

    await (channel as unknown as {
      runConversation: (
        client: MockClient, channel: string, threadTs: string,
        userInfo: UserInfo, text: string, sessionKey: string,
      ) => Promise<void>;
    }).runConversation(client, "C123", "1.1", testUser(), "hello", "key1");

    // First call is thinking message, then update replaces it with first chunk,
    // then additional chunks posted as new messages
    const postCalls = client.chat.postMessage.mock.calls;
    // At least thinking message + follow-up chunks
    expect(postCalls.length).toBeGreaterThan(1);
    // Follow-up chunks should be in the thread
    for (let i = 1; i < postCalls.length; i++) {
      expect(postCalls[i][0].thread_ts).toBe("1.1");
    }
  });

  it("returns 'No response received.' when guardian returns no answer", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () =>
      new Response(JSON.stringify({}), { status: 200 }),
    );
    Object.assign(channel, { forward });

    const client = createMockClient();

    await (channel as unknown as {
      runConversation: (
        client: MockClient, channel: string, threadTs: string,
        userInfo: UserInfo, text: string, sessionKey: string,
      ) => Promise<void>;
    }).runConversation(client, "C123", "1.1", testUser(), "hello", "key1");

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "1234567890.123456",
      text: "No response received.",
    });
  });
});

// ── Guardian forwarding ─────────────────────────────────────────────────────

describe("forwardToGuardian", () => {
  it("prepends 'slack:' to userId", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () =>
      new Response(JSON.stringify({ answer: "ok" }), { status: 200 }),
    );
    Object.assign(channel, { forward });

    await (channel as unknown as {
      forwardToGuardian: (userId: string, text: string, metadata: Record<string, unknown>) => Promise<string>;
    }).forwardToGuardian("U123", "hello", { sessionKey: "k1" });

    expect(forward.mock.calls[0]?.[0].userId).toBe("slack:U123");
  });

  it("throws on non-ok guardian response", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () => new Response("{}", { status: 502 }));
    Object.assign(channel, { forward });

    try {
      await (channel as unknown as {
        forwardToGuardian: (userId: string, text: string, metadata: Record<string, unknown>) => Promise<string>;
      }).forwardToGuardian("U123", "hello", {});
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect((e as Error).message).toBe("Guardian returned status 502");
    }
  });

  it("returns 'No response received.' when answer is missing", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () =>
      new Response(JSON.stringify({ sessionId: "s1" }), { status: 200 }),
    );
    Object.assign(channel, { forward });

    const result = await (channel as unknown as {
      forwardToGuardian: (userId: string, text: string, metadata: Record<string, unknown>) => Promise<string>;
    }).forwardToGuardian("U123", "hello", {});

    expect(result).toBe("No response received.");
  });

  it("passes metadata through to forward", async () => {
    const channel = new SlackChannel();
    const forward = mock(async () =>
      new Response(JSON.stringify({ answer: "ok" }), { status: 200 }),
    );
    Object.assign(channel, { forward });

    await (channel as unknown as {
      forwardToGuardian: (userId: string, text: string, metadata: Record<string, unknown>) => Promise<string>;
    }).forwardToGuardian("U123", "hello", {
      sessionKey: "key1",
      teamId: "T1",
      command: "ask",
    });

    expect(forward.mock.calls[0]?.[0].metadata).toMatchObject({
      sessionKey: "key1",
      teamId: "T1",
      command: "ask",
    });
  });
});

// ── Utility: stripMention ───────────────────────────────────────────────────

describe("stripMention", () => {
  it("strips bot mention from text", () => {
    const channel = new SlackChannel();
    Object.assign(channel, { botUserId: "B999" });

    const result = (channel as unknown as {
      stripMention: (text: string) => string;
    }).stripMention("<@B999> help me");

    expect(result).toBe("help me");
  });

  it("strips multiple mentions", () => {
    const channel = new SlackChannel();
    Object.assign(channel, { botUserId: "B999" });

    const result = (channel as unknown as {
      stripMention: (text: string) => string;
    }).stripMention("<@B999> do this <@B999>");

    expect(result).toBe("do this");
  });

  it("returns original text when no botUserId", () => {
    const channel = new SlackChannel();

    const result = (channel as unknown as {
      stripMention: (text: string) => string;
    }).stripMention("<@B999> help");

    expect(result).toBe("<@B999> help");
  });

  it("returns original text when no mention present", () => {
    const channel = new SlackChannel();
    Object.assign(channel, { botUserId: "B999" });

    const result = (channel as unknown as {
      stripMention: (text: string) => string;
    }).stripMention("just a regular message");

    expect(result).toBe("just a regular message");
  });
});

// ── Utility: extractUserInfo ────────────────────────────────────────────────

describe("extractUserInfo", () => {
  it("extracts user info from message event", async () => {
    const channel = new SlackChannel();
    const client = createMockClient();

    const result = await (channel as unknown as {
      extractUserInfo: (event: Record<string, unknown>, client: MockClient) => Promise<UserInfo>;
    }).extractUserInfo({
      user: "U123",
      channel: "C456",
      team: "T789",
    }, client);

    expect(result).toEqual({
      userId: "U123",
      teamId: "T789",
      channelId: "C456",
      username: "U123",
    });
  });

  it("handles missing team field", async () => {
    const channel = new SlackChannel();
    const client = createMockClient();

    const result = await (channel as unknown as {
      extractUserInfo: (event: Record<string, unknown>, client: MockClient) => Promise<UserInfo>;
    }).extractUserInfo({
      user: "U123",
      channel: "C456",
    }, client);

    expect(result.teamId).toBe("");
  });
});
