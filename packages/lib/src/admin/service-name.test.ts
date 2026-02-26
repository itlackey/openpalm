import { describe, expect, it } from "bun:test";
import { composeServiceName } from "./service-name.ts";

describe("composeServiceName", () => {
  it("normalizes names to lowercase service-safe identifiers", () => {
    expect(composeServiceName("  My Service  ")).toBe("my-service");
  });

  it("preserves dashes and underscores", () => {
    expect(composeServiceName("channel_api-v2")).toBe("channel_api-v2");
  });

  it("replaces unsupported characters with dashes", () => {
    expect(composeServiceName("discord/bot@prod")).toBe("discord-bot-prod");
  });
});
