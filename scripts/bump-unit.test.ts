import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("release target validation", () => {
  test("rejects shell-bearing explicit versions before stamping", () => {
    const result = spawnSync(process.execPath, ["scripts/bump-unit.mjs"], {
      cwd: ROOT,
      env: {
        ...process.env,
        UNIT: "platform",
        STAMP: "false",
        VERSION: "1.2.3-$(id)",
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot parse VERSION");
  });
});
