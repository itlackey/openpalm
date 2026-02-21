import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { createDefaultStackSpec, ensureStackSpec, parseStackSpec, parseSecretReference, writeStackSpec, isBuiltInChannel, BuiltInChannelPorts, StackSpecVersion } from "./stack-spec.ts";

describe("stack spec", () => {
  it("creates a default stack spec when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-spec-"));
    const path = join(dir, "stack-spec.json");
    const spec = ensureStackSpec(path);
    expect(spec.version).toBe(StackSpecVersion);
    expect(spec.channels.chat.enabled).toBe(true);
    expect(spec.channels.chat.config).toHaveProperty("CHAT_INBOUND_TOKEN");
    expect(spec.channels.chat.config).toHaveProperty("CHANNEL_CHAT_SECRET");
    expect(Array.isArray(spec.automations)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(`"version": ${StackSpecVersion}`);
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

  it("validates and rejects unknown channels with invalid names", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        "INVALID": { enabled: true, exposure: "lan", image: "foo:1", containerPort: 9999, config: {} },
      },
    })).toThrow("invalid_channel_name_INVALID");
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

  // --- New: custom channels ---

  it("accepts custom channels with image and containerPort", () => {
    const base = createDefaultStackSpec();
    const parsed = parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        "public-api": {
          enabled: true,
          exposure: "public",
          image: "ghcr.io/acme/api:latest",
          containerPort: 9000,
          hostPort: 9001,
          domains: ["api.example.com"],
          pathPrefixes: ["/api", "/"],
          config: { API_KEY: "abc" },
        },
      },
    });
    expect(parsed.channels["public-api"].image).toBe("ghcr.io/acme/api:latest");
    expect(parsed.channels["public-api"].containerPort).toBe(9000);
    expect(parsed.channels["public-api"].hostPort).toBe(9001);
    expect(parsed.channels["public-api"].domains).toEqual(["api.example.com"]);
    expect(parsed.channels["public-api"].pathPrefixes).toEqual(["/api", "/"]);
    expect(parsed.channels["public-api"].config.API_KEY).toBe("abc");
  });

  it("rejects custom channels missing image", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        "my-service": {
          enabled: true,
          exposure: "lan",
          containerPort: 8080,
          config: {},
        },
      },
    })).toThrow("custom_channel_requires_image_my-service");
  });

  it("rejects custom channels missing containerPort", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        "my-service": {
          enabled: true,
          exposure: "lan",
          image: "my-image:latest",
          config: {},
        },
      },
    })).toThrow("custom_channel_requires_container_port_my-service");
  });

  it("accepts public access scope", () => {
    const base = createDefaultStackSpec();
    const parsed = parseStackSpec({
      ...base,
      accessScope: "public",
    });
    expect(parsed.accessScope).toBe("public");
  });

  it("accepts caddy config with email", () => {
    const base = createDefaultStackSpec();
    const parsed = parseStackSpec({
      ...base,
      caddy: { email: "admin@example.com" },
    });
    expect(parsed.caddy?.email).toBe("admin@example.com");
  });

  it("allows caddy key in spec", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({
      ...base,
      caddy: { email: "test@test.com" },
    })).not.toThrow();
  });

  it("requires built-in channels to be present", () => {
    const base = createDefaultStackSpec();
    const { chat, ...rest } = base.channels;
    expect(() => parseStackSpec({
      ...base,
      channels: rest,
    })).toThrow("missing_built_in_channel_chat");
  });

  it("built-in channels do not require image or containerPort", () => {
    const base = createDefaultStackSpec();
    const parsed = parseStackSpec(base);
    expect(parsed.channels.chat.image).toBeUndefined();
    expect(parsed.channels.chat.containerPort).toBeUndefined();
  });

  it("built-in channels can override image and port", () => {
    const base = createDefaultStackSpec();
    const parsed = parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        chat: { ...base.channels.chat, image: "my-chat:v2", containerPort: 9999 },
      },
    });
    expect(parsed.channels.chat.image).toBe("my-chat:v2");
    expect(parsed.channels.chat.containerPort).toBe(9999);
  });

  it("identifies built-in channels correctly", () => {
    expect(isBuiltInChannel("chat")).toBe(true);
    expect(isBuiltInChannel("discord")).toBe(true);
    expect(isBuiltInChannel("my-custom")).toBe(false);
  });

  it("has port defaults for built-in channels", () => {
    expect(BuiltInChannelPorts.chat).toBe(8181);
    expect(BuiltInChannelPorts.discord).toBe(8184);
  });

  it("reads version 1 specs and upgrades to version 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-spec-"));
    const path = join(dir, "stack-spec.json");
    const v1 = createDefaultStackSpec();
    const v1Json = JSON.stringify({ ...v1, version: 1 }, null, 2);
    require("node:fs").writeFileSync(path, v1Json, "utf8");
    const spec = ensureStackSpec(path);
    expect(spec.version).toBe(StackSpecVersion);
  });
});
