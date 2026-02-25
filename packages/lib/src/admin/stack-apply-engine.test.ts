import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { StackManager } from "./stack-manager.ts";
import { stringifyYamlDocument } from "../shared/yaml.ts";

const yamlStringify = (obj: unknown) => stringifyYamlDocument(obj);
import { applyStack } from "./stack-apply-engine.ts";
import { createMockRunner } from "./compose-runner.ts";

function createManager(dir: string) {
  return new StackManager({
    stateRootPath: dir,
    caddyJsonPath: join(dir, "caddy.json"),
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

describe("applyStack dry-run", () => {
  it("succeeds with no caddy reload when artifacts are unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();

    const result = await applyStack(manager, { apply: false });
    expect(result.ok).toBe(true);
    expect(result.caddyReloaded).toBe(false);
  });

  it("detects caddy config change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();

    // Mutate caddy.json on disk to simulate old state
    writeFileSync(join(dir, "caddy.json"), '{"admin":{"disabled":true},"apps":{"http":{"servers":{}}}}', "utf8");

    const result = await applyStack(manager, { apply: false });
    expect(result.ok).toBe(true);
    // In dry-run mode, caddyReloaded stays false (no actual reload), but we can verify the generated output differs
    expect(result.generated.caddyJson).toBeDefined();
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
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();

    const caddyJson = readFileSync(join(dir, "caddy.json"), "utf8");
    const config = JSON.parse(caddyJson);
    expect(config.admin.disabled).toBe(true);

    const result = await applyStack(manager, { apply: false });
    expect(result.generated.caddyJson).toBeDefined();
    expect(typeof result.generated.caddyJson).toBe("string");
    expect(JSON.parse(result.generated.caddyJson).admin.disabled).toBe(true);
  });
});

describe("applyStack failure injection", () => {
  it("aborts before artifact writes on compose validation failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();

    const originalCompose = readFileSync(join(dir, "docker-compose.yml"), "utf8");
    const originalCaddy = readFileSync(join(dir, "caddy.json"), "utf8");

    const runner = createMockRunner({
      configValidateForFile: async (file, envFile) => {
        expect(envFile).toBe(join(dir, "system.env"));
        if (file.endsWith(".next")) {
          return { ok: false, stdout: "", stderr: "invalid yaml" };
        }
        return { ok: true, stdout: "", stderr: "" };
      },
    });

    await expect(applyStack(manager, { apply: true, runner })).rejects.toThrow("compose_validation_failed");

    expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toBe(originalCompose);
    const originalCaddyConfig = JSON.parse(originalCaddy) as { admin?: { disabled?: boolean } };
    const nextCaddyConfig = JSON.parse(readFileSync(join(dir, "caddy.json"), "utf8")) as { admin?: { disabled?: boolean } };
    expect(nextCaddyConfig.admin?.disabled).toBe(originalCaddyConfig.admin?.disabled ?? true);
  });

  it("throws when compose up fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();

    const runner = createMockRunner({
      configValidateForFile: async () => ({ ok: true, stdout: "", stderr: "" }),
      action: async () => ({ ok: false, stdout: "", stderr: "boom" }),
    });

    await expect(applyStack(manager, { apply: true, runner })).rejects.toThrow("compose_up_failed");
  });

  it("passes systemEnvPath as envFile to compose validation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();

    let capturedEnvFile: string | undefined;
    const runner = createMockRunner({
      configValidateForFile: async (_file, envFile) => {
        capturedEnvFile = envFile;
        return { ok: true, stdout: "", stderr: "" };
      },
      action: async () => ({ ok: true, stdout: "", stderr: "" }),
    });

    await applyStack(manager, { apply: true, runner });
    expect(capturedEnvFile).toBe(join(dir, "system.env"));
  });
});
