/**
 * Tests for channels.ts — channel validation and discovery.
 */
import { describe, test, expect, beforeEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  discoverChannels,
  isAllowedService,
  isValidChannel,
} from "@openpalm/lib";
import { CORE_SERVICES } from "@openpalm/lib";
import { makeTempDir, trackDir, registerCleanup } from "./test-helpers.js";

registerCleanup();

function writeStackCompose(homeDir: string, filename: string, yml: string): void {
  const stackDir = join(homeDir, "config", "stack");
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(join(stackDir, filename), yml);
}

// ── Channel Name Validation & Discovery ─────────────────────────────────

describe("discoverChannels", () => {
  let homeDir: string;
  let configDir: string;

  beforeEach(() => {
    homeDir = trackDir(makeTempDir());
    configDir = join(homeDir, "config");
    mkdirSync(configDir, { recursive: true });
  });

  test("returns empty array when no fixed channel compose exists", () => {
    const result = discoverChannels(configDir);
    expect(result).toEqual([]);
  });

  test("discovers channel services (those with CHANNEL_NAME)", () => {
    writeStackCompose(homeDir, "channels.compose.yml", "services:\n  chat:\n    environment:\n      CHANNEL_NAME: Chat\n");

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("chat");
    expect(result[0].ymlPath).toContain("compose.yml");
  });

  test("discovers multiple channels", () => {
    writeStackCompose(homeDir, "channels.compose.yml", "services:\n  chat:\n    environment:\n      CHANNEL_NAME: Chat\n  discord:\n    environment:\n      CHANNEL_NAME: Discord\n  api:\n    environment:\n      CHANNEL_NAME: API\n");

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(3);
    const names = result.map((c) => c.name).sort();
    expect(names).toEqual(["api", "chat", "discord"]);
  });

  test("excludes non-channel addons (no CHANNEL_NAME)", () => {
    writeStackCompose(homeDir, "channels.compose.yml", "services:\n  admin:\n    image: admin:latest\n  chat:\n    environment:\n      CHANNEL_NAME: Chat\n");

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("chat");
  });

  test("filters out invalid channel names", () => {
    writeStackCompose(homeDir, "channels.compose.yml", "services:\n  UPPER:\n    environment:\n      CHANNEL_NAME: X\n  -leading-hyphen:\n    environment:\n      CHANNEL_NAME: X\n  valid-name:\n    environment:\n      CHANNEL_NAME: Valid\n");

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid-name");
  });

  test("ignores fixed compose files without channels", () => {
    writeStackCompose(homeDir, "services.compose.yml", "services:\n  ollama:\n    image: ollama/ollama\n");
    writeStackCompose(homeDir, "channels.compose.yml", "services:\n  chat:\n    environment:\n      CHANNEL_NAME: Chat\n");

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("chat");
  });
});

// ── Allowlist & Validation Functions ────────────────────────────────────

describe("isAllowedService", () => {
  test("allows all core services", () => {
    for (const service of CORE_SERVICES) {
      expect(isAllowedService(service)).toBe(true);
    }
  });

  test("rejects empty string", () => {
    expect(isAllowedService("")).toBe(false);
  });

  test("rejects whitespace-only string", () => {
    expect(isAllowedService("   ")).toBe(false);
  });

  test("rejects uppercase service names (case-sensitive per doc)", () => {
    expect(isAllowedService("Admin")).toBe(false);
    expect(isAllowedService("GUARDIAN")).toBe(false);
  });

  test("allows service defined in fixed compose file", () => {
    const homeDir = trackDir(makeTempDir());
    const configDir = join(homeDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeStackCompose(homeDir, "channels.compose.yml", "services:\n  chat:\n    image: chat:latest\n");

    // Service name found in compose content
    expect(isAllowedService("chat", configDir)).toBe(true);
    // Service not defined in any compose file
    expect(isAllowedService("unknown", configDir)).toBe(false);
  });

  test("rejects service when stack addon does not exist", () => {
    const homeDir = trackDir(makeTempDir());
    const configDir = join(homeDir, "config");
    mkdirSync(configDir, { recursive: true });
    expect(isAllowedService("chat", configDir)).toBe(false);
  });

  test("rejects non-core, non-channel services", () => {
    expect(isAllowedService("unknown-service")).toBe(false);
    expect(isAllowedService("nginx")).toBe(false);
  });

  test("allows ollama when services.compose.yml defines it", () => {
    const homeDir = trackDir(makeTempDir());
    const configDir = join(homeDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeStackCompose(homeDir, "services.compose.yml", "services:\n  ollama:\n    image: ollama/ollama\n");

    expect(isAllowedService("ollama", configDir)).toBe(true);
  });

  test("rejects ollama when stack addon does not exist", () => {
    const homeDir = trackDir(makeTempDir());
    const configDir = join(homeDir, "config");
    mkdirSync(configDir, { recursive: true });
    expect(isAllowedService("ollama", configDir)).toBe(false);
  });

  test("rejects ollama without configDir", () => {
    expect(isAllowedService("ollama")).toBe(false);
  });
});

describe("isValidChannel", () => {
  test("validates channel name format (lowercase alnum + hyphens)", () => {
    const homeDir = trackDir(makeTempDir());
    const configDir = join(homeDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeStackCompose(homeDir, "custom.compose.yml", "services:\n  my-channel:\n    environment:\n      CHANNEL_NAME: Custom\n");

    expect(isValidChannel("my-channel", configDir)).toBe(true);
  });

  test("rejects empty and whitespace", () => {
    expect(isValidChannel("")).toBe(false);
    expect(isValidChannel("  ")).toBe(false);
  });

  test("rejects invalid names even without configDir", () => {
    expect(isValidChannel("UPPER")).toBe(false);
    expect(isValidChannel("-leading")).toBe(false);
    expect(isValidChannel("has space")).toBe(false);
  });

  test("requires configDir to confirm addon overlay", () => {
    // Without configDir: format-valid but returns false (no overlay check)
    expect(isValidChannel("chat")).toBe(false);
  });

  test("rejects valid-format name if not installed as addon", () => {
    const homeDir = trackDir(makeTempDir());
    const configDir = join(homeDir, "config");
    mkdirSync(configDir, { recursive: true });
    expect(isValidChannel("unstaged", configDir)).toBe(false);
  });
});
