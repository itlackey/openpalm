import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const DOCKERFILES = [
  "core/admin/Dockerfile",
  "core/gateway/Dockerfile",
  "core/assistant/Dockerfile",
  "channels/chat/Dockerfile",
  "channels/voice/Dockerfile",
  "channels/telegram/Dockerfile",
  "channels/discord/Dockerfile",
  "channels/webhook/Dockerfile",
  "channels/api/Dockerfile",
  "channels/mcp/Dockerfile",
  "channels/a2a/Dockerfile",
];

describe("docker base image contract", () => {
  it("pins all Bun-based Dockerfiles to Bun 1.3.9", () => {
    for (const file of DOCKERFILES) {
      const content = readFileSync(file, "utf8");
      expect(content).toContain("FROM oven/bun:1.3.9");
    }
  });
});
