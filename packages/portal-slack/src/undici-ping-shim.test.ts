import { beforeEach, describe, expect, it } from "bun:test";
import { dirname } from "node:path";
import { ensureUndiciPing } from "./undici-ping-shim.ts";

// Same object @slack/socket-mode's own `require("undici")` resolves to (see
// undici-ping-shim.ts) — `import * as undici` would be a different,
// non-writable object under Bun and would not observe the shim's patch.
const undici = require("undici") as { ping?: (ws: Record<string, unknown>, data?: unknown) => void };

// openpalm#665 — reproduces and fixes the real @slack/socket-mode@3.0.0
// keepalive crash by driving its actual (unexported, internal) SlackWebSocket
// ping-monitor loop, the exact code that throws in production:
//   (0, undici_1.ping)(this.websocket, Buffer.from(pingMessage))
//
// Resolved relative to the installed @slack/bolt (portal-slack's real
// dependency) rather than pinned to a node_modules layout, so it exercises
// whatever socket-mode version bolt actually ships.
function loadSlackWebSocket(): { new (opts: Record<string, unknown>): SlackWebSocketInstance } {
  const boltEntry = require.resolve("@slack/bolt");
  const path = require.resolve("@slack/socket-mode/dist/src/SlackWebSocket.js", {
    paths: [dirname(boltEntry)],
  });
  const mod = require(path) as { SlackWebSocket: new (opts: Record<string, unknown>) => SlackWebSocketInstance };
  return mod.SlackWebSocket;
}

type SlackWebSocketInstance = {
  websocket: unknown;
  monitorPingToSlack(): void;
  cleanup(): void;
};

type FakeLogger = {
  debug: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

function fakeLogger(): { logger: FakeLogger; calls: Array<{ level: string; msg: string }> } {
  const calls: Array<{ level: string; msg: string }> = [];
  const record = (level: string) => (msg: string) => {
    calls.push({ level, msg });
  };
  return { calls, logger: { debug: record("debug"), warn: record("warn"), error: record("error") } };
}

function fakeSlackSocket(withPing: boolean): { socket: Record<string, unknown>; pingCalls: unknown[] } {
  const pingCalls: unknown[] = [];
  const socket: Record<string, unknown> = {
    readyState: 1, // OPEN
    close: () => {},
  };
  if (withPing) {
    // Bun's native WebSocket instance method (see undici-ping-shim.ts).
    socket.ping = (data?: unknown) => pingCalls.push(data);
  }
  return { socket, pingCalls };
}

async function runKeepaliveTick(ws: SlackWebSocketInstance, socket: unknown): Promise<void> {
  ws.websocket = socket;
  ws.monitorPingToSlack();
  await new Promise((resolve) => setTimeout(resolve, 60));
  ws.cleanup();
}

beforeEach(() => {
  // Every test controls its own patched/unpatched state explicitly.
  delete undici.ping;
});

describe("undici.ping under Bun (openpalm#665 root cause)", () => {
  it("Bun's undici has no standalone ping export", () => {
    expect(typeof undici.ping).toBe("undefined");
  });
});

describe("SlackWebSocket keepalive (openpalm#665)", () => {
  it("reproduces the shipped crash without the shim: ping throws, connection is torn down", async () => {
    const SlackWebSocket = loadSlackWebSocket();
    const { logger, calls } = fakeLogger();
    const ws = new SlackWebSocket({
      url: "wss://example.invalid",
      client: { emit: () => {} },
      logger,
      clientPingTimeoutMS: 15,
    });
    const { socket, pingCalls } = fakeSlackSocket(false);

    await runKeepaliveTick(ws, socket);

    expect(pingCalls).toEqual([]);
    expect(
      calls.some(
        (c) => c.level === "error" && /Failed to send ping to Slack/.test(c.msg) && /undici_1\.ping.*is not a function/.test(c.msg),
      ),
    ).toBe(true);
  });

  it("ensureUndiciPing fixes it: the ping-monitor loop delivers pings via the socket's own ping()", async () => {
    ensureUndiciPing();
    const SlackWebSocket = loadSlackWebSocket();
    const { logger, calls } = fakeLogger();
    const ws = new SlackWebSocket({
      url: "wss://example.invalid",
      client: { emit: () => {} },
      logger,
      clientPingTimeoutMS: 15,
    });
    const { socket, pingCalls } = fakeSlackSocket(true);

    await runKeepaliveTick(ws, socket);

    expect(pingCalls.length).toBeGreaterThan(0);
    expect(pingCalls[0]).toBeInstanceOf(Buffer);
    expect(calls.some((c) => c.level === "error")).toBe(false);
  });
});

describe("ensureUndiciPing", () => {
  it("does not overwrite an existing ping implementation (a real Node/undici runtime)", () => {
    const existing = () => {};
    undici.ping = existing;
    ensureUndiciPing();
    expect(undici.ping).toBe(existing);
  });

  it("raises a clear error rather than silently doing nothing when the socket has no ping() at all", () => {
    ensureUndiciPing();
    expect(() => undici.ping?.({}, Buffer.from("x"))).toThrow(/ping\(\) method/);
  });
});
