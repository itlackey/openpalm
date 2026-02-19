import { describe, expect, it } from "bun:test";

type ChannelMessage = {
  userId: string;
  channel: string;
  text: string;
  nonce: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
};

function validateChannelMessage(value: unknown): value is ChannelMessage {
  if (typeof value !== "object" || value == null) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.userId === "string" && typeof rec.channel === "string" && typeof rec.text === "string" && typeof rec.nonce === "string" && typeof rec.timestamp === "number";
}

describe("contract: channel message", () => {
  it("accepts normalized channel messages", () => {
    const payload: unknown = {
      userId: "discord:1",
      channel: "discord",
      text: "hello",
      nonce: "n",
      timestamp: Date.now(),
      metadata: { guildId: "g1" }
    };
    expect(validateChannelMessage(payload)).toBe(true);
  });

  it("rejects missing required fields", () => {
    expect(validateChannelMessage({ channel: "chat" })).toBe(false);
  });
});
