import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { StackManager } from "./stack-manager.ts";

describe("stack manager", () => {
  it("writes all generated stack artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const caddyDir = join(dir, "caddy");
    const caddyRoutesDir = join(caddyDir, "routes");
    const secretsDir = join(dir, "secrets");
    mkdirSync(caddyDir, { recursive: true });
    mkdirSync(caddyRoutesDir, { recursive: true });
    mkdirSync(join(secretsDir, "gateway"), { recursive: true });
    mkdirSync(join(secretsDir, "channels"), { recursive: true });

    const opencodePath = join(dir, "opencode.jsonc");
    writeFileSync(opencodePath, '{"$schema":"https://example/schema.json","provider":{"x":{}}}\n', "utf8");

    const manager = new StackManager({
      caddyfilePath: join(caddyDir, "Caddyfile"),
      caddyRoutesDir,
      composeFilePath: join(dir, "docker-compose.yml"),
      secretsEnvPath: join(dir, "secrets.env"),
      stackSpecPath: join(dir, "stack-spec.json"),
      channelSecretDir: join(secretsDir, "channels"),
      channelEnvDir: join(dir, "channel-config"),
      gatewayChannelSecretsPath: join(secretsDir, "gateway", "channels.env"),
      gatewayRuntimeSecretsPath: join(secretsDir, "gateway", "gateway.env"),
      openmemorySecretsPath: join(secretsDir, "openmemory", "openmemory.env"),
      postgresSecretsPath: join(secretsDir, "db", "postgres.env"),
      opencodeProviderSecretsPath: join(secretsDir, "opencode", "providers.env"),
      opencodeConfigPath: opencodePath,
    });

    manager.upsertSecret("MY_NEW_SECRET", "abc123");
    manager.mapChannelSecret("chat", "gateway", "MY_NEW_SECRET");
    manager.setChannelConfig("chat", { CHAT_INBOUND_TOKEN: "abc" });
    manager.setExtensionInstalled({
      extensionId: "policy-plugin",
      type: "plugin",
      enabled: true,
      pluginId: "@openpalm/policy-plugin",
    });
    manager.renderArtifacts();

    expect(readFileSync(join(caddyDir, "routes", "channels", "chat.caddy"), "utf8")).toContain("handle /channels/chat*");
    expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toContain("opencode-core:");
    expect(readFileSync(join(secretsDir, "gateway", "channels.env"), "utf8")).toContain("CHANNEL_CHAT_SECRET=abc123");
    expect(readFileSync(join(secretsDir, "channels", "chat.env"), "utf8")).toContain("CHANNEL_CHAT_SECRET=");
    expect(readFileSync(join(dir, "channel-config", "chat.env"), "utf8")).toContain("CHAT_INBOUND_TOKEN=abc");

    const opencode = readFileSync(opencodePath, "utf8");
    expect(opencode).toContain('"$schema"');
    expect(opencode).toContain('"provider"');
    expect(opencode).toContain("@openpalm/policy-plugin");
  });

  it("prevents deleting secrets that are in use", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    writeFileSync(join(dir, "secrets.env"), "CHANNEL_CHAT_SECRET=x\n", "utf8");
    const manager = new StackManager({
      caddyfilePath: join(dir, "Caddyfile"),
      caddyRoutesDir: join(dir, "routes"),
      composeFilePath: join(dir, "docker-compose.yml"),
      secretsEnvPath: join(dir, "secrets.env"),
      stackSpecPath: join(dir, "stack-spec.json"),
      channelSecretDir: join(dir, "channels"),
      channelEnvDir: join(dir, "channel-config"),
      gatewayChannelSecretsPath: join(dir, "gateway.env"),
      gatewayRuntimeSecretsPath: join(dir, "gateway-runtime.env"),
      openmemorySecretsPath: join(dir, "openmemory.env"),
      postgresSecretsPath: join(dir, "postgres.env"),
      opencodeProviderSecretsPath: join(dir, "providers.env"),
      opencodeConfigPath: join(dir, "opencode.jsonc"),
    });
    expect(() => manager.deleteSecret("CHANNEL_CHAT_SECRET")).toThrow("secret_in_use");
  });

  it("stores and lists global connections from stack spec", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = new StackManager({
      caddyfilePath: join(dir, "Caddyfile"),
      caddyRoutesDir: join(dir, "routes"),
      composeFilePath: join(dir, "docker-compose.yml"),
      secretsEnvPath: join(dir, "secrets.env"),
      stackSpecPath: join(dir, "stack-spec.json"),
      channelSecretDir: join(dir, "channels"),
      channelEnvDir: join(dir, "channel-config"),
      gatewayChannelSecretsPath: join(dir, "gateway.env"),
      gatewayRuntimeSecretsPath: join(dir, "gateway-runtime.env"),
      openmemorySecretsPath: join(dir, "openmemory.env"),
      postgresSecretsPath: join(dir, "postgres.env"),
      opencodeProviderSecretsPath: join(dir, "providers.env"),
      opencodeConfigPath: join(dir, "opencode.jsonc"),
    });

    const connection = manager.upsertConnection({
      id: "openai-primary",
      type: "ai_provider",
      name: "OpenAI Primary",
      env: {
        OPENPALM_CONN_OPENAI_API_KEY: "test-key",
      },
    });

    expect(connection.id).toBe("openai-primary");
    expect(manager.listConnections().length).toBe(1);
  });

  it("removes stale channel route snippets when channels are disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = new StackManager({
      caddyfilePath: join(dir, "Caddyfile"),
      caddyRoutesDir: join(dir, "routes"),
      composeFilePath: join(dir, "docker-compose.yml"),
      secretsEnvPath: join(dir, "secrets.env"),
      stackSpecPath: join(dir, "stack-spec.json"),
      channelSecretDir: join(dir, "channels"),
      channelEnvDir: join(dir, "channel-config"),
      gatewayChannelSecretsPath: join(dir, "gateway.env"),
      gatewayRuntimeSecretsPath: join(dir, "gateway-runtime.env"),
      openmemorySecretsPath: join(dir, "openmemory.env"),
      postgresSecretsPath: join(dir, "postgres.env"),
      opencodeProviderSecretsPath: join(dir, "providers.env"),
      opencodeConfigPath: join(dir, "opencode.jsonc"),
    });

    manager.renderArtifacts();
    expect(existsSync(join(dir, "routes", "channels", "chat.caddy"))).toBeTrue();

    const spec = manager.getSpec();
    spec.channels.chat.enabled = false;
    manager.setSpec(spec);

    expect(existsSync(join(dir, "routes", "channels", "chat.caddy"))).toBeFalse();
  });

  it("prevents deleting a connection referenced by an extension", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = new StackManager({
      caddyfilePath: join(dir, "Caddyfile"),
      caddyRoutesDir: join(dir, "routes"),
      composeFilePath: join(dir, "docker-compose.yml"),
      secretsEnvPath: join(dir, "secrets.env"),
      stackSpecPath: join(dir, "stack-spec.json"),
      channelSecretDir: join(dir, "channels"),
      channelEnvDir: join(dir, "channel-config"),
      gatewayChannelSecretsPath: join(dir, "gateway.env"),
      gatewayRuntimeSecretsPath: join(dir, "gateway-runtime.env"),
      openmemorySecretsPath: join(dir, "openmemory.env"),
      postgresSecretsPath: join(dir, "postgres.env"),
      opencodeProviderSecretsPath: join(dir, "providers.env"),
      opencodeConfigPath: join(dir, "opencode.jsonc"),
    });

    manager.upsertConnection({
      id: "openai-primary",
      type: "ai_provider",
      name: "OpenAI Primary",
      env: {
        OPENPALM_CONN_OPENAI_API_KEY: "test-key",
      },
    });
    manager.setExtensionInstalled({
      extensionId: "assistant-agent",
      type: "agent",
      enabled: true,
      connectionIds: ["openai-primary"],
    });

    expect(() => manager.deleteConnection("openai-primary")).toThrow("connection_in_use");
  });
});
