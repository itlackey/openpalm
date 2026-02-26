import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const SERVER_ENTRYPOINTS = [
  "core/gateway/src/server.ts",
  "channels/chat/server.ts",
  "channels/voice/server.ts",
  "channels/telegram/server.ts",
  "channels/discord/server.ts",
  "channels/webhook/server.ts",
  "channels/api/server.ts",
  "channels/mcp/server.ts",
  "channels/a2a/server.ts",
];

describe("graceful shutdown contract", () => {
  it("installs graceful shutdown handling in all server entrypoints", () => {
    for (const file of SERVER_ENTRYPOINTS) {
      const content = readFileSync(file, "utf8");
      expect(content.includes("installGracefulShutdown(")).toBe(true);
    }
  });

  it("cleans up nonce cache on gateway shutdown", () => {
    const content = readFileSync("core/gateway/src/server.ts", "utf8");
    expect(content.includes("nonceCache.destroy()")).toBe(true);
  });
});
