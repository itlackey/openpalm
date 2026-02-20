import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { createDefaultStackSpec, ensureStackSpec, parseStackSpec, writeStackSpec } from "./stack-spec.ts";

describe("stack spec", () => {
  it("creates a default stack spec when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-spec-"));
    const path = join(dir, "stack-spec.json");
    const spec = ensureStackSpec(path);
    expect(spec.version).toBe(1);
    expect(spec.channels.chat.enabled).toBe(true);
    expect(spec.secrets.available.length).toBeGreaterThan(0);
    expect(spec.channels.chat.config).toHaveProperty("CHAT_INBOUND_TOKEN");
    expect(spec.gateway.rateLimitPerMinute).toBe(120);
    expect(Array.isArray(spec.automations)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain('"version": 1');
  });

  it("validates and rejects unknown channels", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        webhook: { enabled: true, exposure: "lan" },
      },
    })).toThrow("unknown_channel_webhook");
  });

  it("requires mapped secrets to be listed as available", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({
      ...base,
      secrets: {
        ...base.secrets,
        available: ["CHANNEL_CHAT_SECRET"],
      },
    })).toThrow("unknown_secret_reference_CHANNEL_DISCORD_SECRET");
  });

  it("accepts legacy version 2 stack specs and normalizes to version 1", () => {
    const migrated = parseStackSpec({
      version: 2,
      accessScope: "lan",
      channels: {
        chat: { enabled: true, exposure: "lan" },
        discord: { enabled: true, exposure: "lan" },
        voice: { enabled: true, exposure: "lan" },
        telegram: { enabled: true, exposure: "lan" },
      },
      secrets: baseSecrets(),
    });
    expect(migrated.version).toBe(1);
    expect(migrated.secrets.gatewayChannelSecrets.chat).toBe("CHANNEL_CHAT_SECRET");
  });

  it("validates extension connection references", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({
      ...base,
      extensions: [{ id: "x", type: "plugin", enabled: true, pluginId: "@scope/test", connectionIds: ["missing"] }],
    })).toThrow("unknown_extension_connection_missing");
  });


  it("parses channel config from spec", () => {
    const base = createDefaultStackSpec();
    const parsed = parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        chat: { ...base.channels.chat, config: { CHAT_INBOUND_TOKEN: "abc" } },
      },
    });
    expect(parsed.channels.chat.config.CHAT_INBOUND_TOKEN).toBe("abc");
  });


  it("parses gateway and automations settings", () => {
    const base = createDefaultStackSpec();
    const parsed = parseStackSpec({
      ...base,
      gateway: { rateLimitPerMinute: 240, intakeValidation: false },
      automations: [
        {
          id: "daily",
          name: "Daily",
          schedule: "0 9 * * *",
          prompt: "summarize",
          enabled: true,
        },
      ],
    });
    expect(parsed.gateway.rateLimitPerMinute).toBe(240);
    expect(parsed.automations.length).toBe(1);
  });

  it("writes valid stack spec content", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-spec-"));
    const path = join(dir, "stack-spec.json");
    const spec = createDefaultStackSpec();
    spec.channels.discord.exposure = "public";
    writeStackSpec(path, spec);
    const saved = ensureStackSpec(path);
    expect(saved.channels.discord.exposure).toBe("public");
  });
});

function baseSecrets() {
  return {
    available: ["CHANNEL_CHAT_SECRET", "CHANNEL_DISCORD_SECRET", "CHANNEL_VOICE_SECRET", "CHANNEL_TELEGRAM_SECRET"],
    gatewayChannelSecrets: {
      chat: "CHANNEL_CHAT_SECRET",
      discord: "CHANNEL_DISCORD_SECRET",
      voice: "CHANNEL_VOICE_SECRET",
      telegram: "CHANNEL_TELEGRAM_SECRET",
    },
    channelServiceSecrets: {
      chat: "CHANNEL_CHAT_SECRET",
      discord: "CHANNEL_DISCORD_SECRET",
      voice: "CHANNEL_VOICE_SECRET",
      telegram: "CHANNEL_TELEGRAM_SECRET",
    },
  };
}
