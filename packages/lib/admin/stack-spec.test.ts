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
    expect(spec.channels.chat.config).toHaveProperty("CHAT_INBOUND_TOKEN");
    expect(Array.isArray(spec.automations)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain('"version": 1');
  });

  it("keeps default stack spec focused on user intent fields only", () => {
    const spec = createDefaultStackSpec() as Record<string, unknown>;
    expect(Object.keys(spec).sort()).toEqual([
      "accessScope",
      "automations",
      "channels",
      "connections",
      "secrets",
      "version",
    ]);
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

  it("rejects unknown top-level stack spec fields", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({
      ...base,
      runtime: {
        generatedAt: Date.now(),
      },
    })).toThrow("unknown_stack_spec_field_runtime");
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


  it("parses automations settings", () => {
    const base = createDefaultStackSpec();
    const parsed = parseStackSpec({
      ...base,
      automations: [
        {
          id: "daily",
          name: "Daily",
          schedule: "0 9 * * *",
          script: "echo summarize",
          enabled: true,
        },
      ],
    });
    expect(parsed.automations.length).toBe(1);
  });

  it("rejects connection env entries that are not secret key references", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({
      ...base,
      connections: [
        {
          id: "openai",
          type: "ai_provider",
          name: "OpenAI",
          env: {
            OPENAI_API_KEY: "not-a-secret-name",
          },
        },
      ],
    })).toThrow("invalid_connection_secret_ref_OPENAI_API_KEY");
  });


  it("rejects automations without script", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({
      ...base,
      automations: [
        {
          id: "invalid",
          name: "Invalid",
          schedule: "0 9 * * *",
          enabled: true,
        },
      ],
    })).toThrow("invalid_automation_script_0");
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
