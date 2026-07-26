import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enableHostAkmSharing,
  disableHostAkmSharing,
  getHostAkmSharingStatus,
} from "./host-akm-sharing.js";
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
function setHostAkmConfig(opts?: { profiles?: unknown }): void {
  mkdirSync(join(fakeHome, "akm"), { recursive: true });
  mkdirSync(join(fakeHome, ".config", "akm"), { recursive: true });
  const cfg: Record<string, unknown> = { stashDir: join(fakeHome, "akm") };
  if (opts?.profiles) cfg.profiles = opts.profiles;
  writeFileSync(join(fakeHome, ".config", "akm", "config.json"), JSON.stringify(cfg));
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
  stackEnv = join(root, "state", "stack.env");
  opConfig = join(configDir, "akm", "config.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

describe("enableHostAkmSharing", () => {
  it("sets OP_HOST_AKM_STASH to ~/akm in stack.env", () => {
    enableHostAkmSharing(state);
    expect(readFileSync(stackEnv, "utf-8")).toContain(`OP_HOST_AKM_STASH=${join(fakeHome, "akm")}`);
  });

  it("does NOT add a source entry to akm config (source is managed separately)", () => {
    writeFileSync(opConfig, "{}");
    enableHostAkmSharing(state);
    const cfg = readJson(opConfig);
    expect((cfg.sources as unknown[]) ?? []).toHaveLength(0);
  });

  it("imports host LLM profiles when host config exists", () => {
    setHostAkmConfig({
      profiles: { llm: { default: { endpoint: "http://h/v1/chat/completions", model: "qwen" } } },
    });
    writeFileSync(opConfig, "{}");
    const { profilesImported } = enableHostAkmSharing(state);
    expect(profilesImported).toContain("profiles.llm");
    const opProfiles = readJson(opConfig).profiles as Record<string, Record<string, Record<string, unknown>>>;
    expect(opProfiles.llm.default.model).toBe("qwen");
  });

  it("skips profile import (no error) when host config is absent", () => {
    // ~/akm doesn't exist, ~/.config/akm/config.json doesn't exist — just skips.
    const { profilesImported } = enableHostAkmSharing(state);
    expect(profilesImported).toEqual([]);
    expect(readFileSync(stackEnv, "utf-8")).toContain("OP_HOST_AKM_STASH=");
  });

  it("is idempotent", () => {
    enableHostAkmSharing(state);
    enableHostAkmSharing(state);
    const lines = readFileSync(stackEnv, "utf-8").split("\n").filter((l) => l.startsWith("OP_HOST_AKM_STASH="));
    expect(lines).toHaveLength(1);
  });
});

describe("disableHostAkmSharing", () => {
  it("removes OP_HOST_AKM_STASH from stack.env", () => {
    enableHostAkmSharing(state);
    expect(readFileSync(stackEnv, "utf-8")).toContain("OP_HOST_AKM_STASH=");
    disableHostAkmSharing(state);
    expect(readFileSync(stackEnv, "utf-8")).not.toContain("OP_HOST_AKM_STASH=");
  });

  it("does NOT touch the akm config source list", () => {
    writeFileSync(opConfig, JSON.stringify({ sources: [{ type: "filesystem", name: "host-akm", path: "/host-stash", writable: true, enabled: true }] }));
    disableHostAkmSharing(state);
    // source entry untouched — source is always present
    const cfg = readJson(opConfig);
    const sources = cfg.sources as Array<Record<string, unknown>>;
    expect(sources.some((s) => s.name === "host-akm")).toBe(true);
  });

  it("is safe when OP_HOST_AKM_STASH was never set", () => {
    expect(() => disableHostAkmSharing(state)).not.toThrow();
  });
});

describe("getHostAkmSharingStatus", () => {
  it("reports disabled when stack.env has no OP_HOST_AKM_STASH", () => {
    const status = getHostAkmSharingStatus(state);
    expect(status.enabled).toBe(false);
    expect(typeof status.hostStashPath).toBe("string");
  });

  it("reports enabled after enableHostAkmSharing", () => {
    enableHostAkmSharing(state);
    expect(getHostAkmSharingStatus(state).enabled).toBe(true);
  });

  it("reports disabled after disableHostAkmSharing", () => {
    enableHostAkmSharing(state);
    disableHostAkmSharing(state);
    expect(getHostAkmSharingStatus(state).enabled).toBe(false);
  });
});
