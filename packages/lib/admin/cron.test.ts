import { describe, expect, it } from "bun:test";
import { validateCron } from "./cron.ts";

describe("validateCron", () => {
  it("rejects invalid field counts", () => {
    expect(validateCron("* * * *")).toBe("cron expression must have exactly 5 fields");
  });

  it("rejects invalid characters in a field", () => {
    expect(validateCron("* * * * bad!")).not.toBeNull();
  });

  it("accepts valid wildcard expressions", () => {
    expect(validateCron("*/5 * * * *")).toBeNull();
  });

  it("accepts common schedule patterns", () => {
    expect(validateCron("0 6 * * *")).toBeNull();
    expect(validateCron("0 0 1 * *")).toBeNull();
    expect(validateCron("0 12 * * 1-5")).toBeNull();
    expect(validateCron("30 8 * * 1,3,5")).toBeNull();
  });

  it("rejects out-of-range minute values", () => {
    expect(validateCron("60 * * * *")).toContain("out of range");
    expect(validateCron("-1 * * * *")).not.toBeNull();
  });

  it("rejects out-of-range hour values", () => {
    expect(validateCron("* 24 * * *")).toContain("out of range");
  });

  it("rejects out-of-range day-of-month values", () => {
    expect(validateCron("* * 0 * *")).toContain("out of range");
    expect(validateCron("* * 32 * *")).toContain("out of range");
  });

  it("rejects out-of-range month values", () => {
    expect(validateCron("* * * 0 *")).toContain("out of range");
    expect(validateCron("* * * 13 *")).toContain("out of range");
  });

  it("rejects out-of-range day-of-week values", () => {
    expect(validateCron("* * * * 8")).toContain("out of range");
  });

  it("accepts valid day-of-week range 0-7", () => {
    expect(validateCron("* * * * 0")).toBeNull();
    expect(validateCron("* * * * 7")).toBeNull();
  });

  it("rejects invalid range where low > high", () => {
    expect(validateCron("* * * * 5-3")).toContain("out of bounds");
  });

  it("rejects step value of 0", () => {
    expect(validateCron("*/0 * * * *")).toContain("invalid step value");
  });

  it("rejects step value exceeding field range", () => {
    expect(validateCron("*/61 * * * *")).toContain("invalid step value");
    expect(validateCron("* */25 * * *")).toContain("invalid step value");
  });

  it("accepts step notation with valid ranges", () => {
    expect(validateCron("0-30/5 * * * *")).toBeNull();
    expect(validateCron("* */2 * * *")).toBeNull();
  });
});
