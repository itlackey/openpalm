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
import { makeTempDir, makeTestState, trackDir, registerCleanup } from "./test-helpers.js";

registerCleanup();

/** Seed channel overlay files in config/components/ (the new layout). */
function seedChannelComponents(
  configDir: string,
  channels: { name: string; yml: string; caddy?: string }[]
): void {
  const componentsDir = join(configDir, "components");
  mkdirSync(componentsDir, { recursive: true });
  for (const ch of channels) {
    writeFileSync(join(componentsDir, `channel-${ch.name}.yml`), ch.yml);
    if (ch.caddy) {
      writeFileSync(join(componentsDir, `channel-${ch.name}.caddy`), ch.caddy);
    }
  }
}

// ── Channel Name Validation & Discovery ─────────────────────────────────

describe("discoverChannels", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = trackDir(makeTempDir());
  });

  test("returns empty array when components dir does not exist", () => {
    const result = discoverChannels(configDir);
    expect(result).toEqual([]);
  });

  test("discovers channel-*.yml files as channels", () => {
    seedChannelComponents(configDir, [
      { name: "chat", yml: "services:\n  channel-chat:\n    image: chat:latest\n" }
    ]);

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("chat");
    expect(result[0].hasRoute).toBe(false);
    expect(result[0].ymlPath).toContain("channel-chat.yml");
    expect(result[0].caddyPath).toBeNull();
  });

  test("detects hasRoute when .caddy file is present", () => {
    seedChannelComponents(configDir, [
      {
        name: "chat",
        yml: "services:\n  channel-chat:\n    image: chat:latest\n",
        caddy: "handle_path /chat/* {\n\treverse_proxy channel-chat:8080\n}\n"
      }
    ]);

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(1);
    expect(result[0].hasRoute).toBe(true);
    expect(result[0].caddyPath).toContain("channel-chat.caddy");
  });

  test("discovers multiple channels", () => {
    seedChannelComponents(configDir, [
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
    const componentsDir = join(configDir, "components");
    mkdirSync(componentsDir, { recursive: true });
    // Invalid names: uppercase, starts with hyphen, too long, special chars
    writeFileSync(join(componentsDir, "channel-UPPER.yml"), "services: {}");
    writeFileSync(join(componentsDir, "channel--leading-hyphen.yml"), "services: {}");
    writeFileSync(join(componentsDir, "channel-valid-name.yml"), "services: {}");

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid-name");
  });

  test("ignores non-channel .yml files in components directory", () => {
    const componentsDir = join(configDir, "components");
    mkdirSync(componentsDir, { recursive: true });
    writeFileSync(join(componentsDir, "core.yml"), "services: {}");
    writeFileSync(join(componentsDir, "channel-chat.yml"), "services: {}");
    writeFileSync(join(componentsDir, "admin.yml"), "services: {}");

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

  test("allows channel-* when component overlay exists", () => {
    const configDir = trackDir(makeTempDir());
    const componentsDir = join(configDir, "components");
    mkdirSync(componentsDir, { recursive: true });
    writeFileSync(join(componentsDir, "channel-chat.yml"), "services: {}");

    expect(isAllowedService("channel-chat", configDir)).toBe(true);
  });

  test("rejects channel-* when component overlay does not exist", () => {
    const configDir = trackDir(makeTempDir());
    expect(isAllowedService("channel-chat", configDir)).toBe(false);
  });

  test("rejects channel- with invalid channel name", () => {
    const configDir = trackDir(makeTempDir());
    expect(isAllowedService("channel-UPPER", configDir)).toBe(false);
    expect(isAllowedService("channel--double", configDir)).toBe(false);
  });

  test("rejects non-core, non-channel services", () => {
    expect(isAllowedService("unknown-service")).toBe(false);
    expect(isAllowedService("nginx")).toBe(false);
  });

  test("allows ollama when component overlay exists", () => {
    const configDir = trackDir(makeTempDir());
    const componentsDir = join(configDir, "components");
    mkdirSync(componentsDir, { recursive: true });
    writeFileSync(join(componentsDir, "ollama.yml"), "services:\n  ollama:\n    image: ollama/ollama\n");

    expect(isAllowedService("ollama", configDir)).toBe(true);
  });

  test("rejects ollama when component overlay does not exist", () => {
    const configDir = trackDir(makeTempDir());
    expect(isAllowedService("ollama", configDir)).toBe(false);
  });

  test("rejects ollama without configDir", () => {
    expect(isAllowedService("ollama")).toBe(false);
  });
});

describe("isValidChannel", () => {
  test("validates channel name format (lowercase alnum + hyphens)", () => {
    const configDir = trackDir(makeTempDir());
    const componentsDir = join(configDir, "components");
    mkdirSync(componentsDir, { recursive: true });
    writeFileSync(join(componentsDir, "channel-my-channel.yml"), "services: {}");

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

  test("requires configDir to confirm component overlay", () => {
    // Without configDir: format-valid but returns false (no overlay check)
    expect(isValidChannel("chat")).toBe(false);
  });

  test("rejects valid-format name if not installed as component", () => {
    const configDir = trackDir(makeTempDir());
    mkdirSync(join(configDir, "components"), { recursive: true });
    expect(isValidChannel("unstaged", configDir)).toBe(false);
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
    const componentsDir = join(configDir, "components");
    mkdirSync(componentsDir, { recursive: true });
    writeFileSync(join(componentsDir, `channel-${name}.yml`), "existing");

    const result = installChannelFromRegistry(name, configDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("already installed");
  });

  test("installs registry channel successfully", () => {
    if (REGISTRY_CHANNEL_NAMES.length === 0) return;
    const name = REGISTRY_CHANNEL_NAMES[0];

    const result = installChannelFromRegistry(name, configDir);
    expect(result.ok).toBe(true);
    expect(existsSync(join(configDir, "components", `channel-${name}.yml`))).toBe(true);
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
    mkdirSync(join(configDir, "components"), { recursive: true });
    const result = uninstallChannel("chat", configDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not installed");
  });

  test("removes .yml file on uninstall", () => {
    seedChannelComponents(configDir, [
      { name: "chat", yml: "services: {}" }
    ]);

    const result = uninstallChannel("chat", configDir);
    expect(result.ok).toBe(true);
    expect(existsSync(join(configDir, "components", "channel-chat.yml"))).toBe(false);
  });

  test("removes both .yml and .caddy files", () => {
    seedChannelComponents(configDir, [
      {
        name: "chat",
        yml: "services: {}",
        caddy: "handle_path /chat/* { reverse_proxy channel-chat:8080 }"
      }
    ]);

    const result = uninstallChannel("chat", configDir);
    expect(result.ok).toBe(true);
    expect(existsSync(join(configDir, "components", "channel-chat.yml"))).toBe(false);
    expect(existsSync(join(configDir, "components", "channel-chat.caddy"))).toBe(false);
  });
});
