/**
 * Tests for portals.ts — portal marker recognition (#490).
 *
 * Pins the removal of the deprecated `CHANNEL_NAME` compose marker: only
 * `PORTAL_NAME` should be recognized for portal discovery/validation going
 * forward. Mirrors the temp-home layout idiom from
 * `packages/ui/src/lib/server/portals.vitest.ts` (managed compose in
 * `<home>/system/stack/`, custom overlay in `<home>/config/stack/`), ported
 * to `bun:test` + `mkdtempSync(join(tmpdir(), ...))` as used throughout the
 * lib suite (e.g. `lifecycle.rollback.test.ts`).
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverPortals, isPortalAddon } from "./portals.js";

function writeStackCompose(homeDir: string, filename: string, yml: string): void {
  const stackDir = filename === "custom.compose.yml"
    ? join(homeDir, "config", "stack")
    : join(homeDir, "system", "stack");
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(join(stackDir, filename), yml);
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "openpalm-portals-marker-"));
}

describe("isPortalAddon — CHANNEL_NAME marker removal", () => {
  test("returns false for a service carrying only CHANNEL_NAME (map form)", () => {
    const home = tempHome();
    const composePath = join(home, "legacy.compose.yml");
    writeFileSync(
      composePath,
      "services:\n  legacy:\n    environment:\n      CHANNEL_NAME: Legacy\n",
    );

    expect(isPortalAddon(composePath)).toBe(false);
  });

  test("returns false for CHANNEL_NAME in list form", () => {
    const home = tempHome();
    const composePath = join(home, "legacy-list.compose.yml");
    writeFileSync(
      composePath,
      "services:\n  legacy:\n    environment:\n      - CHANNEL_NAME=legacy\n",
    );

    expect(isPortalAddon(composePath)).toBe(false);
  });
});

describe("discoverPortals — CHANNEL_NAME marker removal", () => {
  test("does not discover a CHANNEL_NAME-only service", () => {
    const homeDir = tempHome();
    const configDir = join(homeDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeStackCompose(
      homeDir,
      "portals.compose.yml",
      "services:\n  legacy:\n    environment:\n      CHANNEL_NAME: Legacy\n  chat:\n    environment:\n      PORTAL_NAME: Chat\n",
    );

    const result = discoverPortals(configDir);
    const names = result.map((p) => p.name);
    expect(names).not.toContain("legacy");
    expect(names).toEqual(["chat"]);
  });

  // Positive control — must pass BOTH before and after the implementation
  // change. Guards against over-removal (accidentally dropping PORTAL_NAME
  // recognition alongside CHANNEL_NAME).
  test("still discovers PORTAL_NAME services (positive control)", () => {
    const homeDir = tempHome();
    const configDir = join(homeDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeStackCompose(
      homeDir,
      "portals.compose.yml",
      "services:\n  chat:\n    environment:\n      PORTAL_NAME: Chat\n",
    );

    const result = discoverPortals(configDir);
    expect(result.map((p) => p.name)).toEqual(["chat"]);
  });
});
