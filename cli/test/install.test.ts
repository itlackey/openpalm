import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const installSource = readFileSync("/home/user/openpalm/cli/src/commands/install.ts", "utf-8");

describe("install command source validation", () => {
  it("imports all required library modules", () => {
    expect(installSource).toContain("from \"../lib/runtime.ts\"");
    expect(installSource).toContain("from \"../lib/paths.ts\"");
    expect(installSource).toContain("from \"../lib/env.ts\"");
    expect(installSource).toContain("from \"../lib/tokens.ts\"");
    expect(installSource).toContain("from \"../lib/compose.ts\"");
    expect(installSource).toContain("from \"../lib/assets.ts\"");
    expect(installSource).toContain("from \"../lib/detect-providers.ts\"");
    expect(installSource).toContain("from \"../lib/ui.ts\"");
  });

  it("detects OS and rejects unknown/windows", () => {
    expect(installSource).toContain("detectOS()");
    expect(installSource).toContain("os === \"unknown\"");
    expect(installSource).toContain("os === \"windows-bash\"");
    expect(installSource).toContain("Unable to detect operating system");
    expect(installSource).toContain("Windows detected");
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

  it("resolves assets with optional ref override", () => {
    expect(installSource).toContain("resolveAssets(options.ref)");
  });

  it("generates .env from template with secure tokens", () => {
    expect(installSource).toContain("generateEnvFromTemplate");
    expect(installSource).toContain("ADMIN_TOKEN: generateToken()");
    expect(installSource).toContain("CONTROLLER_TOKEN: generateToken()");
    expect(installSource).toContain("POSTGRES_PASSWORD: generateToken()");
    expect(installSource).toContain("CHANNEL_CHAT_SECRET: generateToken()");
    expect(installSource).toContain("CHANNEL_DISCORD_SECRET: generateToken()");
    expect(installSource).toContain("CHANNEL_VOICE_SECRET: generateToken()");
    expect(installSource).toContain("CHANNEL_TELEGRAM_SECRET: generateToken()");
  });

  it("upserts XDG paths and runtime config into .env", () => {
    expect(installSource).toContain("upsertEnvVar(envPath, \"OPENPALM_DATA_HOME\", xdg.data)");
    expect(installSource).toContain("upsertEnvVar(envPath, \"OPENPALM_CONFIG_HOME\", xdg.config)");
    expect(installSource).toContain("upsertEnvVar(envPath, \"OPENPALM_STATE_HOME\", xdg.state)");
    expect(installSource).toContain("upsertEnvVar(envPath, \"OPENPALM_CONTAINER_PLATFORM\", platform)");
    expect(installSource).toContain("upsertEnvVar(envPath, \"OPENPALM_COMPOSE_BIN\", bin)");
    expect(installSource).toContain("upsertEnvVar(envPath, \"OPENPALM_COMPOSE_SUBCOMMAND\", subcommand)");
    expect(installSource).toContain("upsertEnvVar(envPath, \"OPENPALM_CONTAINER_SOCKET_PATH\", socketPath)");
    expect(installSource).toContain("upsertEnvVar(envPath, \"OPENPALM_IMAGE_TAG\"");
  });

  it("creates XDG directory tree", () => {
    expect(installSource).toContain("createDirectoryTree(xdg)");
  });

  it("seeds configuration files", () => {
    expect(installSource).toContain("seedConfigFiles(assetsDir, xdg.config)");
  });

  it("detects all AI providers during install", () => {
    expect(installSource).toContain("detectAllProviders()");
  });

  it("writes provider seed file for admin setup wizard", () => {
    expect(installSource).toContain("writeProviderSeedFile");
    expect(installSource).toContain("detected-providers.json");
  });

  it("offers small model selection when candidates available", () => {
    expect(installSource).toContain("getSmallModelCandidates");
    expect(installSource).toContain("select(");
    expect(installSource).toContain("OPENPALM_SMALL_MODEL");
  });
});

describe("staged install flow - Phase 2: Early UI access", () => {
  it("starts ONLY core services first (caddy, postgres, admin, controller)", () => {
    expect(installSource).toContain("const coreServices = [\"caddy\", \"postgres\", \"admin\", \"controller\"]");
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
    // Verify health check loop exists
    expect(installSource).toContain("/api/setup/status");
    expect(installSource).toContain("healthy = true");

    // Verify browser open comes after health check
    const healthCheckIdx = installSource.indexOf("healthy = true");
    const openBrowserIdx = installSource.indexOf("if (!options.noOpen && healthy)");
    expect(healthCheckIdx).toBeGreaterThan(-1);
    expect(openBrowserIdx).toBeGreaterThan(-1);
    expect(healthCheckIdx).toBeLessThan(openBrowserIdx);
  });

  it("opens browser to admin URL (unless --no-open)", () => {
    expect(installSource).toContain("options.noOpen");
    expect(installSource).toContain("os === \"macos\"");
    expect(installSource).toContain("Bun.spawn([\"open\", adminUrl])");
    expect(installSource).toContain("Bun.spawn([\"xdg-open\", adminUrl])");
  });
});

describe("staged install flow - Phase 3: Background pull", () => {
  it("pulls ALL remaining images after core services are running", () => {
    // First composePull with coreServices
    const corePullIdx = installSource.indexOf("composePull(composeConfig, coreServices)");

    // Second composePull without service filter (pulls all)
    const fullPullIdx = installSource.indexOf("await composePull(composeConfig);");

    expect(corePullIdx).toBeGreaterThan(-1);
    expect(fullPullIdx).toBeGreaterThan(-1);
    expect(corePullIdx).toBeLessThan(fullPullIdx);
  });
});

describe("staged install flow - Phase 4: Full stack", () => {
  it("starts all services after pull completes", () => {
    const fullPullIdx = installSource.indexOf("await composePull(composeConfig);");
    const fullUpIdx = installSource.indexOf("composeUp(composeConfig, undefined");

    expect(fullPullIdx).toBeGreaterThan(-1);
    expect(fullUpIdx).toBeGreaterThan(-1);
    expect(fullPullIdx).toBeLessThan(fullUpIdx);
  });

  it("prints service URLs in final summary", () => {
    expect(installSource).toContain("Service URLs:");
    expect(installSource).toContain("Admin:");
    expect(installSource).toContain("adminUrl");
  });

  it("prints XDG paths in final summary", () => {
    const summaryStartIdx = installSource.indexOf("Installation complete!");
    const dataPathIdx = installSource.indexOf("xdg.data", summaryStartIdx);
    const configPathIdx = installSource.indexOf("xdg.config", summaryStartIdx);
    const statePathIdx = installSource.indexOf("xdg.state", summaryStartIdx);

    expect(summaryStartIdx).toBeGreaterThan(-1);
    expect(dataPathIdx).toBeGreaterThan(summaryStartIdx);
    expect(configPathIdx).toBeGreaterThan(summaryStartIdx);
    expect(statePathIdx).toBeGreaterThan(summaryStartIdx);
  });
});

describe("staged flow ordering", () => {
  it("Phase 1 comes before Phase 2", () => {
    const detectProvidersIdx = installSource.indexOf("detectAllProviders()");
    const writeSeedIdx = installSource.indexOf("writeProviderSeedFile");
    const firstPullIdx = installSource.indexOf("composePull(composeConfig, coreServices)");

    expect(detectProvidersIdx).toBeGreaterThan(-1);
    expect(writeSeedIdx).toBeGreaterThan(-1);
    expect(firstPullIdx).toBeGreaterThan(-1);
    expect(detectProvidersIdx).toBeLessThan(firstPullIdx);
    expect(writeSeedIdx).toBeLessThan(firstPullIdx);
  });

  it("Phase 2 (core services) comes before Phase 3 (full pull)", () => {
    const coreUpIdx = installSource.indexOf("composeUp(composeConfig, coreServices");
    const fullPullIdx = installSource.indexOf("await composePull(composeConfig);");

    expect(coreUpIdx).toBeGreaterThan(-1);
    expect(fullPullIdx).toBeGreaterThan(-1);
    expect(coreUpIdx).toBeLessThan(fullPullIdx);
  });

  it("Phase 3 (full pull) comes before Phase 4 (full start)", () => {
    const fullPullIdx = installSource.indexOf("await composePull(composeConfig);");
    const fullUpIdx = installSource.indexOf("composeUp(composeConfig, undefined");

    expect(fullPullIdx).toBeGreaterThan(-1);
    expect(fullUpIdx).toBeGreaterThan(-1);
    expect(fullPullIdx).toBeLessThan(fullUpIdx);
  });

  it("core services are a minimal subset", () => {
    // Verify the exact core services list
    expect(installSource).toContain("const coreServices = [\"caddy\", \"postgres\", \"admin\", \"controller\"]");

    // Count the number of services (should be exactly 4)
    const coreServicesMatch = installSource.match(/const coreServices = \[(.*?)\]/);
    expect(coreServicesMatch).toBeTruthy();

    if (coreServicesMatch) {
      const servicesList = coreServicesMatch[1];
      const servicesCount = (servicesList.match(/"/g) || []).length / 2; // Count pairs of quotes
      expect(servicesCount).toBe(4);
    }
  });
});
