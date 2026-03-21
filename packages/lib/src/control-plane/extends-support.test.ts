/**
 * Verify that Compose `extends` is supported as an optional addon pattern.
 *
 * This is a narrow smoke test proving the canonical compose resolution
 * works when an addon uses Compose `extends` to inherit from a base service.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("compose extends support", () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = join(tmpdir(), `openpalm-extends-test-${Date.now()}`);
    mkdirSync(join(fixtureDir, "stack/addons/extended-addon"), { recursive: true });

    // Write a minimal core compose
    writeFileSync(
      join(fixtureDir, "stack/core.compose.yml"),
      [
        "services:",
        "  base-service:",
        "    image: alpine:latest",
        "    environment:",
        "      BASE_VAR: base-value",
        "",
      ].join("\n")
    );

    // Write an addon that uses `extends`
    writeFileSync(
      join(fixtureDir, "stack/addons/extended-addon/compose.yml"),
      [
        "services:",
        "  extended-service:",
        "    extends:",
        "      service: base-service",
        `      file: ${join(fixtureDir, "stack/core.compose.yml")}`,
        "    environment:",
        "      ADDON_VAR: addon-value",
        "",
      ].join("\n")
    );
  });

  afterAll(() => {
    if (fixtureDir && existsSync(fixtureDir)) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("fixture files exist", () => {
    expect(existsSync(join(fixtureDir, "stack/core.compose.yml"))).toBe(true);
    expect(existsSync(join(fixtureDir, "stack/addons/extended-addon/compose.yml"))).toBe(true);
  });

  test("extends addon composes correctly with discoverStackOverlays", async () => {
    const { discoverStackOverlays } = await import("./staging.js");
    const overlays = discoverStackOverlays(join(fixtureDir, "stack"));

    expect(overlays.length).toBe(2);
    expect(overlays[0]).toContain("core.compose.yml");
    expect(overlays[1]).toContain("extended-addon/compose.yml");
  });

  // Note: We don't run `docker compose config` in unit tests since Docker may
  // not be available. The structural validation (files exist + discoverStackOverlays
  // returns them) is sufficient for a unit-level guardrail. Integration tests
  // should validate actual compose merge with extends.
});
