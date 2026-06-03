import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_SOURCE_NAME,
  addHostStashToOpenpalmConfig,
  removeHostAkmSource,
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
  state = { configDir, stashDir: join(root, "knowledge") } as ControlPlaneState;
  hostConfigPath = join(root, "home", ".config", "akm", "config.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("addHostStashToOpenpalmConfig (assistant side, parse-tolerant)", () => {
  it("adds a writable /host-stash secondary with no primary/defaultWriteTarget", () => {
    addHostStashToOpenpalmConfig(state, true);
    const cfg = readJson(opConfigPath);
    const sources = cfg.sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(1);
    expect(sources[0]).toEqual({ type: "filesystem", path: "/host-stash", name: HOST_SOURCE_NAME, writable: true, enabled: true });
    expect(cfg.defaultWriteTarget).toBeUndefined();
    expect(cfg.stashDir).toBeUndefined();
    expect("primary" in sources[0]).toBe(false);
  });

  it("is idempotent — upserts by name, never duplicates", () => {
    addHostStashToOpenpalmConfig(state, true);
    addHostStashToOpenpalmConfig(state, false);
    const sources = readJson(opConfigPath).sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(1);
    expect(sources[0].writable).toBe(false);
  });

  it("preserves unrelated existing sources and config keys", () => {
    writeFileSync(opConfigPath, JSON.stringify({
      embedding: { model: "nomic-embed-text", dimension: 768 },
      sources: [{ type: "filesystem", path: "/other", name: "other", enabled: true }],
    }));
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
    expect((readJson(opConfigPath).sources as unknown[]).length).toBe(1);
  });

  it("writes mode 0600", () => {
    addHostStashToOpenpalmConfig(state, true);
    expect(statSync(opConfigPath).mode & 0o777).toBe(0o600);
  });
});

describe("removeHostAkmSource (assistant side only — never touches personal config)", () => {
  it("removes the host-akm source, leaving other sources intact", () => {
    writeFileSync(opConfigPath, JSON.stringify({
      sources: [
        { type: "filesystem", path: "/host-stash", name: HOST_SOURCE_NAME },
        { type: "filesystem", path: "/keep", name: "keep" },
      ],
    }));
    removeHostAkmSource(state);
    expect((readJson(opConfigPath).sources as Array<Record<string, unknown>>).map((s) => s.name)).toEqual(["keep"]);
  });

  it("is idempotent when no host-akm source exists", () => {
    writeFileSync(opConfigPath, JSON.stringify({ sources: [{ name: "keep", type: "filesystem", path: "/k" }] }));
    expect(() => removeHostAkmSource(state)).not.toThrow();
    expect((readJson(opConfigPath).sources as unknown[]).length).toBe(1);
  });
});

describe("importHostProfiles (read-only snapshot of host profiles)", () => {
  function seedHostConfig(obj: Record<string, unknown>): string {
    mkdirSync(join(root, "home", ".config", "akm"), { recursive: true });
    const original = JSON.stringify(obj, null, 2);
    writeFileSync(hostConfigPath, original);
    return original;
  }

  it("copies llm/agent/improve profiles + defaults + embedding into an empty config", () => {
    seedHostConfig({
      profiles: {
        llm: { default: { endpoint: "http://h/v1/chat/completions", model: "qwen", provider: "ollama" } },
        agent: { default: { platform: "opencode" } },
        improve: { thorough: { limit: 50 } },
      },
      defaults: { llm: "default", agent: "default", improve: "thorough" },
      embedding: { provider: "ollama", model: "nomic-embed-text", dimension: 768 },
    });
    writeFileSync(opConfigPath, "{}");
    const { imported } = importHostProfiles(state, hostConfigPath);
    expect(imported).toContain("profiles.llm");
    expect(imported).toContain("profiles.agent");
    expect(imported).toContain("profiles.improve");
    expect(imported).toContain("defaults.llm");
    expect(imported).toContain("defaults.improve");
    expect(imported).toContain("embedding");
    const cfg = readJson(opConfigPath);
    const profiles = cfg.profiles as Record<string, Record<string, Record<string, unknown>>>;
    expect(profiles.llm.default.model).toBe("qwen");
    expect(profiles.improve.thorough.limit).toBe(50);
    expect((cfg.defaults as Record<string, unknown>).improve).toBe("thorough");
    expect((cfg.embedding as Record<string, unknown>).model).toBe("nomic-embed-text");
    expect((cfg.embedding as Record<string, unknown>).dimension).toBe(768);
    expect(cfg.llm).toBeUndefined();
  });

  it("is ADDITIVE — never overwrites existing profiles, defaults, or embedding fields", () => {
    seedHostConfig({
      profiles: {
        llm: {
          default: { endpoint: "http://host/v1/chat/completions", model: "host-model" }, // conflicts with existing
          "host-only": { endpoint: "http://host/v1/chat/completions", model: "extra" },  // new → added
        },
      },
      defaults: { llm: "host-only" }, // existing already has defaults.llm → must NOT change
      embedding: { provider: "ollama", model: "host-emb", dimension: 768, batchSize: 32 }, // model conflicts; batchSize new
    });
    writeFileSync(opConfigPath, JSON.stringify({
      profiles: { llm: { default: { endpoint: "http://op/v1/chat/completions", model: "op-model" } } },
      defaults: { llm: "default" },
      embedding: { provider: "openai", model: "op-emb", dimension: 1536 },
    }));

    const { imported } = importHostProfiles(state, hostConfigPath);
    const cfg = readJson(opConfigPath);
    const profiles = cfg.profiles as Record<string, Record<string, Record<string, unknown>>>;
    // Existing 'default' profile is preserved untouched.
    expect(profiles.llm.default.model).toBe("op-model");
    // Host-only profile is added.
    expect(profiles.llm["host-only"].model).toBe("extra");
    expect(imported).toContain("profiles.llm");
    // Existing default selection is NOT overwritten.
    expect((cfg.defaults as Record<string, unknown>).llm).toBe("default");
    expect(imported).not.toContain("defaults.llm");
    // Embedding: existing fields win; only the new field (batchSize) is added.
    const emb = cfg.embedding as Record<string, unknown>;
    expect(emb.model).toBe("op-emb");
    expect(emb.provider).toBe("openai");
    expect(emb.dimension).toBe(1536);
    expect(emb.batchSize).toBe(32);
    expect(imported).toContain("embedding");
  });

  it("does not report a namespace as imported when it adds nothing new", () => {
    seedHostConfig({
      profiles: { llm: { default: { endpoint: "x", model: "host" } } },
      defaults: { llm: "default" },
    });
    writeFileSync(opConfigPath, JSON.stringify({
      profiles: { llm: { default: { endpoint: "y", model: "op" } } },
      defaults: { llm: "default" },
    }));
    const { imported } = importHostProfiles(state, hostConfigPath);
    expect(imported).not.toContain("profiles.llm"); // 'default' already present, nothing added
    expect(imported).not.toContain("defaults.llm");
    // existing values untouched
    const cfg = readJson(opConfigPath);
    expect((cfg.profiles as Record<string, Record<string, Record<string, unknown>>>).llm.default.model).toBe("op");
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
    expect(importHostProfiles(state, hostConfigPath).imported).toEqual([]);
  });

  it("throws (fails closed) when the personal config is missing", () => {
    writeFileSync(opConfigPath, "{}");
    expect(() => importHostProfiles(state, hostConfigPath)).toThrow();
  });
});
