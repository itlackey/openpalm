import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { createDefaultStackSpec, ensureStackSpec, parseStackSpec, parseSecretReference, writeStackSpec } from "./stack-spec.ts";

describe("stack spec", () => {
  it("creates a default stack spec when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-spec-"));
    const path = join(dir, "stack-spec.json");
    const spec = ensureStackSpec(path);
    expect(spec.version).toBe(1);
    expect(spec.channels.chat.enabled).toBe(true);
    expect(spec.channels.chat.config).toHaveProperty("CHAT_INBOUND_TOKEN");
    expect(spec.channels.chat.config).toHaveProperty("CHANNEL_CHAT_SECRET");
    expect(Array.isArray(spec.automations)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain('"version": 1');
  });

  it("keeps default stack spec focused on user intent fields only", () => {
    const spec = createDefaultStackSpec() as Record<string, unknown>;
    expect(Object.keys(spec).sort()).toEqual([
      "accessScope",
      "automations",
      "channels",
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
      connections: [],
    })).toThrow("unknown_stack_spec_field_connections");
  });

  it("accepts host channel exposure", () => {
    const base = createDefaultStackSpec();
    const parsed = parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        discord: { ...base.channels.discord, exposure: "host" },
      },
    });
    expect(parsed.channels.discord.exposure).toBe("host");
  });

  it("parses channel config values including secret references", () => {
    const base = createDefaultStackSpec();
    const parsed = parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        chat: { ...base.channels.chat, config: { CHAT_INBOUND_TOKEN: "${CHAT_TOKEN}", CHANNEL_CHAT_SECRET: "${CHAT_SHARED}" } },
      },
    });
    expect(parsed.channels.chat.config.CHAT_INBOUND_TOKEN).toBe("${CHAT_TOKEN}");
    expect(parsed.channels.chat.config.CHANNEL_CHAT_SECRET).toBe("${CHAT_SHARED}");
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

  it("parses explicit secret references", () => {
    expect(parseSecretReference("${OPENAI_API_KEY}")).toBe("OPENAI_API_KEY");
    expect(parseSecretReference("OPENAI_API_KEY")).toBeNull();
  });
});
