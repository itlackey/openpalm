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

  it("detects Docker runtime", () => {
    expect(installSource).toContain("detectRuntime");
  });

  it("validates runtime before proceeding", () => {
    expect(installSource).toContain("validateRuntime(bin, subcommand)");
  });

  it("generates .env with secure tokens", () => {
    expect(installSource).toContain("writeFile(stateEnvFile, envSeed");
    expect(installSource).toContain("ADMIN_TOKEN: generatedAdminToken");
    expect(installSource).toContain("POSTGRES_PASSWORD: generateToken()");
    expect(installSource).toContain("BUILTIN_CHANNELS");
    expect(installSource).toContain("def.sharedSecretEnv");
    expect(installSource).toContain("channelSecrets");
  });

  it("runs typed preflight checks before proceeding", () => {
    expect(installSource).toContain("runPreflightChecksDetailed(bin, platform, ingressPort)");
    expect(installSource).toContain("noRuntimeGuidance");
    expect(installSource).toContain("noComposeGuidance");
  });

  it("uses typed preflight codes for fatal branching", () => {
    expect(installSource).toContain('i.code === "daemon_unavailable"');
    expect(installSource).toContain('i.code === "daemon_check_failed"');
    expect(installSource).toContain('i.code === "port_conflict"');
  });

  it("upserts XDG paths and runtime config into .env", () => {
    expect(installSource).toContain("upsertEnvVars(stateEnvFile,");
    expect(installSource).toContain("\"OPENPALM_DATA_HOME\", normPath(xdg.data)");
    expect(installSource).toContain("\"OPENPALM_CONFIG_HOME\", normPath(xdg.config)");
    expect(installSource).toContain("\"OPENPALM_STATE_HOME\", normPath(xdg.state)");
  });

  it("creates XDG directory tree", () => {
    expect(installSource).toContain("createDirectoryTree(xdg)");
  });

  it("seeds configuration files from embedded templates", () => {
    expect(installSource).toContain("seedConfigFiles(xdg.config)");
  });

  it("copies embedded full-stack compose to state directory", () => {
    expect(installSource).toContain("EMBEDDED_COMPOSE_PATH");
    expect(installSource).toContain("embeddedCompose");
  });

  it("writes Caddy JSON with full routing", () => {
    expect(installSource).toContain("caddy.json");
    expect(installSource).toContain("/channels/*");
    expect(installSource).toContain("admin:8100");
  });

  it("pulls and starts the full stack", () => {
    expect(installSource).toContain("composePull(composeConfig)");
    expect(installSource).toContain("composeUp(composeConfig, undefined");
  });

  it("health checks both admin and gateway", () => {
    expect(installSource).toContain("adminHealthy");
    expect(installSource).toContain("gatewayHealthy");
    expect(installSource).toContain("/health");
    expect(installSource).toContain("localhost:8080/health");
    expect(installSource).toContain("adminDirectUrl");
  });

  it("prints success message with API URLs", () => {
    expect(installSource).toContain("OpenPalm is running!");
    expect(installSource).toContain("Admin API:");
    expect(installSource).toContain("Gateway:");
    expect(installSource).toContain("Useful commands:");
  });

  it("does not reference setup wizard or browser auto-open", () => {
    expect(installSource).not.toContain("setup wizard");
    expect(installSource).not.toContain("setup-state.json");
    expect(installSource).not.toContain("noOpen");
    expect(installSource).not.toContain("xdg-open");
    expect(installSource).not.toContain("Bun.spawn([\"open\"");
  });

  it("does not reference podman", () => {
    expect(installSource).not.toContain("podman");
    expect(installSource).not.toContain("Podman");
  });
});
