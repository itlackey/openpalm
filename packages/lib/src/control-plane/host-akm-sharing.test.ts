import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enableHostAkmSharing,
  disableHostAkmSharing,
  getHostAkmSharingStatus,
  ensureHostStashEnv,
  isHostAkmAvailable,
} from "./host-akm-sharing.js";
import { HOST_SOURCE_NAME } from "./akm-sources.js";
import type { ControlPlaneState } from "./types.js";

let root = "";
let fakeHome = "";
let state: ControlPlaneState;
let stackEnv = "";
let opConfig = "";
const savedHome = process.env.HOME;

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf-8"));
}
/** Make the host look like it has (or hasn't) an initialized AKM. */
function setHostAkm(available: boolean): void {
  if (available) {
    mkdirSync(join(fakeHome, "akm"), { recursive: true });
    mkdirSync(join(fakeHome, ".config", "akm"), { recursive: true });
    writeFileSync(join(fakeHome, ".config", "akm", "config.json"), JSON.stringify({ stashDir: join(fakeHome, "akm") }));
  }
}
function opSources(): Array<Record<string, unknown>> {
  if (!existsSync(opConfig)) return [];
  return (readJson(opConfig).sources as Array<Record<string, unknown>>) ?? [];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-akm-"));
  fakeHome = join(root, "home");
  mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
  const configDir = join(root, "config");
  const stashDir = join(root, "knowledge");
  mkdirSync(join(configDir, "akm"), { recursive: true });
  mkdirSync(join(stashDir, "env"), { recursive: true });
  state = { configDir, stashDir, dataDir: join(root, "data"), homeDir: root } as ControlPlaneState;
  stackEnv = join(stashDir, "env", "stack.env");
  opConfig = join(configDir, "akm", "config.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env.OP_HOST_AKM_STASH;
});

describe("isHostAkmAvailable", () => {
  it("is false without a personal akm config, true with one", () => {
    expect(isHostAkmAvailable()).toBe(false);
    setHostAkm(true);
    expect(isHostAkmAvailable()).toBe(true);
  });
});

describe("ensureHostStashEnv", () => {
  it("sets OP_HOST_AKM_STASH to ~/akm when available", () => {
    setHostAkm(true);
    ensureHostStashEnv(state);
    expect(readFileSync(stackEnv, "utf-8")).toContain(`OP_HOST_AKM_STASH=${join(fakeHome, "akm")}`);
  });

  it("removes OP_HOST_AKM_STASH when not available (→ compose empty-dir fallback)", () => {
    writeFileSync(stackEnv, "OP_HOST_AKM_STASH=/stale/path\nOP_ASSISTANT_VERSION=x\n");
    ensureHostStashEnv(state);
    const env = readFileSync(stackEnv, "utf-8");
    expect(env).not.toContain("OP_HOST_AKM_STASH");
    expect(env).toContain("OP_ASSISTANT_VERSION=x");
  });
});

describe("enableHostAkmSharing", () => {
  it("sets env + adds the writable host-akm source when available", () => {
    setHostAkm(true);
    enableHostAkmSharing(state);
    expect(readFileSync(stackEnv, "utf-8")).toContain(`OP_HOST_AKM_STASH=${join(fakeHome, "akm")}`);
    const src = opSources().find((s) => s.name === HOST_SOURCE_NAME);
    expect(src).toBeDefined();
    expect(src!.writable).toBe(true);
    expect(src!.path).toBe("/host-stash");
  });

  it("throws when host AKM is not available (never writes a source)", () => {
    expect(() => enableHostAkmSharing(state)).toThrow();
    expect(opSources()).toHaveLength(0);
  });

  it("imports host profiles when importProfiles is set", () => {
    setHostAkm(true);
    writeFileSync(join(fakeHome, ".config", "akm", "config.json"), JSON.stringify({
      stashDir: join(fakeHome, "akm"),
      profiles: { llm: { default: { endpoint: "http://h/v1/chat/completions", model: "qwen" } } },
      defaults: { llm: "default" },
    }));
    const { profilesImported } = enableHostAkmSharing(state, { importProfiles: true });
    expect(profilesImported).toContain("profiles.llm");
    expect(((readJson(opConfig).profiles as Record<string, Record<string, Record<string, unknown>>>).llm.default).model).toBe("qwen");
  });

  it("is idempotent", () => {
    setHostAkm(true);
    enableHostAkmSharing(state);
    enableHostAkmSharing(state);
    expect(opSources().filter((s) => s.name === HOST_SOURCE_NAME)).toHaveLength(1);
  });
});

describe("disableHostAkmSharing", () => {
  it("removes the host-akm source; never deletes stash content or the personal config", () => {
    setHostAkm(true);
    enableHostAkmSharing(state);
    disableHostAkmSharing(state);
    expect(opSources().find((s) => s.name === HOST_SOURCE_NAME)).toBeUndefined();
    // Personal config untouched (D1 — assistant-only).
    expect(existsSync(join(fakeHome, ".config", "akm", "config.json"))).toBe(true);
  });

  it("is safe when nothing is enabled", () => {
    writeFileSync(opConfig, "{}");
    expect(() => disableHostAkmSharing(state)).not.toThrow();
  });
});

describe("getHostAkmSharingStatus", () => {
  it("reports available+enabled transitions", () => {
    expect(getHostAkmSharingStatus(state)).toEqual({ available: false, enabled: false, hostStashPath: null });
    setHostAkm(true);
    expect(getHostAkmSharingStatus(state)).toEqual({ available: true, enabled: false, hostStashPath: join(fakeHome, "akm") });
    enableHostAkmSharing(state);
    expect(getHostAkmSharingStatus(state).enabled).toBe(true);
    disableHostAkmSharing(state);
    expect(getHostAkmSharingStatus(state).enabled).toBe(false);
  });
});
