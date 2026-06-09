/**
 * (#467) Guardian channel-gating contract.
 *
 * buildManagedServices encodes the deploy dependency contract:
 *   • assistant is ALWAYS deployed and depends on nothing,
 *   • guardian is deployed ONLY when ≥1 channel addon is enabled,
 *   • channels depend on guardian.
 *
 * A zero-channel install must deploy assistant alone — never include or
 * health-wait on guardian (the ~5-minute install hang the HIGH fix removed).
 * These tests pin the static-inference path (Docker-free) via
 * OP_SKIP_COMPOSE_PREFLIGHT.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildManagedServices } from "./lifecycle.js";
import type { ControlPlaneState } from "./types.js";

let tempDir: string;
let prevSkip: string | undefined;

function makeState(): ControlPlaneState {
  const configDir = join(tempDir, "config");
  return {
    homeDir: tempDir,
    configDir,
    stashDir: join(tempDir, "knowledge"),
    workspaceDir: join(tempDir, "workspace"),
    dataDir: join(tempDir, "data"),
    stackDir: join(configDir, "stack"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
  };
}

function seedStackEnv(enabledAddons: string): void {
  const envDir = join(tempDir, "knowledge", "env");
  mkdirSync(envDir, { recursive: true });
  writeFileSync(join(envDir, "stack.env"), `OP_ENABLED_ADDONS=${enabledAddons}\n`);
}

function seedChannelsCompose(): void {
  const stackDir = join(tempDir, "config", "stack");
  mkdirSync(stackDir, { recursive: true });
  // guardian + a channel service, both gated to the channel profile.
  writeFileSync(
    join(stackDir, "channels.compose.yml"),
    [
      "services:",
      "  guardian:",
      "    image: guardian",
      "    profiles: [\"addon.discord\"]",
      "  discord:",
      "    image: discord",
      "    profiles: [\"addon.discord\"]",
      "",
    ].join("\n"),
  );
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "guardian-gating-test-"));
  prevSkip = process.env.OP_SKIP_COMPOSE_PREFLIGHT;
  // Force the static-inference fallback — no Docker in unit tests.
  process.env.OP_SKIP_COMPOSE_PREFLIGHT = "1";
});

afterEach(() => {
  if (prevSkip === undefined) delete process.env.OP_SKIP_COMPOSE_PREFLIGHT;
  else process.env.OP_SKIP_COMPOSE_PREFLIGHT = prevSkip;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("buildManagedServices guardian gating", () => {
  it("zero-channel install deploys assistant alone, never guardian", async () => {
    seedStackEnv(""); // no addons enabled
    const services = await buildManagedServices(makeState());
    expect(services).toContain("assistant");
    expect(services).not.toContain("guardian");
  });

  it("a non-channel addon (ollama) still does NOT pull in guardian", async () => {
    seedStackEnv("ollama");
    const services = await buildManagedServices(makeState());
    expect(services).toContain("assistant");
    expect(services).not.toContain("guardian");
  });

  it("enabling a channel addon deploys guardian alongside the channel + assistant", async () => {
    seedStackEnv("discord");
    seedChannelsCompose();
    const services = await buildManagedServices(makeState());
    expect(services).toContain("assistant");
    expect(services).toContain("guardian");
    expect(services).toContain("discord");
  });
});
