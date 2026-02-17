import { describe, expect, it } from "bun:test";
import { buildIntakeCommand, parseIntakeDecision } from "./channel-intake.ts";

describe("channel intake", () => {
  it("builds an intake command with strict json instructions", () => {
    const command = buildIntakeCommand({
      userId: "discord:1",
      channel: "discord",
      text: "hello",
      metadata: { guildId: "g1" },
      nonce: "n1",
      timestamp: Date.now(),
    });

    expect(command).toContain("strict JSON");
    expect(command).toContain('"valid": boolean');
    expect(command).toContain('"channel":"discord"');
  });

  it("parses valid JSON decisions", () => {
    const decision = parseIntakeDecision('{"valid":true,"summary":"help with setup","reason":""}');
    expect(decision.valid).toBe(true);
    expect(decision.summary).toBe("help with setup");
  });

  it("rejects valid decisions without summary", () => {
    expect(() => parseIntakeDecision('{"valid":true,"summary":" ","reason":""}')).toThrow(
      "missing_summary_for_valid_intake"
    );
  });

  it("parses decisions wrapped in extra text", () => {
    const decision = parseIntakeDecision('Result: {"valid":false,"summary":"","reason":"unsafe"} done');
    expect(decision.valid).toBe(false);
    expect(decision.reason).toBe("unsafe");
  });
});
