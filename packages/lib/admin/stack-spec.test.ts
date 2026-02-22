import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { createDefaultStackSpec, ensureStackSpec, parseStackSpec, parseSecretReference, writeStackSpec, isBuiltInChannel, BuiltInChannelPorts, StackSpecVersion } from "./stack-spec.ts";

describe("stack spec", () => {
  it("creates a default stack spec when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-spec-"));
    const path = join(dir, "openpalm.yaml");
    const spec = ensureStackSpec(path);
    expect(spec.version).toBe(StackSpecVersion);
    expect(spec.channels.chat.enabled).toBe(true);
    expect(spec.channels.chat.config).toHaveProperty("CHAT_INBOUND_TOKEN");
    expect(spec.channels.chat.config).toHaveProperty("CHANNEL_CHAT_SECRET");
    expect(Array.isArray(spec.automations)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(`version: ${StackSpecVersion}`);
  });

  it("keeps default stack spec focused on user intent fields only", () => {
    const spec = createDefaultStackSpec() as Record<string, unknown>;
    expect(Object.keys(spec).sort()).toEqual([
      "accessScope",
      "automations",
      "channels",
      "services",
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
    const path = join(dir, "openpalm.yaml");
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

  // --- Security validation tests ---

  it("rejects domains with Caddy injection characters", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        "my-svc": {
          enabled: true, exposure: "public",
          image: "svc:latest", containerPort: 8080,
          domains: ["example.com }\n:80 {"], config: {},
        },
      },
    })).toThrow("invalid_channel_domain_format_my-svc");
  });

  it("rejects path prefixes with Caddy injection characters", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        "my-svc": {
          enabled: true, exposure: "lan",
          image: "svc:latest", containerPort: 8080,
          pathPrefixes: ["/foo* {\n\treverse_proxy evil:1234"], config: {},
        },
      },
    })).toThrow("invalid_channel_path_prefix_format_my-svc");
  });

  it("rejects image names with YAML injection characters", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        "my-svc": {
          enabled: true, exposure: "lan",
          image: "evil:latest\n    privileged: true", containerPort: 8080,
          config: {},
        },
      },
    })).toThrow("invalid_channel_image_format_my-svc");
  });

  it("rejects caddy email with injection characters", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({
      ...base,
      caddy: { email: "foo@bar.com\n\tacme_ca https://evil.ca" },
    })).toThrow("invalid_caddy_email_format");
  });

  it("rejects custom config keys with invalid format", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        "my-svc": {
          enabled: true, exposure: "lan",
          image: "svc:latest", containerPort: 8080,
          config: { "invalid-key": "value" },
        },
      },
    })).toThrow("invalid_channel_config_key_my-svc_invalid-key");
  });

  it("strips newlines from config values at parse time", () => {
    const base = createDefaultStackSpec();
    const parsed = parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        chat: { ...base.channels.chat, config: { CHAT_INBOUND_TOKEN: "abc\ndef", CHANNEL_CHAT_SECRET: "ok" } },
      },
    });
    expect(parsed.channels.chat.config.CHAT_INBOUND_TOKEN).toBe("abcdef");
  });

  it("rejects excessively long channel names", () => {
    const base = createDefaultStackSpec();
    const longName = "a" + "b".repeat(63);
    expect(() => parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        [longName]: {
          enabled: true, exposure: "lan",
          image: "svc:latest", containerPort: 8080,
          config: {},
        },
      },
    })).toThrow(`invalid_channel_name_${longName}`);
  });

  // --- Arbitrary channel management ---

  it("accepts multiple custom channels with distinct configurations simultaneously", () => {
    const base = createDefaultStackSpec();
    const parsed = parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        "slack": {
          enabled: true, exposure: "lan",
          image: "openpalm/channel-slack:latest", containerPort: 8500,
          config: { SLACK_BOT_TOKEN: "${SLACK_TOKEN}", SLACK_SIGNING_SECRET: "${SLACK_SECRET}" },
        },
        "whatsapp": {
          enabled: true, exposure: "public",
          image: "ghcr.io/acme/wa-bridge:v2", containerPort: 9200,
          hostPort: 9201,
          domains: ["wa.example.com"],
          config: { WA_PHONE_ID: "12345", WA_ACCESS_TOKEN: "${WA_TOKEN}" },
        },
        "internal-api": {
          enabled: true, exposure: "host",
          image: "my-api:latest", containerPort: 3000,
          pathPrefixes: ["/v1"],
          config: { API_SECRET: "inline-secret" },
        },
      },
    });

    // All channels present alongside built-ins
    expect(Object.keys(parsed.channels)).toContain("chat");
    expect(Object.keys(parsed.channels)).toContain("slack");
    expect(Object.keys(parsed.channels)).toContain("whatsapp");
    expect(Object.keys(parsed.channels)).toContain("internal-api");

    // Each channel retains its unique config
    expect(parsed.channels["slack"].config.SLACK_BOT_TOKEN).toBe("${SLACK_TOKEN}");
    expect(parsed.channels["whatsapp"].config.WA_PHONE_ID).toBe("12345");
    expect(parsed.channels["whatsapp"].config.WA_ACCESS_TOKEN).toBe("${WA_TOKEN}");
    expect(parsed.channels["internal-api"].config.API_SECRET).toBe("inline-secret");

    // Exposure levels are independent per channel
    expect(parsed.channels["slack"].exposure).toBe("lan");
    expect(parsed.channels["whatsapp"].exposure).toBe("public");
    expect(parsed.channels["internal-api"].exposure).toBe("host");

    // Optional fields preserved correctly
    expect(parsed.channels["whatsapp"].domains).toEqual(["wa.example.com"]);
    expect(parsed.channels["whatsapp"].hostPort).toBe(9201);
    expect(parsed.channels["internal-api"].pathPrefixes).toEqual(["/v1"]);
    expect(parsed.channels["slack"].domains).toBeUndefined();
  });

  it("each custom channel independently requires image and containerPort", () => {
    const base = createDefaultStackSpec();
    // First custom channel is valid, second is missing image
    expect(() => parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        "good-svc": { enabled: true, exposure: "lan", image: "good:latest", containerPort: 8000, config: {} },
        "bad-svc": { enabled: true, exposure: "lan", containerPort: 8001, config: {} },
      },
    })).toThrow("custom_channel_requires_image_bad-svc");
  });

  it("allows custom channels with different config key sets", () => {
    const base = createDefaultStackSpec();
    const parsed = parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        "svc-a": {
          enabled: true, exposure: "lan",
          image: "a:latest", containerPort: 7000,
          config: { DATABASE_URL: "postgres://...", CACHE_TTL: "300" },
        },
        "svc-b": {
          enabled: true, exposure: "lan",
          image: "b:latest", containerPort: 7001,
          config: { WEBHOOK_URL: "https://hook.example.com", RETRY_COUNT: "3", LOG_LEVEL: "debug" },
        },
      },
    });

    expect(Object.keys(parsed.channels["svc-a"].config)).toEqual(["DATABASE_URL", "CACHE_TTL"]);
    expect(Object.keys(parsed.channels["svc-b"].config)).toEqual(["WEBHOOK_URL", "RETRY_COUNT", "LOG_LEVEL"]);
  });

  it("reads version 1 specs and upgrades to current version", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-spec-"));
    const jsonPath = join(dir, "stack-spec.json");
    const yamlPath = join(dir, "openpalm.yaml");
    const v1 = createDefaultStackSpec();
    const v1Json = JSON.stringify({ ...v1, version: 1 }, null, 2);
    require("node:fs").writeFileSync(jsonPath, v1Json, "utf8");
    // Migration: ensureStackSpec on YAML path finds legacy JSON, upgrades, and creates YAML
    const spec = ensureStackSpec(yamlPath);
    expect(spec.version).toBe(StackSpecVersion);
    // Verify YAML file was created and JSON was backed up
    expect(require("node:fs").existsSync(yamlPath)).toBe(true);
    expect(require("node:fs").existsSync(`${jsonPath}.bak`)).toBe(true);
  });
});
