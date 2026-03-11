/**
 * Tests for channels.ts — channel validation, discovery, install/uninstall.
 */
import { describe, test, expect, beforeEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  existsSync
} from "node:fs";
import { join } from "node:path";

import {
  discoverChannels,
  isAllowedService,
  isValidChannel,
  installChannelFromRegistry,
  uninstallChannel
} from "./channels.js";
import { CORE_SERVICES } from "./types.js";
import { REGISTRY_CHANNEL_NAMES } from "./registry.js";
import { makeTempDir, makeTestState, trackDir, registerCleanup, seedConfigChannels } from "./test-helpers.js";

registerCleanup();

// ── Channel Name Validation & Discovery ─────────────────────────────────

describe("discoverChannels", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = trackDir(makeTempDir());
  });

  test("returns empty array when channels dir does not exist", () => {
    const result = discoverChannels(configDir);
    expect(result).toEqual([]);
  });

  test("discovers .yml files as channels", () => {
    seedConfigChannels(configDir, [
      { name: "chat", yml: "services:\n  channel-chat:\n    image: chat:latest\n" }
    ]);

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("chat");
    expect(result[0].hasRoute).toBe(false);
    expect(result[0].ymlPath).toContain("chat.yml");
    expect(result[0].caddyPath).toBeNull();
  });

  test("detects hasRoute when .caddy file is present", () => {
    seedConfigChannels(configDir, [
      {
        name: "chat",
        yml: "services:\n  channel-chat:\n    image: chat:latest\n",
        caddy: "handle_path /chat/* {\n\treverse_proxy channel-chat:8080\n}\n"
      }
    ]);

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(1);
    expect(result[0].hasRoute).toBe(true);
    expect(result[0].caddyPath).toContain("chat.caddy");
  });

  test("discovers multiple channels", () => {
    seedConfigChannels(configDir, [
      { name: "chat", yml: "services:\n  channel-chat:\n    image: chat:latest\n" },
      { name: "discord", yml: "services:\n  channel-discord:\n    image: discord:latest\n" },
      { name: "api", yml: "services:\n  channel-api:\n    image: api:latest\n" }
    ]);

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(3);
    const names = result.map((c) => c.name).sort();
    expect(names).toEqual(["api", "chat", "discord"]);
  });

  test("filters out invalid channel names", () => {
    const channelsDir = join(configDir, "channels");
    mkdirSync(channelsDir, { recursive: true });
    // Invalid names: uppercase, starts with hyphen, too long, special chars
    writeFileSync(join(channelsDir, "UPPER.yml"), "services: {}");
    writeFileSync(join(channelsDir, "-leading-hyphen.yml"), "services: {}");
    writeFileSync(join(channelsDir, "has spaces.yml"), "services: {}");
    writeFileSync(join(channelsDir, "valid-name.yml"), "services: {}");

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid-name");
  });

  test("ignores non-.yml files in channels directory", () => {
    const channelsDir = join(configDir, "channels");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, "readme.md"), "# Notes");
    writeFileSync(join(channelsDir, "chat.yml"), "services: {}");
    writeFileSync(join(channelsDir, "backup.yml.bak"), "old");

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

  test("allows channel-* when staged yml exists", () => {
    const stateDir = trackDir(makeTempDir());
    const channelsDir = join(stateDir, "artifacts", "channels");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, "chat.yml"), "services: {}");

    expect(isAllowedService("channel-chat", stateDir)).toBe(true);
  });

  test("rejects channel-* when staged yml does not exist", () => {
    const stateDir = trackDir(makeTempDir());
    expect(isAllowedService("channel-chat", stateDir)).toBe(false);
  });

  test("rejects channel- with invalid channel name", () => {
    const stateDir = trackDir(makeTempDir());
    expect(isAllowedService("channel-UPPER", stateDir)).toBe(false);
    expect(isAllowedService("channel--double", stateDir)).toBe(false);
  });

  test("rejects non-core, non-channel services", () => {
    expect(isAllowedService("unknown-service")).toBe(false);
    expect(isAllowedService("nginx")).toBe(false);
  });

  test("allows ollama when staged ollama.yml exists", () => {
    const stateDir = trackDir(makeTempDir());
    const artifactsDir = join(stateDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "ollama.yml"), "services:\n  ollama:\n    image: ollama/ollama\n");

    expect(isAllowedService("ollama", stateDir)).toBe(true);
  });

  test("rejects ollama when staged ollama.yml does not exist", () => {
    const stateDir = trackDir(makeTempDir());
    expect(isAllowedService("ollama", stateDir)).toBe(false);
  });

  test("rejects ollama without stateDir", () => {
    expect(isAllowedService("ollama")).toBe(false);
  });
});

