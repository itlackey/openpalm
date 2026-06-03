import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_SOURCE_NAME,
  OPENPALM_SOURCE_NAME,
  addHostStashToOpenpalmConfig,
  addOpenpalmStashToHostConfig,
  removeHostAkmSources,
  importHostProfiles,
} from "./akm-sources.js";
import type { ControlPlaneState } from "./types.js";

let root = "";
let state: ControlPlaneState;
let opConfigPath = "";
let hostConfigPath = "";

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf-8"));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "akm-sources-"));
  const configDir = join(root, "config");
  mkdirSync(join(configDir, "akm"), { recursive: true });
  opConfigPath = join(configDir, "akm", "config.json");
  // Minimal state — only configDir/stashDir are read by the module.
  state = { configDir, stashDir: join(root, "knowledge") } as ControlPlaneState;
  hostConfigPath = join(root, "home", ".config", "akm", "config.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("addHostStashToOpenpalmConfig (container side, parse-tolerant)", () => {
  it("adds a writable /host-stash secondary with no primary/defaultWriteTarget", () => {
    addHostStashToOpenpalmConfig(state, true);
    const cfg = readJson(opConfigPath);
    const sources = cfg.sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(1);
    expect(sources[0]).toEqual({
      type: "filesystem",
      path: "/host-stash",
      name: HOST_SOURCE_NAME,
      writable: true,
      enabled: true,
    });
    expect(cfg.defaultWriteTarget).toBeUndefined();
    expect(cfg.stashDir).toBeUndefined();
    expect("primary" in sources[0]).toBe(false);
  });

  it("is idempotent — upserts by name, never duplicates", () => {
    addHostStashToOpenpalmConfig(state, true);
    addHostStashToOpenpalmConfig(state, false);
    const sources = readJson(opConfigPath).sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(1);
    expect(sources[0].writable).toBe(false); // last write wins on the same name
  });

  it("preserves unrelated existing sources and config keys", () => {
    writeFileSync(
      opConfigPath,
      JSON.stringify({
        embedding: { model: "nomic-embed-text", dimension: 768 },
        sources: [{ type: "filesystem", path: "/other", name: "other", enabled: true }],
      }),
    );
    addHostStashToOpenpalmConfig(state, true);
    const cfg = readJson(opConfigPath);
    expect((cfg.embedding as Record<string, unknown>).dimension).toBe(768);
    const names = (cfg.sources as Array<Record<string, unknown>>).map((s) => s.name);
    expect(names).toContain("other");
    expect(names).toContain(HOST_SOURCE_NAME);
  });

  it("recovers from a corrupt OpenPalm config (parse-tolerant → starts from {})", () => {
    writeFileSync(opConfigPath, "{ this is not json");
    addHostStashToOpenpalmConfig(state, true);
    const cfg = readJson(opConfigPath);
    expect((cfg.sources as unknown[]).length).toBe(1);
  });

  it("writes mode 0600", () => {
    addHostStashToOpenpalmConfig(state, true);
    expect(statSync(opConfigPath).mode & 0o777).toBe(0o600);
  });
});

describe("addOpenpalmStashToHostConfig (personal side, FAILS CLOSED)", () => {
  function seedHostConfig(obj: Record<string, unknown>): void {
    mkdirSync(join(root, "home", ".config", "akm"), { recursive: true });
    writeFileSync(hostConfigPath, JSON.stringify(obj));
  }

  it("adds an openpalm secondary into an existing personal config", () => {
    seedHostConfig({ stashDir: "/home/u/akm", profiles: { llm: { default: { endpoint: "x", model: "m" } } } });
    addOpenpalmStashToHostConfig(hostConfigPath, state.stashDir, true);
    const cfg = readJson(hostConfigPath);
    // The user's primary (stashDir) and profiles are untouched.
    expect(cfg.stashDir).toBe("/home/u/akm");
    expect((cfg.profiles as Record<string, unknown>).llm).toBeDefined();
    const sources = cfg.sources as Array<Record<string, unknown>>;
    expect(sources[0].name).toBe(OPENPALM_SOURCE_NAME);
    expect(sources[0].path).toBe(state.stashDir);
    expect("primary" in sources[0]).toBe(false);
  });

  it("throws and writes nothing when the personal config does not exist", () => {
    expect(() => addOpenpalmStashToHostConfig(hostConfigPath, state.stashDir, true)).toThrow();
    expect(existsSync(hostConfigPath)).toBe(false);
  });

  it("throws and does NOT overwrite a corrupt personal config", () => {
    seedHostConfig({} as Record<string, unknown>);
    const corrupt = "{ definitely : not json ";
    writeFileSync(hostConfigPath, corrupt);
    expect(() => addOpenpalmStashToHostConfig(hostConfigPath, state.stashDir, true)).toThrow();
    expect(readFileSync(hostConfigPath, "utf-8")).toBe(corrupt); // byte-for-byte unchanged
  });
});

