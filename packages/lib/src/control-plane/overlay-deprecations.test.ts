/**
 * Tests for overlay-deprecations.ts (#490) — NEW module, does not exist yet.
 *
 * All cases here fail pre-implementation with an import error (the module
 * `overlay-deprecations.ts` does not exist), which is the intended red-phase
 * failure per the spec (module spec § 3.2).
 *
 * Pure-function tests, no mocks.
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanComposeForChannelLan, checkCustomComposeChannelLan } from "./overlay-deprecations.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "openpalm-overlay-deprecations-"));
}

function writeCustomCompose(homeDir: string, yml: string): void {
  const stackDir = join(homeDir, "config", "stack");
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(join(stackDir, "custom.compose.yml"), yml);
}

describe("scanComposeForChannelLan", () => {
  test("flags a service referencing channel_lan (list form)", () => {
    const content = "services:\n  x:\n    networks:\n      - channel_lan\n";
    const result = scanComposeForChannelLan(content);
    expect(result.referencedBy).toEqual(["x"]);
    expect(result.definesNetwork).toBe(false);
  });

  test("flags a service referencing channel_lan (map form)", () => {
    const content = "services:\n  x:\n    networks:\n      channel_lan: {}\n";
    const result = scanComposeForChannelLan(content);
    expect(result.referencedBy).toEqual(["x"]);
  });

  test("reports a top-level channel_lan definition", () => {
    const content = "networks:\n  channel_lan: null\n";
    const result = scanComposeForChannelLan(content);
    expect(result.definesNetwork).toBe(true);
  });

  test("returns empty scan for portal_net-only compose", () => {
    const content = "services:\n  x:\n    networks:\n      - portal_net\nnetworks:\n  portal_net: null\n";
    const result = scanComposeForChannelLan(content);
    expect(result).toEqual({ referencedBy: [], definesNetwork: false });
  });

  test("returns empty scan for unparseable YAML", () => {
    // The scan is advisory, not a security boundary — compose preflight still
    // catches genuinely broken YAML. Fail-open here is deliberate.
    const content = "services:\n  x:\n  :::not valid yaml:::\n\t- [unterminated";
    const result = scanComposeForChannelLan(content);
    expect(result).toEqual({ referencedBy: [], definesNetwork: false });
  });
});

describe("checkCustomComposeChannelLan", () => {
  test("returns no findings when custom.compose.yml is absent", () => {
    const homeDir = tempHome();
    const result = checkCustomComposeChannelLan(homeDir);
    expect(result).toEqual({ blockError: null, warning: null });
  });

  test("blocks when channel_lan is referenced but not defined", () => {
    const homeDir = tempHome();
    writeCustomCompose(
      homeDir,
      "services:\n  myservice:\n    image: example:latest\n    networks:\n      - channel_lan\n",
    );

    const result = checkCustomComposeChannelLan(homeDir);
    expect(result.blockError).not.toBeNull();
    expect(result.blockError).toContain("myservice");
    expect(result.blockError).toContain(join(homeDir, "config", "stack", "custom.compose.yml"));
    expect(result.blockError).toContain("portal_net");
    expect(result.blockError?.toLowerCase()).toContain("nothing was changed");
  });

  test("warns (not blocks) when the overlay defines channel_lan itself", () => {
    const homeDir = tempHome();
    writeCustomCompose(
      homeDir,
      "services:\n  myservice:\n    image: example:latest\n    networks:\n      - channel_lan\nnetworks:\n  channel_lan: {}\n",
    );

    const result = checkCustomComposeChannelLan(homeDir);
    expect(result.blockError).toBeNull();
    expect(result.warning).not.toBeNull();
    expect(result.warning).toContain("portal_net");
  });
});
