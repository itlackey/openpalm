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

  const outOfRangeCases: [string, string[]][] = [
    ["minute", ["60 * * * *"]],
    ["hour", ["* 24 * * *"]],
    ["day-of-month", ["* * 0 * *", "* * 32 * *"]],
    ["month", ["* * * 0 *", "* * * 13 *"]],
    ["day-of-week", ["* * * * 8"]],
  ];

  for (const [field, expressions] of outOfRangeCases) {
    it(`rejects out-of-range ${field} values`, () => {
      for (const expr of expressions) {
        expect(validateCron(expr)).toContain("out of range");
      }
    });
  }

  it("rejects negative minute values", () => {
    expect(validateCron("-1 * * * *")).not.toBeNull();
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
