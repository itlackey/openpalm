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
} from "./channels.js";
import { CORE_SERVICES } from "./types.js";
import { makeTempDir, trackDir, registerCleanup } from "./test-helpers.js";

registerCleanup();

/**
 * Seed channel addon files in stack/addons/<name>/compose.yml.
 * homeDir is the openpalm home (parent of config/). configDir = join(homeDir, "config").
 */
function seedChannelAddons(
  homeDir: string,
  channels: { name: string; yml: string }[]
): void {
  for (const ch of channels) {
    const addonDir = join(homeDir, "stack", "addons", ch.name);
    mkdirSync(addonDir, { recursive: true });
    writeFileSync(join(addonDir, "compose.yml"), ch.yml);
  }
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

  test("returns empty array when stack/addons dir does not exist", () => {
    const result = discoverChannels(configDir);
    expect(result).toEqual([]);
  });

  test("discovers channel addons (those with CHANNEL_NAME)", () => {
    seedChannelAddons(homeDir, [
      { name: "chat", yml: "services:\n  chat:\n    environment:\n      CHANNEL_NAME: Chat\n      GUARDIAN_URL: http://guardian:8080\n" }
    ]);

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("chat");
    expect(result[0].ymlPath).toContain("compose.yml");
  });

  test("discovers multiple channels", () => {
    seedChannelAddons(homeDir, [
      { name: "chat", yml: "services:\n  chat:\n    environment:\n      CHANNEL_NAME: Chat\n      GUARDIAN_URL: http://guardian:8080\n" },
      { name: "discord", yml: "services:\n  discord:\n    environment:\n      CHANNEL_NAME: Discord\n      GUARDIAN_URL: http://guardian:8080\n" },
      { name: "api", yml: "services:\n  api:\n    environment:\n      CHANNEL_NAME: API\n      GUARDIAN_URL: http://guardian:8080\n" }
    ]);

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(3);
    const names = result.map((c) => c.name).sort();
    expect(names).toEqual(["api", "chat", "discord"]);
  });

  test("excludes non-channel addons (no CHANNEL_NAME)", () => {
    seedChannelAddons(homeDir, [
      { name: "admin", yml: "services:\n  admin:\n    image: admin:latest\n" },
      { name: "chat", yml: "services:\n  chat:\n    environment:\n      CHANNEL_NAME: Chat\n" }
    ]);

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("chat");
  });

  test("filters out invalid channel names", () => {
    const addonsDir = join(homeDir, "stack", "addons");
    // Invalid: uppercase
    const upperDir = join(addonsDir, "UPPER");
    mkdirSync(upperDir, { recursive: true });
    writeFileSync(join(upperDir, "compose.yml"), "services:\n  x:\n    environment:\n      CHANNEL_NAME: X\n");
    // Invalid: starts with hyphen
    const leadingHyphenDir = join(addonsDir, "-leading-hyphen");
    mkdirSync(leadingHyphenDir, { recursive: true });
    writeFileSync(join(leadingHyphenDir, "compose.yml"), "services:\n  x:\n    environment:\n      CHANNEL_NAME: X\n");
    // Valid
    seedChannelAddons(homeDir, [
      { name: "valid-name", yml: "services:\n  valid-name:\n    environment:\n      CHANNEL_NAME: Valid\n" }
    ]);

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid-name");
  });

  test("ignores addon dirs without compose.yml", () => {
    const addonsDir = join(homeDir, "stack", "addons");
    mkdirSync(join(addonsDir, "no-compose"), { recursive: true });
    seedChannelAddons(homeDir, [
      { name: "chat", yml: "services:\n  chat:\n    environment:\n      CHANNEL_NAME: Chat\n" }
    ]);

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

  test("allows service defined in addon compose.yml", () => {
    const homeDir = trackDir(makeTempDir());
    const configDir = join(homeDir, "config");
    mkdirSync(configDir, { recursive: true });
    seedChannelAddons(homeDir, [
      { name: "chat", yml: "services:\n  chat:\n    image: chat:latest\n" }
    ]);

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

  test("allows ollama when stack/addons/ollama/compose.yml exists", () => {
    const homeDir = trackDir(makeTempDir());
    const configDir = join(homeDir, "config");
    mkdirSync(configDir, { recursive: true });
    const ollamaDir = join(homeDir, "stack", "addons", "ollama");
    mkdirSync(ollamaDir, { recursive: true });
    writeFileSync(join(ollamaDir, "compose.yml"), "services:\n  ollama:\n    image: ollama/ollama\n");

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
    seedChannelAddons(homeDir, [
      { name: "my-channel", yml: "services: {}" }
    ]);

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
