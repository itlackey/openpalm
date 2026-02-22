import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { StackManager } from "./stack-manager.ts";

const yamlStringify = (obj: unknown) => Bun.YAML.stringify(obj, null, 2);
import { applyStack } from "./stack-apply-engine.ts";

function createManager(dir: string) {
  return new StackManager({
    stateRootPath: dir,
    caddyJsonPath: join(dir, "rendered", "caddy", "caddy.json"),
    composeFilePath: join(dir, "docker-compose.yml"),
    systemEnvPath: join(dir, "system.env"),
    secretsEnvPath: join(dir, "secrets.env"),
    stackSpecPath: join(dir, "openpalm.yaml"),
    gatewayEnvPath: join(dir, "gateway", ".env"),
    openmemoryEnvPath: join(dir, "openmemory", ".env"),
    postgresEnvPath: join(dir, "postgres", ".env"),
    qdrantEnvPath: join(dir, "qdrant", ".env"),
    assistantEnvPath: join(dir, "assistant", ".env"),
  });
}

describe("applyStack impact detection", () => {
  it("detects no impact when artifacts are unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);

    // First render writes artifacts
    manager.renderArtifacts();

    // Second apply (dry-run) should detect no changes
    const result = await applyStack(manager, { apply: false });
    expect(result.ok).toBe(true);
    expect(result.impact.reload).toHaveLength(0);
    expect(result.impact.restart).toHaveLength(0);
    expect(result.impact.up).toHaveLength(0);
  });

  it("detects caddy reload when caddyJson changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();

    // Mutate the caddy.json on disk to simulate old state
    const caddyPath = join(dir, "rendered", "caddy", "caddy.json");
    writeFileSync(caddyPath, '{"admin":{"disabled":true},"apps":{"http":{"servers":{}}}}', "utf8");

    const result = await applyStack(manager, { apply: false });
    expect(result.ok).toBe(true);
    expect(result.impact.reload).toContain("caddy");
  });

  it("detects restart for admin and gateway when systemEnv changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();

    // Mutate system.env on disk
    writeFileSync(join(dir, "system.env"), "# old\nOPENPALM_ACCESS_SCOPE=public\n", "utf8");

    const result = await applyStack(manager, { apply: false });
    expect(result.ok).toBe(true);
    expect(result.impact.restart).toContain("admin");
    expect(result.impact.restart).toContain("gateway");
  });

  it("detects restart for gateway when gatewayEnv changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();

    // Mutate gateway env
    writeFileSync(join(dir, "gateway", ".env"), "# old gateway env\n", "utf8");

    const result = await applyStack(manager, { apply: false });
    expect(result.ok).toBe(true);
    expect(result.impact.restart).toContain("gateway");
  });

  it("detects up for new services when compose changes with new service", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();

    // Write a minimal compose file missing channel-chat to simulate old state
    const composePath = join(dir, "docker-compose.yml");
    const currentCompose = readFileSync(composePath, "utf8");
    // Remove channel-chat from the compose file
    const oldCompose = currentCompose.replace(/\n\n\s*channel-chat:[\s\S]*?(?=\n\n\s*\w|$)/, "");
    writeFileSync(composePath, oldCompose, "utf8");

    const result = await applyStack(manager, { apply: false });
    expect(result.ok).toBe(true);
    // channel-chat should be in "up" since it's new (exists in generated, not in existing)
    expect(result.impact.up).toContain("channel-chat");
    // channel-chat should not be in "restart" since "up" takes precedence
    expect(result.impact.restart).not.toContain("channel-chat");
  });

  it("detects channel restart when channel env changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();

    // Mutate a channel env file
    const chatEnvPath = join(dir, "channel-chat", ".env");
    writeFileSync(chatEnvPath, "# old channel env\n", "utf8");

    const result = await applyStack(manager, { apply: false });
    expect(result.ok).toBe(true);
    // Channels with changed env should be in restart
    const channelRestarts = result.impact.restart.filter((s) => s.startsWith("channel-"));
    expect(channelRestarts.length).toBeGreaterThan(0);
  });

  it("throws when secrets reference is missing for enabled channel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    writeFileSync(join(dir, "secrets.env"), "\n", "utf8");
    writeFileSync(join(dir, "openpalm.yaml"), yamlStringify({
      version: 3,
      accessScope: "lan",
      channels: {
        chat: { enabled: true, exposure: "lan", config: { CHAT_INBOUND_TOKEN: "${MISSING}", CHANNEL_CHAT_SECRET: "" } },
        discord: { enabled: true, exposure: "lan", config: { DISCORD_BOT_TOKEN: "", DISCORD_PUBLIC_KEY: "", CHANNEL_DISCORD_SECRET: "" } },
        voice: { enabled: true, exposure: "lan", config: { CHANNEL_VOICE_SECRET: "" } },
        telegram: { enabled: true, exposure: "lan", config: { TELEGRAM_BOT_TOKEN: "", TELEGRAM_WEBHOOK_SECRET: "", CHANNEL_TELEGRAM_SECRET: "" } },
      },
      services: {},
      automations: [],
    }), "utf8");

    const manager = createManager(dir);
    expect(applyStack(manager, { apply: false })).rejects.toThrow("unresolved_secret_reference");
  });

  it("caddy reload path references caddy.json not Caddyfile", async () => {
    // Verify the apply engine code uses the correct caddy.json path
    // We test this by checking the import and inspecting the generated result structure
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();

    // The caddy.json file should exist at the rendered path
    const caddyJson = readFileSync(join(dir, "rendered", "caddy", "caddy.json"), "utf8");
    const config = JSON.parse(caddyJson);
    expect(config.admin.disabled).toBe(true);

    const result = await applyStack(manager, { apply: false });
    // Verify the generated artifacts reference caddyJson
    expect(result.generated.caddyJson).toBeDefined();
    expect(typeof result.generated.caddyJson).toBe("string");
    expect(JSON.parse(result.generated.caddyJson).admin.disabled).toBe(true);
  });
});
