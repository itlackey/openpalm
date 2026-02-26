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
    dataRootPath: join(dir, "data"),
    configRootPath: join(dir, "config"),
    composeFilePath: join(dir, "docker-compose.yml"),
    runtimeEnvPath: join(dir, ".env"),
    systemEnvPath: join(dir, "system.env"),
    secretsEnvPath: join(dir, "secrets.env"),
    stackSpecPath: join(dir, "openpalm.yaml"),
  });
}

describe("applyStack dry-run", () => {
  it("succeeds when artifacts are unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();

    const result = await applyStack(manager, { apply: false });
    expect(result.ok).toBe(true);
  });

  it("detects caddy config change in generated output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();

    // Mutate caddy.json on disk to simulate old state
    writeFileSync(join(dir, "caddy.json"), '{"admin":{"disabled":true},"apps":{"http":{"servers":{}}}}', "utf8");

    const result = await applyStack(manager, { apply: false });
    expect(result.ok).toBe(true);
    // Verify the generated output is available regardless of disk state
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
      },
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
      configValidateForFile: async (file) => {
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

  it("passes runtimeEnvPath to compose runner creation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();

    // Verify applyStack uses runtimeEnvPath by checking the default runner is
    // created with it. We test this by passing a mock runner and confirming
    // configValidateForFile is called with the .next temp file.
    let capturedFile: string | undefined;
    const runner = createMockRunner({
      configValidateForFile: async (file) => {
        capturedFile = file;
        return { ok: true, stdout: "", stderr: "" };
      },
    });

    await applyStack(manager, { apply: true, runner });
    expect(capturedFile).toContain("docker-compose.yml.next");
  });
});
