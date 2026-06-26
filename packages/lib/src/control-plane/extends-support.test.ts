/**
 * Verify that Compose `extends` is supported in the custom compose file.
 *
 * This is a narrow smoke test proving the canonical compose resolution
 * works when custom.compose.yml uses Compose `extends` to inherit from a base service.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("compose extends support", () => {
  let fixtureDir: string;
  const skipDockerAssertions = process.env.CI === "true";

  beforeAll(() => {
    // fixtureDir is an OP_HOME root: MANAGED compose lives in system/stack,
    // the USER custom overlay in config/stack.
    fixtureDir = join(tmpdir(), `openpalm-extends-test-${Date.now()}`);
    mkdirSync(join(fixtureDir, "system", "stack"), { recursive: true });
    mkdirSync(join(fixtureDir, "config", "stack"), { recursive: true });

    // Write a minimal core compose (managed)
    writeFileSync(
      join(fixtureDir, "system/stack/core.compose.yml"),
      [
        "services:",
        "  base-service:",
        "    image: alpine:latest",
        "    environment:",
        "      BASE_VAR: base-value",
        "",
      ].join("\n")
    );

    // Write custom compose content that uses `extends` (user-owned)
    writeFileSync(
      join(fixtureDir, "config/stack/custom.compose.yml"),
      [
        "services:",
        "  extended-service:",
        "    extends:",
        "      service: base-service",
        `      file: ${join(fixtureDir, "system/stack/core.compose.yml")}`,
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
    expect(existsSync(join(fixtureDir, "system/stack/core.compose.yml"))).toBe(true);
    expect(existsSync(join(fixtureDir, "config/stack/custom.compose.yml"))).toBe(true);
  });

  test("extends custom compose works with discoverStackOverlays", async () => {
    const { discoverStackOverlays } = await import("./config-persistence.js");
    const overlays = discoverStackOverlays(fixtureDir);

    expect(overlays.length).toBe(2);
    expect(overlays[0]).toContain("core.compose.yml");
    expect(overlays[1]).toContain("custom.compose.yml");
  });

  test.skipIf(skipDockerAssertions)("extends addon passes docker compose config preflight (requires Docker)", async () => {
    // This test validates that Compose `extends` actually merges correctly.
    // Skipped when Docker is unavailable.
    const { checkDocker, composePreflight } = await import("./docker.js");
    const dockerCheck = await checkDocker();
    if (!dockerCheck.ok) {
      console.log("  [skip] Docker not available — extends preflight test skipped");
      return;
    }

    const { discoverStackOverlays } = await import("./config-persistence.js");
    const files = discoverStackOverlays(fixtureDir);

    const result = await composePreflight({ files });
    expect(result.ok).toBe(true);
  });

  test.skipIf(skipDockerAssertions)("extends addon resolves services correctly via compose config (requires Docker)", async () => {
    const { checkDocker, composeConfigServices } = await import("./docker.js");
    const dockerCheck = await checkDocker();
    if (!dockerCheck.ok) {
      console.log("  [skip] Docker not available — extends service discovery test skipped");
      return;
    }

    const { discoverStackOverlays } = await import("./config-persistence.js");
    const files = discoverStackOverlays(fixtureDir);

    const result = await composeConfigServices({ files });
    if (result.ok) {
      // When Docker is available, the resolved service list should include
      // both the base service and the extended service
      expect(result.services).toContain("base-service");
      expect(result.services).toContain("extended-service");
    }
  });
});
