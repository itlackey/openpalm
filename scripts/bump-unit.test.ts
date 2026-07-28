import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  assertVersionExceedsAnchors,
  highestVersion,
  localUnitAnchorVersions,
} from "./bump-unit.mjs";

const ROOT = join(import.meta.dir, "..");

describe("release unit anchors", () => {
  test("the all-unit local anchor set includes every independent version line", () => {
    expect(Object.keys(localUnitAnchorVersions()).sort()).toEqual([
      "assistant",
      "electron",
      "guardian",
      "platform",
      "portals",
    ]);
  });

  test("the highest local unit wins even when Assistant or Electron is ahead", () => {
    expect(highestVersion(["1.2.0", "1.4.0", "1.3.9"])).toBe("1.4.0");
    expect(
      highestVersion(["1.4.0", "1.4.1-rc.1", "1.4.1"]),
    ).toBe("1.4.1");
  });

  test("an explicit all-unit target must exceed every local unit anchor", () => {
    const anchors = {
      platform: "1.2.0",
      portals: "1.2.1",
      guardian: "1.2.0",
      assistant: "1.3.0",
      electron: "1.4.0",
    };
    expect(() => assertVersionExceedsAnchors("1.3.1", anchors)).toThrow(
      "electron anchor 1.4.0",
    );
    expect(() => assertVersionExceedsAnchors("1.4.0", anchors)).toThrow(
      "electron anchor 1.4.0",
    );
    expect(() => assertVersionExceedsAnchors("1.4.1", anchors)).not.toThrow();
  });
});

describe("release target validation", () => {
  test.each(["assistant", "images"])(
    "unit=%s rejects shell-bearing explicit versions before stamping",
    (unit) => {
      const result = spawnSync(process.execPath, ["scripts/bump-unit.mjs"], {
        cwd: ROOT,
        env: {
          ...process.env,
          UNIT: unit,
          STAMP: "false",
          VERSION_OVERRIDE: "1.2.3-$(id)",
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Cannot parse VERSION_OVERRIDE");
    },
  );
});
