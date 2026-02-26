import { describe, expect, it } from "bun:test";
import { buildIntakeCommand, parseIntakeDecision } from "./channel-intake.ts";

describe("channel intake", () => {
  it("builds an intake command with strict json instructions", () => {
    const command = buildIntakeCommand({
      userId: "chat:1",
      channel: "chat",
      text: "hello",
      metadata: {},
      nonce: "n1",
      timestamp: Date.now(),
    });

    expect(command).toContain("strict JSON");
    expect(command).toContain('"valid": boolean');
    expect(command).toContain('channel: "chat"');
    expect(command).toContain("<user_message>");
    expect(command).toContain("</user_message>");
    expect(command).toContain("hello");
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

  it("rejects empty responses and truncated json", () => {
    expect(() => parseIntakeDecision("")).toThrow();
    expect(() => parseIntakeDecision('{"valid": true, "summary": "ok"')).toThrow();
  });

  it("rejects responses missing braces", () => {
    expect(() => parseIntakeDecision('"valid":true,"summary":"ok"')).toThrow();
  });

  it("rejects double-encoded json strings", () => {
    const doubleEncoded = JSON.stringify('{"valid":true,"summary":"ok","reason":""}');
    expect(() => parseIntakeDecision(doubleEncoded)).toThrow();
  });
});
