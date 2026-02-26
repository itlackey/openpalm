import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("compose runner path contract", () => {
  it("uses shared root compose runner from both lib and admin wrappers", () => {
    const composeLib = readFileSync("packages/lib/src/compose.ts", "utf8");
    const composeAdmin = readFileSync("packages/lib/src/admin/compose-runner.ts", "utf8");

    expect(composeLib.includes('from "./compose-runner.ts"')).toBe(true);
    expect(composeAdmin.includes('from "../compose-runner.ts"')).toBe(true);
  });
});
