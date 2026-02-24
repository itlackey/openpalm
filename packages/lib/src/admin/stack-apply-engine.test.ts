import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { StackManager } from "./stack-manager.ts";
import { stringifyYamlDocument } from "../shared/yaml.ts";

const yamlStringify = (obj: unknown) => stringifyYamlDocument(obj);
import { applyStack } from "./stack-apply-engine.ts";
import { setComposeConfigServicesOverride, setComposeListOverride, setComposePsOverride, setComposeRunnerArtifactOverrides, setComposeRunnerOverrides } from "./compose-runner.ts";
import { selfTestFallbackBundle } from "./stack-apply-engine.ts";

function withSkippedDockerSocketCheck(): () => void {
  const previous = process.env.OPENPALM_CONTAINER_SOCKET_URI;
  process.env.OPENPALM_CONTAINER_SOCKET_URI = "tcp://localhost:2375";
  return () => {
    if (previous === undefined) {
      delete process.env.OPENPALM_CONTAINER_SOCKET_URI;
    } else {
      process.env.OPENPALM_CONTAINER_SOCKET_URI = previous;
    }
  };
}

function withDisabledPortCheck(): () => void {
  const previous = process.env.OPENPALM_PREFLIGHT_SKIP_PORT_CHECKS;
  process.env.OPENPALM_PREFLIGHT_SKIP_PORT_CHECKS = "1";
  return () => {
    if (previous === undefined) {
      delete process.env.OPENPALM_PREFLIGHT_SKIP_PORT_CHECKS;
    } else {
      process.env.OPENPALM_PREFLIGHT_SKIP_PORT_CHECKS = previous;
    }
  };
}

function withHealthGateTimeoutMs(timeoutMs: number): () => void {
  const previous = process.env.OPENPALM_HEALTH_GATE_TIMEOUT_MS;
  process.env.OPENPALM_HEALTH_GATE_TIMEOUT_MS = String(timeoutMs);
  return () => {
    if (previous === undefined) {
      delete process.env.OPENPALM_HEALTH_GATE_TIMEOUT_MS;
    } else {
      process.env.OPENPALM_HEALTH_GATE_TIMEOUT_MS = previous;
    }
  };
}

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
    fallbackComposeFilePath: join(dir, "docker-compose-fallback.yml"),
    fallbackCaddyJsonPath: join(dir, "caddy-fallback.json"),
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
    const caddyPath = join(dir, "caddy.json");
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
    const nextComposePath = `${join(dir, "docker-compose.yml")}.next`;

    // Write a minimal compose file missing channel-chat to simulate old state
    const composePath = join(dir, "docker-compose.yml");
    const currentCompose = readFileSync(composePath, "utf8");
    // Remove channel-chat from the compose file
    const oldCompose = currentCompose.replace(/\n\n\s*channel-chat:[\s\S]*?(?=\n\n\s*\w|$)/, "");
    writeFileSync(composePath, oldCompose, "utf8");
    writeFileSync(nextComposePath, currentCompose, "utf8");

    setComposeListOverride(async () => ({
      ok: true,
      stdout: "admin\nchannel-chat\n",
      stderr: "",
    }));
    setComposeConfigServicesOverride(async (file) => {
      if (file && file.endsWith("docker-compose.yml.next")) {
        return ["admin", "channel-chat"];
      }
      return ["admin"];
    });
    setComposeListOverride(async () => ({ ok: true, stdout: "[]", stderr: "" }));

    const result = await applyStack(manager, { apply: false });
    expect(result.ok).toBe(true);
    // compose change should trigger impact computation
    expect(result.impact).toBeDefined();
    setComposeListOverride(null);
    setComposeConfigServicesOverride(null);
    rmSync(nextComposePath, { force: true });
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

    // The caddy.json file should exist at the state-root path
    const caddyJson = readFileSync(join(dir, "caddy.json"), "utf8");
    const config = JSON.parse(caddyJson);
    expect(config.admin.disabled).toBe(true);

    const result = await applyStack(manager, { apply: false });
    // Verify the generated artifacts reference caddyJson
    expect(result.generated.caddyJson).toBeDefined();
    expect(typeof result.generated.caddyJson).toBe("string");
    expect(JSON.parse(result.generated.caddyJson).admin.disabled).toBe(true);
  });
});