describe("removeHostAkmSources", () => {
  it("removes both source entries; leaves other sources intact", () => {
    mkdirSync(join(root, "home", ".config", "akm"), { recursive: true });
    writeFileSync(opConfigPath, JSON.stringify({ sources: [{ type: "filesystem", path: "/host-stash", name: HOST_SOURCE_NAME }, { type: "filesystem", path: "/keep", name: "keep" }] }));
    writeFileSync(hostConfigPath, JSON.stringify({ sources: [{ type: "filesystem", path: "/k", name: OPENPALM_SOURCE_NAME }] }));
    removeHostAkmSources(state, hostConfigPath);
    expect((readJson(opConfigPath).sources as Array<Record<string, unknown>>).map((s) => s.name)).toEqual(["keep"]);
    expect((readJson(hostConfigPath).sources as unknown[]).length).toBe(0);
  });

  it("is a no-op on the personal side when it is missing (never creates it)", () => {
    writeFileSync(opConfigPath, JSON.stringify({ sources: [{ name: HOST_SOURCE_NAME, type: "filesystem", path: "/host-stash" }] }));
    removeHostAkmSources(state, hostConfigPath);
    expect(existsSync(hostConfigPath)).toBe(false);
    expect((readJson(opConfigPath).sources as unknown[]).length).toBe(0);
  });

  it("does not overwrite a corrupt personal config", () => {
    mkdirSync(join(root, "home", ".config", "akm"), { recursive: true });
    const corrupt = "}}}not json";
    writeFileSync(hostConfigPath, corrupt);
    writeFileSync(opConfigPath, "{}");
    removeHostAkmSources(state, hostConfigPath);
    expect(readFileSync(hostConfigPath, "utf-8")).toBe(corrupt);
  });
});

describe("importHostProfiles (read-only snapshot of host profiles)", () => {
  function seedHostConfig(obj: Record<string, unknown>): string {
    mkdirSync(join(root, "home", ".config", "akm"), { recursive: true });
    const original = JSON.stringify(obj, null, 2);
    writeFileSync(hostConfigPath, original);
    return original;
  }

  it("copies profiles.llm/agent + defaults into the OpenPalm config, never the legacy top-level llm", () => {
    seedHostConfig({
      profiles: {
        llm: { default: { endpoint: "http://h/v1/chat/completions", model: "qwen", provider: "ollama" } },
        agent: { default: { platform: "opencode" } },
      },
      defaults: { llm: "default", agent: "default" },
    });
    writeFileSync(opConfigPath, JSON.stringify({ embedding: { model: "e", dimension: 768 } }));
    const { imported } = importHostProfiles(state, hostConfigPath);
    expect(imported).toContain("profiles.llm");
    expect(imported).toContain("profiles.agent");
    expect(imported).toContain("defaults.llm");
    const cfg = readJson(opConfigPath);
    expect(((cfg.profiles as Record<string, Record<string, Record<string, unknown>>>).llm.default).model).toBe("qwen");
    expect((cfg.defaults as Record<string, unknown>).llm).toBe("default");
    expect((cfg.embedding as Record<string, unknown>).dimension).toBe(768); // preserved
    expect(cfg.llm).toBeUndefined(); // never the legacy shape
  });

  it("reads the host config READ-ONLY (host file unchanged byte-for-byte)", () => {
    const original = seedHostConfig({ profiles: { llm: { default: { endpoint: "x", model: "m" } } }, defaults: { llm: "default" } });
    writeFileSync(opConfigPath, "{}");
    importHostProfiles(state, hostConfigPath);
    expect(readFileSync(hostConfigPath, "utf-8")).toBe(original);
  });

  it("imports nothing (and does not throw) when host has no profiles", () => {
    seedHostConfig({ stashDir: "/home/u/akm" });
    writeFileSync(opConfigPath, "{}");
    const { imported } = importHostProfiles(state, hostConfigPath);
    expect(imported).toEqual([]);
  });

  it("throws (fails closed) when the personal config is missing", () => {
    writeFileSync(opConfigPath, "{}");
    expect(() => importHostProfiles(state, hostConfigPath)).toThrow();
  });
});
