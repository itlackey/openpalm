/**
 * Tests for the 5-field cron expression parser.
 *
 * Covers: parsing, matching, validation, next-match computation,
 * edge cases (wildcards, ranges, steps, lists, day-of-week normalization).
 */
import { describe, test, expect } from "vitest";
import {
  parseCron,
  cronMatches,
  validateCronExpression,
  nextCronMatch,
  type CronFields
} from "./cron-parser.js";

// ── parseCron ──────────────────────────────────────────────────────────

describe("parseCron", () => {
  test("parses wildcard expression", () => {
    const fields = parseCron("* * * * *");
    expect(fields.minutes.size).toBe(60);
    expect(fields.hours.size).toBe(24);
    expect(fields.daysOfMonth.size).toBe(31);
    expect(fields.months.size).toBe(12);
    expect(fields.daysOfWeek.size).toBe(7);
  });

  test("parses specific values", () => {
    const fields = parseCron("0 9 15 6 3");
    expect(fields.minutes).toEqual(new Set([0]));
    expect(fields.hours).toEqual(new Set([9]));
    expect(fields.daysOfMonth).toEqual(new Set([15]));
    expect(fields.months).toEqual(new Set([6]));
    expect(fields.daysOfWeek).toEqual(new Set([3]));
  });

  test("parses ranges", () => {
    const fields = parseCron("0-5 9-17 1-15 1-6 1-5");
    expect(fields.minutes).toEqual(new Set([0, 1, 2, 3, 4, 5]));
    expect(fields.hours).toEqual(new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]));
    expect(fields.daysOfMonth).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]));
    expect(fields.months).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(fields.daysOfWeek).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  test("parses step with wildcard", () => {
    const fields = parseCron("*/15 */6 * * *");
    expect(fields.minutes).toEqual(new Set([0, 15, 30, 45]));
    expect(fields.hours).toEqual(new Set([0, 6, 12, 18]));
  });

  test("parses step with range", () => {
    const fields = parseCron("10-30/5 * * * *");
    expect(fields.minutes).toEqual(new Set([10, 15, 20, 25, 30]));
  });

  test("parses comma-separated lists", () => {
    const fields = parseCron("0,15,30,45 8,12,18 * * 1,3,5");
    expect(fields.minutes).toEqual(new Set([0, 15, 30, 45]));
    expect(fields.hours).toEqual(new Set([8, 12, 18]));
    expect(fields.daysOfWeek).toEqual(new Set([1, 3, 5]));
  });

  test("normalizes day-of-week 7 to 0 (Sunday)", () => {
    const fields = parseCron("* * * * 7");
    expect(fields.daysOfWeek).toEqual(new Set([0]));
    expect(fields.daysOfWeek.has(7)).toBe(false);
  });

  test("handles mixed list with 7 in day-of-week", () => {
    const fields = parseCron("* * * * 0,7");
    expect(fields.daysOfWeek).toEqual(new Set([0]));
  });

  test("throws on too few fields", () => {
    expect(() => parseCron("* * *")).toThrow("Expected 5 fields");
  });

  test("throws on too many fields", () => {
    expect(() => parseCron("* * * * * *")).toThrow("Expected 5 fields");
  });

  test("throws on empty string", () => {
    expect(() => parseCron("")).toThrow("Expected 5 fields");
  });

  test("throws on out-of-range minute", () => {
    expect(() => parseCron("60 * * * *")).toThrow("out of bounds");
  });

  test("throws on out-of-range hour", () => {
    expect(() => parseCron("* 24 * * *")).toThrow("out of bounds");
  });

  test("throws on out-of-range day-of-month", () => {
    expect(() => parseCron("* * 32 * *")).toThrow("out of bounds");
  });

  test("throws on out-of-range month", () => {
    expect(() => parseCron("* * * 13 *")).toThrow("out of bounds");
  });

  test("throws on out-of-range day-of-week", () => {
    expect(() => parseCron("* * * * 8")).toThrow("out of bounds");
  });

  test("throws on non-numeric value", () => {
    expect(() => parseCron("abc * * * *")).toThrow();
  });

  test("throws on invalid step", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow("Invalid step");
  });

  test("throws on reversed range", () => {
    expect(() => parseCron("30-10 * * * *")).toThrow("out of bounds");
  });
});

// ── cronMatches ────────────────────────────────────────────────────────