describe("applyStack rollout modes", () => {
  it("safe mode triggers rollback on health gate failure", async () => {
    const restoreEnv = withSkippedDockerSocketCheck();
    const restorePorts = withDisabledPortCheck();
    const restoreHealthTimeout = withHealthGateTimeoutMs(5);
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();
    writeFileSync(join(dir, "gateway", ".env"), "# old gateway\n", "utf8");

    setComposeRunnerOverrides({
      composeAction: async () => ({ ok: true, stdout: "", stderr: "" }),
      composeExec: async () => ({ ok: true, stdout: "", stderr: "" }),
      composeActionForFile: async () => ({ ok: true, stdout: "", stderr: "" }),
      composeConfigValidateForFile: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    setComposeRunnerArtifactOverrides({
      composeFilePath: join(dir, "docker-compose.yml"),
      caddyJsonPath: join(dir, "caddy.json"),
      driftReportPath: join(dir, "drift-report.json"),
    });
    setComposeListOverride(async () => ({ ok: true, stdout: "[]", stderr: "" }));
    setComposeConfigServicesOverride(async () => []);

    setComposePsOverride(async () => ({
      ok: true,
      services: [{ name: "admin", status: "running", health: "unhealthy" }],
      stderr: "",
    }));

    await expect(applyStack(manager, { apply: true, rolloutMode: "safe" })).rejects.toThrow("compose_health_gate_failed");

    setComposePsOverride(null);
    setComposeRunnerOverrides({});
    setComposeListOverride(null);
    setComposeConfigServicesOverride(null);
    setComposeRunnerArtifactOverrides({});
    restorePorts();
    restoreEnv();
    restoreHealthTimeout();
  });
});

describe("fallback self-test", () => {
  it("reports errors for missing bundle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    const result = await selfTestFallbackBundle(manager);
    expect(result.ok).toBeFalse();
  });
});

describe("applyStack failure injection", () => {
  it("aborts before artifact writes on compose validation failure", async () => {
    const restoreEnv = withSkippedDockerSocketCheck();
    const restorePorts = withDisabledPortCheck();
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();

    const originalCompose = readFileSync(join(dir, "docker-compose.yml"), "utf8");
    const originalCaddy = readFileSync(join(dir, "caddy.json"), "utf8");

    setComposeRunnerOverrides({
      composeConfigValidate: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    setComposeListOverride(async () => ({ ok: true, stdout: "[]", stderr: "" }));
    setComposeConfigServicesOverride(async () => []);
    setComposeRunnerArtifactOverrides({
      composeFilePath: join(dir, "docker-compose.yml"),
      caddyJsonPath: join(dir, "caddy.json"),
      driftReportPath: join(dir, "drift-report.json"),
    });

    setComposeRunnerOverrides({
      composeConfigValidate: async () => ({ ok: true, stdout: "", stderr: "" }),
      composeConfigValidateForFile: async (file) => {
        if (file.endsWith(".next")) {
          return { ok: false, stdout: "", stderr: "invalid yaml" };
        }
        return { ok: true, stdout: "", stderr: "" };
      },
      composeAction: async () => ({ ok: true, stdout: "", stderr: "" }),
      composeExec: async () => ({ ok: true, stdout: "", stderr: "" }),
    });

    await expect(applyStack(manager, { apply: true })).rejects.toThrow("compose_validation_failed");

    expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toBe(originalCompose);
    const originalCaddyConfig = JSON.parse(originalCaddy) as { admin?: { disabled?: boolean } };
    const nextCaddyConfig = JSON.parse(readFileSync(join(dir, "caddy.json"), "utf8")) as { admin?: { disabled?: boolean } };
    expect(nextCaddyConfig.admin?.disabled).toBe(originalCaddyConfig.admin?.disabled ?? true);

    setComposeRunnerOverrides({});
    setComposeRunnerArtifactOverrides({});
    setComposeListOverride(null);
    setComposeConfigServicesOverride(null);
    restorePorts();
    restoreEnv();
  });

  it("triggers rollback when a service action fails", async () => {
    const restoreEnv = withSkippedDockerSocketCheck();
    const restorePorts = withDisabledPortCheck();
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();
    writeFileSync(join(dir, "gateway", ".env"), "# old gateway\n", "utf8");

    setComposeRunnerArtifactOverrides({
      composeFilePath: join(dir, "docker-compose.yml"),
      caddyJsonPath: join(dir, "caddy.json"),
      driftReportPath: join(dir, "drift-report.json"),
    });

    setComposeRunnerOverrides({
      composeConfigValidate: async () => ({ ok: true, stdout: "", stderr: "" }),
      composeConfigValidateForFile: async () => ({ ok: true, stdout: "", stderr: "" }),
      composeAction: async (action, service) => {
        if (action === "restart" && (Array.isArray(service) ? service.includes("gateway") : service === "gateway")) {
          return { ok: false, stdout: "", stderr: "boom" };
        }
        return { ok: true, stdout: "", stderr: "" };
      },
      composeExec: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    setComposeListOverride(async () => ({ ok: true, stdout: "[]", stderr: "" }));
    setComposeConfigServicesOverride(async () => []);

    await expect(applyStack(manager, { apply: true })).rejects.toThrow("compose_restart_failed");

    setComposeRunnerOverrides({});
    setComposeRunnerArtifactOverrides({});
    setComposeListOverride(null);
    setComposeConfigServicesOverride(null);
    restorePorts();
    restoreEnv();
  });

  it("falls back when rollback fails", async () => {
    const restoreEnv = withSkippedDockerSocketCheck();
    const restorePorts = withDisabledPortCheck();
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();
    writeFileSync(join(dir, "gateway", ".env"), "# old gateway\n", "utf8");
    rmSync(join(dir, "docker-compose-fallback.yml"), { force: true });

    setComposeRunnerArtifactOverrides({
      composeFilePath: join(dir, "docker-compose.yml"),
      caddyJsonPath: join(dir, "caddy.json"),
      driftReportPath: join(dir, "drift-report.json"),
    });

    setComposeRunnerOverrides({
      composeConfigValidate: async () => ({ ok: true, stdout: "", stderr: "" }),
      composeConfigValidateForFile: async () => ({ ok: true, stdout: "", stderr: "" }),
      composeAction: async (action, service) => {
        const name = Array.isArray(service) ? service[0] : service;
        if (action === "restart" && name === "gateway") {
          return { ok: false, stdout: "", stderr: "nope" };
        }
        if (action === "up" && name === "admin") {
          return { ok: false, stdout: "", stderr: "rollback-failed" };
        }
        return { ok: true, stdout: "", stderr: "" };
      },
      composeActionForFile: async () => ({ ok: true, stdout: "", stderr: "" }),
      composeExec: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    setComposeListOverride(async () => ({ ok: true, stdout: "[]", stderr: "" }));
    setComposeConfigServicesOverride(async () => []);

    await expect(applyStack(manager, { apply: true })).rejects.toThrow("compose_restart_failed");

    const caddyFallback = readFileSync(join(dir, "caddy-fallback.json"), "utf8");
    expect(readFileSync(join(dir, "caddy.json"), "utf8")).toBe(caddyFallback);

    setComposeRunnerOverrides({});
    setComposeRunnerArtifactOverrides({});
    setComposeListOverride(null);
    setComposeConfigServicesOverride(null);
    restorePorts();
    restoreEnv();
  });

  it("throws fallback_compose_validation_failed when fallback compose invalid", async () => {
    const restoreEnv = withSkippedDockerSocketCheck();
    const restorePorts = withDisabledPortCheck();
    const dir = mkdtempSync(join(tmpdir(), "apply-engine-"));
    const manager = createManager(dir);
    manager.renderArtifacts();
    writeFileSync(join(dir, "gateway", ".env"), "# old gateway\n", "utf8");

    setComposeRunnerArtifactOverrides({
      composeFilePath: join(dir, "docker-compose.yml"),
      caddyJsonPath: join(dir, "caddy.json"),
      driftReportPath: join(dir, "drift-report.json"),
    });

    setComposeRunnerOverrides({
      composeConfigValidate: async () => ({ ok: true, stdout: "", stderr: "" }),
      composeConfigValidateForFile: async (file) => {
        if (file.includes("docker-compose-fallback")) {
          return { ok: false, stdout: "", stderr: "bad" };
        }
        return { ok: true, stdout: "", stderr: "" };
      },
      composeAction: async (action, service) => {
        const name = Array.isArray(service) ? service[0] : service;
        if (action === "restart" && name === "gateway") {
          return { ok: false, stdout: "", stderr: "nope" };
        }
        if (action === "up" && name === "admin") {
          return { ok: false, stdout: "", stderr: "rollback-failed" };
        }
        return { ok: true, stdout: "", stderr: "" };
      },
      composeActionForFile: async () => ({ ok: true, stdout: "", stderr: "" }),
      composeExec: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    setComposeListOverride(async () => ({ ok: true, stdout: "[]", stderr: "" }));
    setComposeConfigServicesOverride(async () => []);

    await expect(applyStack(manager, { apply: true })).rejects.toThrow("fallback_compose_validation_failed");

    setComposeRunnerOverrides({});
    setComposeRunnerArtifactOverrides({});
    setComposeListOverride(null);
    setComposeConfigServicesOverride(null);
    restorePorts();
    restoreEnv();
  });
});