describe("isValidChannel", () => {
  test("validates channel name format (lowercase alnum + hyphens)", () => {
    const stateDir = trackDir(makeTempDir());
    const channelsDir = join(stateDir, "artifacts", "channels");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, "my-channel.yml"), "services: {}");

    expect(isValidChannel("my-channel", stateDir)).toBe(true);
  });

  test("rejects empty and whitespace", () => {
    expect(isValidChannel("")).toBe(false);
    expect(isValidChannel("  ")).toBe(false);
  });

  test("rejects invalid names even without stateDir", () => {
    expect(isValidChannel("UPPER")).toBe(false);
    expect(isValidChannel("-leading")).toBe(false);
    expect(isValidChannel("has space")).toBe(false);
  });

  test("requires stateDir to confirm staging", () => {
    // Without stateDir: format-valid but returns false (no staged file check)
    expect(isValidChannel("chat")).toBe(false);
  });

  test("rejects valid-format name if not staged", () => {
    const stateDir = trackDir(makeTempDir());
    mkdirSync(join(stateDir, "artifacts", "channels"), { recursive: true });
    expect(isValidChannel("unstaged", stateDir)).toBe(false);
  });
});

// ── Channel Install / Uninstall ─────────────────────────────────────────

describe("installChannelFromRegistry", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = trackDir(makeTempDir());
  });

  test("rejects invalid channel name", () => {
    const result = installChannelFromRegistry("INVALID", configDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid channel name");
  });

  test("rejects channel not in registry", () => {
    const result = installChannelFromRegistry("nonexistent-channel", configDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not found in registry");
  });

  test("rejects already installed channel", () => {
    // Only test if there are registry channels available
    if (REGISTRY_CHANNEL_NAMES.length === 0) return;
    const name = REGISTRY_CHANNEL_NAMES[0];
    const channelsDir = join(configDir, "channels");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, `${name}.yml`), "existing");

    const result = installChannelFromRegistry(name, configDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("already installed");
  });

  test("installs registry channel successfully", () => {
    if (REGISTRY_CHANNEL_NAMES.length === 0) return;
    const name = REGISTRY_CHANNEL_NAMES[0];

    const result = installChannelFromRegistry(name, configDir);
    expect(result.ok).toBe(true);
    expect(existsSync(join(configDir, "channels", `${name}.yml`))).toBe(true);
  });
});

describe("uninstallChannel", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = trackDir(makeTempDir());
  });

  test("rejects invalid channel name", () => {
    const result = uninstallChannel("INVALID", configDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid channel name");
  });

  test("rejects when channel is not installed", () => {
    mkdirSync(join(configDir, "channels"), { recursive: true });
    const result = uninstallChannel("chat", configDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not installed");
  });

  test("removes .yml file on uninstall", () => {
    seedConfigChannels(configDir, [
      { name: "chat", yml: "services: {}" }
    ]);

    const result = uninstallChannel("chat", configDir);
    expect(result.ok).toBe(true);
    expect(existsSync(join(configDir, "channels", "chat.yml"))).toBe(false);
  });

  test("removes both .yml and .caddy files", () => {
    seedConfigChannels(configDir, [
      {
        name: "chat",
        yml: "services: {}",
        caddy: "handle_path /chat/* { reverse_proxy channel-chat:8080 }"
      }
    ]);

    const result = uninstallChannel("chat", configDir);
    expect(result.ok).toBe(true);
    expect(existsSync(join(configDir, "channels", "chat.yml"))).toBe(false);
    expect(existsSync(join(configDir, "channels", "chat.caddy"))).toBe(false);
  });
});