describe("cronMatches", () => {
  test("matches every-minute expression against any date", () => {
    const fields = parseCron("* * * * *");
    expect(cronMatches(fields, new Date("2026-03-15T10:30:00"))).toBe(true);
    expect(cronMatches(fields, new Date("2026-01-01T00:00:00"))).toBe(true);
  });

  test("matches specific time", () => {
    const fields = parseCron("30 9 * * *");
    expect(cronMatches(fields, new Date("2026-03-15T09:30:00"))).toBe(true);
    expect(cronMatches(fields, new Date("2026-03-15T09:31:00"))).toBe(false);
    expect(cronMatches(fields, new Date("2026-03-15T10:30:00"))).toBe(false);
  });

  test("matches weekday-only schedule (Mon-Fri)", () => {
    const fields = parseCron("0 9 * * 1-5");
    // 2026-03-16 is Monday
    expect(cronMatches(fields, new Date("2026-03-16T09:00:00"))).toBe(true);
    // 2026-03-15 is Sunday
    expect(cronMatches(fields, new Date("2026-03-15T09:00:00"))).toBe(false);
  });

  test("matches specific month and day", () => {
    const fields = parseCron("0 0 1 1 *");
    // Jan 1 midnight
    expect(cronMatches(fields, new Date("2026-01-01T00:00:00"))).toBe(true);
    // Feb 1 midnight
    expect(cronMatches(fields, new Date("2026-02-01T00:00:00"))).toBe(false);
  });

  test("matches every-15-minutes schedule", () => {
    const fields = parseCron("*/15 * * * *");
    expect(cronMatches(fields, new Date("2026-03-15T10:00:00"))).toBe(true);
    expect(cronMatches(fields, new Date("2026-03-15T10:15:00"))).toBe(true);
    expect(cronMatches(fields, new Date("2026-03-15T10:30:00"))).toBe(true);
    expect(cronMatches(fields, new Date("2026-03-15T10:45:00"))).toBe(true);
    expect(cronMatches(fields, new Date("2026-03-15T10:07:00"))).toBe(false);
  });
});

// ── validateCronExpression ─────────────────────────────────────────────

describe("validateCronExpression", () => {
  test("returns null for valid expressions", () => {
    expect(validateCronExpression("* * * * *")).toBeNull();
    expect(validateCronExpression("0 9 * * 1-5")).toBeNull();
    expect(validateCronExpression("*/15 * * * *")).toBeNull();
    expect(validateCronExpression("0,30 8-18 * 1-6 *")).toBeNull();
  });

  test("returns error message for invalid expressions", () => {
    expect(validateCronExpression("")).not.toBeNull();
    expect(validateCronExpression("60 * * * *")).not.toBeNull();
    expect(validateCronExpression("* * * * * *")).not.toBeNull();
    expect(validateCronExpression("abc")).not.toBeNull();
  });
});

// ── nextCronMatch ──────────────────────────────────────────────────────

describe("nextCronMatch", () => {
  test("finds next minute for every-minute cron", () => {
    const fields = parseCron("* * * * *");
    const after = new Date("2026-03-15T10:30:00");
    const next = nextCronMatch(fields, after);
    expect(next).not.toBeNull();
    expect(next!.getMinutes()).toBe(31);
    expect(next!.getHours()).toBe(10);
  });

  test("finds next occurrence for specific time", () => {
    const fields = parseCron("0 9 * * *");
    const after = new Date("2026-03-15T09:01:00");
    const next = nextCronMatch(fields, after);
    expect(next).not.toBeNull();
    // Should be 9:00 the next day
    expect(next!.getDate()).toBe(16);
    expect(next!.getHours()).toBe(9);
    expect(next!.getMinutes()).toBe(0);
  });

  test("finds next occurrence when current time matches", () => {
    const fields = parseCron("30 10 * * *");
    const after = new Date("2026-03-15T10:30:00");
    const next = nextCronMatch(fields, after);
    expect(next).not.toBeNull();
    // Should be 10:30 the next day (nextCronMatch starts from next minute)
    expect(next!.getDate()).toBe(16);
  });

  test("skips to correct month", () => {
    const fields = parseCron("0 0 1 6 *");
    const after = new Date("2026-03-15T00:00:00");
    const next = nextCronMatch(fields, after);
    expect(next).not.toBeNull();
    expect(next!.getMonth()).toBe(5); // June (0-indexed)
    expect(next!.getDate()).toBe(1);
  });

  test("returns null when no match within 2 years", () => {
    // Feb 30 never occurs
    const fields = parseCron("0 0 30 2 *");
    const after = new Date("2026-01-01T00:00:00");
    const next = nextCronMatch(fields, after);
    expect(next).toBeNull();
  });
});
