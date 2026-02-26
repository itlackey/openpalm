import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const TRUST_BOUNDARY_FILES = [
  "channels/chat/server.ts",
  "channels/webhook/server.ts",
  "channels/voice/server.ts",
  "packages/ui/src/lib/api.ts",
];

describe("trust-boundary typing contract", () => {
  it("does not use `any` in key request/response boundary files", () => {
    for (const file of TRUST_BOUNDARY_FILES) {
      const content = readFileSync(file, "utf8");
      expect(content.includes(": any")).toBe(false);
      expect(content.includes("<any>")).toBe(false);
      expect(content.includes("any;")).toBe(false);
    }
  });
});
