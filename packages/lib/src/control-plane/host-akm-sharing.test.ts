import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enableHostAkmSharing,
  disableHostAkmSharing,
  getHostAkmSharingStatus,
} from "./host-akm-sharing.js";
import { HOST_SOURCE_NAME, OPENPALM_SOURCE_NAME } from "./akm-sources.js";
import type { ControlPlaneState } from "./types.js";

let root = "";
let state: ControlPlaneState;
let stackEnv = "";
let overlay = "";
let opConfig = "";
let hostConfig = "";
const HOST_STASH = "/home/u/akm";

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf-8"));
}
function seedHostConfig(obj: Record<string, unknown>): void {
  mkdirSync(join(root, "home", ".config", "akm"), { recursive: true });
  writeFileSync(hostConfig, JSON.stringify(obj, null, 2));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-akm-"));
  const configDir = join(root, "config");
  const stashDir = join(root, "knowledge");
  const stackDir = join(root, "config", "stack");
  mkdirSync(join(configDir, "akm"), { recursive: true });
  mkdirSync(join(stashDir, "env"), { recursive: true });
  mkdirSync(stackDir, { recursive: true });
  state = { configDir, stashDir, stackDir, homeDir: root } as ControlPlaneState;
  stackEnv = join(stashDir, "env", "stack.env");
  overlay = join(stackDir, "host-akm.compose.yml");
  opConfig = join(configDir, "akm", "config.json");
  hostConfig = join(root, "home", ".config", "akm", "config.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("enableHostAkmSharing", () => {
  it("writes env, materializes overlay, and adds both source entries", () => {
    seedHostConfig({ stashDir: HOST_STASH });
    enableHostAkmSharing(state, { hostStashPath: HOST_STASH, hostConfigPath: hostConfig, writable: true });

    expect(readFileSync(stackEnv, "utf-8")).toContain(`OP_HOST_AKM_STASH=${HOST_STASH}`);
    expect(existsSync(overlay)).toBe(true);
    expect(readFileSync(overlay, "utf-8")).toContain("/host-stash");
    expect((readJson(opConfig).sources as Array<Record<string, unknown>>)[0].name).toBe(HOST_SOURCE_NAME);
    expect((readJson(hostConfig).sources as Array<Record<string, unknown>>)[0].name).toBe(OPENPALM_SOURCE_NAME);
  });

  it("imports host profiles when importProfiles is set", () => {
    seedHostConfig({
      profiles: { llm: { default: { endpoint: "http://h/v1/chat/completions", model: "qwen" } } },
      defaults: { llm: "default" },
    });
    const { profilesImported } = enableHostAkmSharing(state, {
      hostStashPath: HOST_STASH,
      hostConfigPath: hostConfig,
      importProfiles: true,
    });
    expect(profilesImported).toContain("profiles.llm");
    expect(((readJson(opConfig).profiles as Record<string, Record<string, Record<string, unknown>>>).llm.default).model).toBe("qwen");
  });

  it("is idempotent", () => {
    seedHostConfig({ stashDir: HOST_STASH });
    enableHostAkmSharing(state, { hostStashPath: HOST_STASH, hostConfigPath: hostConfig });
    enableHostAkmSharing(state, { hostStashPath: HOST_STASH, hostConfigPath: hostConfig });
    expect((readJson(opConfig).sources as unknown[]).length).toBe(1);
    expect((readJson(hostConfig).sources as unknown[]).length).toBe(1);
  });

  it("sets the container side but throws fail-closed when the personal config is missing", () => {
    expect(() => enableHostAkmSharing(state, { hostStashPath: HOST_STASH, hostConfigPath: hostConfig })).toThrow();
    // Container-side state IS established (env, overlay, op config) before the throw.
    expect(existsSync(overlay)).toBe(true);
    expect((readJson(opConfig).sources as Array<Record<string, unknown>>)[0].name).toBe(HOST_SOURCE_NAME);
    expect(existsSync(hostConfig)).toBe(false); // never created
  });
});

describe("disableHostAkmSharing", () => {
  it("removes overlay, env key, and both source entries; never deletes stash content", () => {
    seedHostConfig({ stashDir: HOST_STASH });
    enableHostAkmSharing(state, { hostStashPath: HOST_STASH, hostConfigPath: hostConfig });
    disableHostAkmSharing(state, hostConfig);

    expect(existsSync(overlay)).toBe(false);
    expect(readFileSync(stackEnv, "utf-8")).not.toContain("OP_HOST_AKM_STASH");
    expect((readJson(opConfig).sources as unknown[]).length).toBe(0);
    expect((readJson(hostConfig).sources as unknown[]).length).toBe(0);
    // The personal config file itself still exists (only its source entry removed).
    expect(existsSync(hostConfig)).toBe(true);
  });

  it("is idempotent / safe when nothing is enabled", () => {
    writeFileSync(opConfig, "{}");
    expect(() => disableHostAkmSharing(state, hostConfig)).not.toThrow();
  });
});

describe("getHostAkmSharingStatus", () => {
  it("reports enabled after enable and disabled after disable", () => {
    seedHostConfig({ stashDir: HOST_STASH });
    expect(getHostAkmSharingStatus(state).enabled).toBe(false);
    enableHostAkmSharing(state, { hostStashPath: HOST_STASH, hostConfigPath: hostConfig });
    const s = getHostAkmSharingStatus(state);
    expect(s.enabled).toBe(true);
    expect(s.hostStashPath).toBe(HOST_STASH);
    expect(s.overlayPresent).toBe(true);
    disableHostAkmSharing(state, hostConfig);
    expect(getHostAkmSharingStatus(state).enabled).toBe(false);
  });
});
