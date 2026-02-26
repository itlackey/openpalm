import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const CHANNEL_SERVERS = [
  "channels/chat/server.ts",
  "channels/voice/server.ts",
  "channels/telegram/server.ts",
  "channels/discord/server.ts",
  "channels/webhook/server.ts",
  "channels/api/server.ts",
  "channels/mcp/server.ts",
  "channels/a2a/server.ts",
];

describe("channel server export contract", () => {
  it("does not re-export signPayload from production server modules", () => {
    for (const file of CHANNEL_SERVERS) {
      const content = readFileSync(file, "utf8");
      expect(content.includes("export { signPayload }")).toBe(false);
      expect(content.includes("import { signPayload }")).toBe(false);
    }
  });
});
