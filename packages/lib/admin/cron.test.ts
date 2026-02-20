import { describe, expect, it } from "bun:test";
import { validateCron } from "./cron.ts";

describe("validateCron", () => {
  it("rejects invalid field counts", () => {
    expect(validateCron("* * * *")).toBe("cron expression must have exactly 5 fields");
  });

  it("rejects invalid characters", () => {
    expect(validateCron("* * * * bad!")).toContain("invalid characters");
  });

  it("accepts valid expressions", () => {
    expect(validateCron("*/5 * * * *")).toBeNull();
  });
});
