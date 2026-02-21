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
    mkdirSync(caddyDir, { recursive: true });
    mkdirSync(caddyRoutesDir, { recursive: true });

    const manager = new StackManager({
      caddyfilePath: join(caddyDir, "Caddyfile"),
      caddyRoutesDir,
      composeFilePath: join(dir, "docker-compose.yml"),
      secretsEnvPath: join(dir, "secrets.env"),
      stackSpecPath: join(dir, "stack-spec.json"),
      gatewayEnvPath: join(dir, "rendered", "env", "gateway.env"),
      openmemoryEnvPath: join(dir, "rendered", "env", "openmemory.env"),
      postgresEnvPath: join(dir, "rendered", "env", "postgres.env"),
      qdrantEnvPath: join(dir, "rendered", "env", "qdrant.env"),
      opencodeEnvPath: join(dir, "rendered", "env", "opencode.env"),
      channelsEnvPath: join(dir, "rendered", "env", "channels.env"),
    });

    manager.upsertSecret("MY_NEW_SECRET", "abc123");
    manager.mapChannelSecret("chat", "gateway", "MY_NEW_SECRET");
    manager.setChannelConfig("chat", { CHAT_INBOUND_TOKEN: "abc" });
    manager.renderArtifacts();

    expect(readFileSync(join(caddyDir, "routes", "channels", "chat.caddy"), "utf8")).toContain("handle /channels/chat*");
    expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toContain("opencode-core:");
    expect(readFileSync(join(dir, "rendered", "env", "gateway.env"), "utf8")).toContain("CHANNEL_CHAT_SECRET=abc123");
    expect(readFileSync(join(dir, "rendered", "env", "channels.env"), "utf8")).toContain("CHAT_INBOUND_TOKEN=abc");

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
      gatewayEnvPath: join(dir, "rendered", "env", "gateway.env"),
      openmemoryEnvPath: join(dir, "rendered", "env", "openmemory.env"),
      postgresEnvPath: join(dir, "rendered", "env", "postgres.env"),
      qdrantEnvPath: join(dir, "rendered", "env", "qdrant.env"),
      opencodeEnvPath: join(dir, "rendered", "env", "opencode.env"),
      channelsEnvPath: join(dir, "rendered", "env", "channels.env"),
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
      gatewayEnvPath: join(dir, "rendered", "env", "gateway.env"),
      openmemoryEnvPath: join(dir, "rendered", "env", "openmemory.env"),
      postgresEnvPath: join(dir, "rendered", "env", "postgres.env"),
      qdrantEnvPath: join(dir, "rendered", "env", "qdrant.env"),
      opencodeEnvPath: join(dir, "rendered", "env", "opencode.env"),
      channelsEnvPath: join(dir, "rendered", "env", "channels.env"),
    });

    manager.upsertSecret("OPENAI_API_KEY_MAIN", "test-key");
    const connection = manager.upsertConnection({
      id: "openai-primary",
      type: "ai_provider",
      name: "OpenAI Primary",
      env: {
        OPENAI_API_KEY: "OPENAI_API_KEY_MAIN",
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
      gatewayEnvPath: join(dir, "rendered", "env", "gateway.env"),
      openmemoryEnvPath: join(dir, "rendered", "env", "openmemory.env"),
      postgresEnvPath: join(dir, "rendered", "env", "postgres.env"),
      qdrantEnvPath: join(dir, "rendered", "env", "qdrant.env"),
      opencodeEnvPath: join(dir, "rendered", "env", "opencode.env"),
      channelsEnvPath: join(dir, "rendered", "env", "channels.env"),
    });

    manager.renderArtifacts();
    expect(existsSync(join(dir, "routes", "channels", "chat.caddy"))).toBeTrue();

    const spec = manager.getSpec();
    spec.channels.chat.enabled = false;
    manager.setSpec(spec);

    expect(existsSync(join(dir, "routes", "channels", "chat.caddy"))).toBeFalse();
  });

  it("deletes connection without mutating referenced secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = new StackManager({
      caddyfilePath: join(dir, "Caddyfile"),
      caddyRoutesDir: join(dir, "routes"),
      composeFilePath: join(dir, "docker-compose.yml"),
      secretsEnvPath: join(dir, "secrets.env"),
      stackSpecPath: join(dir, "stack-spec.json"),
      gatewayEnvPath: join(dir, "rendered", "env", "gateway.env"),
      openmemoryEnvPath: join(dir, "rendered", "env", "openmemory.env"),
      postgresEnvPath: join(dir, "rendered", "env", "postgres.env"),
      qdrantEnvPath: join(dir, "rendered", "env", "qdrant.env"),
      opencodeEnvPath: join(dir, "rendered", "env", "opencode.env"),
      channelsEnvPath: join(dir, "rendered", "env", "channels.env"),
    });

    manager.upsertSecret("OPENAI_API_KEY_MAIN", "test-key");
    manager.upsertConnection({
      id: "openai-primary",
      type: "ai_provider",
      name: "OpenAI Primary",
      env: {
        OPENAI_API_KEY: "OPENAI_API_KEY_MAIN",
      },
    });
    expect(manager.deleteConnection("openai-primary")).toBe("openai-primary");
    expect(readFileSync(join(dir, "secrets.env"), "utf8")).toContain("OPENAI_API_KEY_MAIN=test-key");
  });

  it("validates connections without persisting them", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = new StackManager({
      caddyfilePath: join(dir, "Caddyfile"),
      caddyRoutesDir: join(dir, "routes"),
      composeFilePath: join(dir, "docker-compose.yml"),
      secretsEnvPath: join(dir, "secrets.env"),
      stackSpecPath: join(dir, "stack-spec.json"),
      gatewayEnvPath: join(dir, "rendered", "env", "gateway.env"),
      openmemoryEnvPath: join(dir, "rendered", "env", "openmemory.env"),
      postgresEnvPath: join(dir, "rendered", "env", "postgres.env"),
      qdrantEnvPath: join(dir, "rendered", "env", "qdrant.env"),
      opencodeEnvPath: join(dir, "rendered", "env", "opencode.env"),
      channelsEnvPath: join(dir, "rendered", "env", "channels.env"),
    });

    manager.upsertSecret("OPENAI_API_KEY_MAIN", "test-key");
    const validated = manager.validateConnection({
      id: "openai-primary",
      type: "ai_provider",
      name: "OpenAI Primary",
      env: {
        OPENAI_API_KEY: "OPENAI_API_KEY_MAIN",
      },
    });

    expect(validated.id).toBe("openai-primary");
    expect(manager.listConnections().length).toBe(0);
  });

  it("rejects connections that reference unknown secret keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = new StackManager({
      caddyfilePath: join(dir, "Caddyfile"),
      caddyRoutesDir: join(dir, "routes"),
      composeFilePath: join(dir, "docker-compose.yml"),
      secretsEnvPath: join(dir, "secrets.env"),
      stackSpecPath: join(dir, "stack-spec.json"),
      gatewayEnvPath: join(dir, "rendered", "env", "gateway.env"),
      openmemoryEnvPath: join(dir, "rendered", "env", "openmemory.env"),
      postgresEnvPath: join(dir, "rendered", "env", "postgres.env"),
      qdrantEnvPath: join(dir, "rendered", "env", "qdrant.env"),
      opencodeEnvPath: join(dir, "rendered", "env", "opencode.env"),
      channelsEnvPath: join(dir, "rendered", "env", "channels.env"),
    });

    expect(() => manager.upsertConnection({
      id: "openai-primary",
      type: "ai_provider",
      name: "OpenAI Primary",
      env: {
        OPENAI_API_KEY: "MISSING_SECRET",
      },
    })).toThrow("unknown_secret_name");
  });


  it("preserves multiline automation scripts", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = new StackManager({
      caddyfilePath: join(dir, "Caddyfile"),
      caddyRoutesDir: join(dir, "routes"),
      composeFilePath: join(dir, "docker-compose.yml"),
      secretsEnvPath: join(dir, "secrets.env"),
      stackSpecPath: join(dir, "stack-spec.json"),
      gatewayEnvPath: join(dir, "rendered", "env", "gateway.env"),
      openmemoryEnvPath: join(dir, "rendered", "env", "openmemory.env"),
      postgresEnvPath: join(dir, "rendered", "env", "postgres.env"),
      qdrantEnvPath: join(dir, "rendered", "env", "qdrant.env"),
      opencodeEnvPath: join(dir, "rendered", "env", "opencode.env"),
      channelsEnvPath: join(dir, "rendered", "env", "channels.env"),
    });

    const multi = "echo first\necho second";
    manager.upsertAutomation({
      id: "multi",
      name: "Multiline",
      schedule: "0 6 * * *",
      enabled: true,
      script: multi,
    });

    expect(manager.getAutomation("multi")?.script).toBe(multi);
  });

  it("supports automation CRUD in stack spec", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = new StackManager({
      caddyfilePath: join(dir, "Caddyfile"),
      caddyRoutesDir: join(dir, "routes"),
      composeFilePath: join(dir, "docker-compose.yml"),
      secretsEnvPath: join(dir, "secrets.env"),
      stackSpecPath: join(dir, "stack-spec.json"),
      gatewayEnvPath: join(dir, "rendered", "env", "gateway.env"),
      openmemoryEnvPath: join(dir, "rendered", "env", "openmemory.env"),
      postgresEnvPath: join(dir, "rendered", "env", "postgres.env"),
      qdrantEnvPath: join(dir, "rendered", "env", "qdrant.env"),
      opencodeEnvPath: join(dir, "rendered", "env", "opencode.env"),
      channelsEnvPath: join(dir, "rendered", "env", "channels.env"),
    });

    const created = manager.upsertAutomation({
      id: "daily",
      name: "Daily Task",
      schedule: "0 9 * * *",
      enabled: true,
      script: "echo hello",
    });

    expect(created.id).toBe("daily");
    expect(manager.listAutomations().length).toBe(1);

    const updated = manager.upsertAutomation({
      id: "daily",
      name: "Daily Task Updated",
      schedule: "15 9 * * *",
      enabled: false,
      script: "echo updated",
    });

    expect(updated.enabled).toBe(false);
    expect(manager.getAutomation("daily")?.script).toBe("echo updated");
    expect(manager.deleteAutomation("daily")).toBeTrue();
    expect(manager.listAutomations().length).toBe(0);
  });
});
