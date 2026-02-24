import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const installSource = readFileSync(join(import.meta.dir, "../src/commands/install.ts"), "utf-8");

describe("install command source validation", () => {
  it("imports all required library modules", () => {
    expect(installSource).toContain("from \"@openpalm/lib/runtime.ts\"");
    expect(installSource).toContain("from \"@openpalm/lib/paths.ts\"");
    expect(installSource).toContain("from \"@openpalm/lib/env.ts\"");
    expect(installSource).toContain("from \"@openpalm/lib/tokens.ts\"");
    expect(installSource).toContain("from \"@openpalm/lib/compose.ts\"");
    expect(installSource).toContain("from \"@openpalm/lib/assets.ts\"");
    expect(installSource).toContain("from \"@openpalm/lib/preflight.ts\"");
    expect(installSource).toContain("from \"@openpalm/lib/ui.ts\"");
  });

  it("detects OS and rejects unknown", () => {
    expect(installSource).toContain("detectOS()");
    expect(installSource).toContain("os === \"unknown\"");
    expect(installSource).toContain("Unable to detect operating system");
  });

  it("detects CPU architecture", () => {
    expect(installSource).toContain("detectArch()");
  });

  it("detects container runtime with manual override", () => {
    expect(installSource).toContain("options.runtime");
    expect(installSource).toContain("detectRuntime");
  });

  it("validates runtime before proceeding", () => {
    expect(installSource).toContain("validateRuntime(bin, subcommand)");
  });

  it("generates .env with secure tokens", () => {
    expect(installSource).toContain("writeFile(stateEnvFile, envSeed");
    expect(installSource).toContain("ADMIN_TOKEN: generatedAdminToken");
    expect(installSource).toContain("POSTGRES_PASSWORD: generateToken()");
    // Channel secrets are now derived from BUILTIN_CHANNELS dynamically
    expect(installSource).toContain("BUILTIN_CHANNELS");
    expect(installSource).toContain("def.sharedSecretEnv");
    expect(installSource).toContain("channelSecrets");
  });

  it("runs preflight checks before proceeding", () => {
    expect(installSource).toContain("runPreflightChecks(bin, platform, ingressPort)");
    expect(installSource).toContain("noRuntimeGuidance");
    expect(installSource).toContain("noComposeGuidance");
  });

  it("displays admin token info when generated", () => {
    expect(installSource).toContain("temporary admin token");
    expect(installSource).toContain("generatedAdminToken");
  });

  it("upserts XDG paths and runtime config into .env", () => {
    expect(installSource).toContain("upsertEnvVars(stateEnvFile,");
    expect(installSource).toContain("\"OPENPALM_DATA_HOME\", normPath(xdg.data)");
    expect(installSource).toContain("\"OPENPALM_CONFIG_HOME\", normPath(xdg.config)");
    expect(installSource).toContain("\"OPENPALM_STATE_HOME\", normPath(xdg.state)");
    expect(installSource).toContain("\"OPENPALM_CONTAINER_PLATFORM\", platform");
    expect(installSource).toContain("\"OPENPALM_COMPOSE_BIN\", bin");
    expect(installSource).toContain("\"OPENPALM_COMPOSE_SUBCOMMAND\", subcommand");
    expect(installSource).toContain("\"OPENPALM_CONTAINER_SOCKET_PATH\", socketPath");
    expect(installSource).toContain("\"OPENPALM_IMAGE_TAG\"");
  });

  it("creates XDG directory tree", () => {
    expect(installSource).toContain("createDirectoryTree(xdg)");
  });

  it("seeds configuration files from embedded templates", () => {
    expect(installSource).toContain("seedConfigFiles(xdg.config)");
  });

  it("resets admin setup wizard state on install/reinstall", () => {
    expect(installSource).toContain("rm(join(xdg.data, \"admin\", \"setup-state.json\"), { force: true })");
  });
});

describe("staged install flow - Phase 2: Early UI access", () => {
  it("starts ONLY core services first (caddy, admin)", () => {
    expect(installSource).toContain("const coreServices = [\"caddy\", \"admin\"]");
    expect(installSource).toContain("composePull(composeConfig, coreServices)");
  });

  it("pulls core service images before starting them", () => {
    const pullIdx = installSource.indexOf("composePull(composeConfig, coreServices)");
    const upIdx = installSource.indexOf("composeUp(composeConfig, coreServices");

    expect(pullIdx).toBeGreaterThan(-1);
    expect(upIdx).toBeGreaterThan(-1);
    expect(pullIdx).toBeLessThan(upIdx);
  });

  it("waits for admin health check before opening browser", () => {
    expect(installSource).toContain("/setup/status");
    expect(installSource).toContain("healthy = true");

    const healthCheckIdx = installSource.indexOf("healthy = true");
    const openBrowserIdx = installSource.indexOf("if (!options.noOpen && healthy)");
    expect(healthCheckIdx).toBeGreaterThan(-1);
    expect(openBrowserIdx).toBeGreaterThan(-1);
    expect(healthCheckIdx).toBeLessThan(openBrowserIdx);
  });

  it("opens browser to admin URL (unless --no-open)", () => {
    expect(installSource).toContain("options.noOpen");
    expect(installSource).toContain("os === \"macos\"");
    expect(installSource).toContain("os === \"linux\"");
    expect(installSource).toContain("Bun.spawn([\"open\", adminUrl])");
    expect(installSource).toContain("Bun.spawn([\"xdg-open\", adminUrl])");
    expect(installSource).toContain("Bun.spawn([\"cmd\"");
  });

  it("prints success message with next steps", () => {
    expect(installSource).toContain("OpenPalm setup wizard is ready!");
    expect(installSource).toContain("What happens next:");
    expect(installSource).toContain("Setup wizard");
    expect(installSource).toContain("Useful commands:");
    expect(installSource).toContain("openpalm logs");
    expect(installSource).toContain("openpalm stop");
    expect(installSource).toContain("openpalm uninstall");
  });

  it("prints troubleshooting guidance when setup times out", () => {
    expect(installSource).toContain("Setup did not come online within 3 minutes");
    expect(installSource).toContain("openpalm status");
    expect(installSource).toContain("Common fixes:");
  });
});

describe("staged flow ordering", () => {
  it("core services are a minimal subset", () => {
    expect(installSource).toContain("const coreServices = [\"caddy\", \"admin\"]");

    const coreServicesMatch = installSource.match(/const coreServices = \[(.*?)\]/);
    expect(coreServicesMatch).toBeTruthy();

    if (coreServicesMatch) {
      const servicesList = coreServicesMatch[1];
      const servicesCount = (servicesList.match(/"/g) || []).length / 2;
      expect(servicesCount).toBe(2);
    }
  });
});
