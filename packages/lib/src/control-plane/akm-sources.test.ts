import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_SOURCE_NAME,
  addHostStashToOpenpalmConfig,
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
  it("creates a loadable 0.9.0 config: /host-stash secondary bundle + configVersion + primary openpalm bundle", () => {
    addHostStashToOpenpalmConfig(state, true);
    const cfg = readJson(opConfigPath);
    const bundles = cfg.bundles as Record<string, Record<string, unknown>>;
    expect(Object.keys(bundles).sort()).toEqual([HOST_SOURCE_NAME, "openpalm"]);
    expect(bundles[HOST_SOURCE_NAME]).toEqual({ path: "/host-stash", writable: true, enabled: true });
    // Mirrors persistAkmConfig: akm 0.9.0 refuses a config without these.
    expect(cfg.configVersion).toBe("0.9.0");
    expect(bundles.openpalm).toEqual({ path: "/stash", writable: true });
    expect(cfg.defaultBundle).toBe("openpalm");
    expect(cfg.defaultWriteTarget).toBeUndefined();
    expect(cfg.stashDir).toBeUndefined();
  });

  it("is idempotent — upserts by id, never duplicates", () => {
    addHostStashToOpenpalmConfig(state, true);
    addHostStashToOpenpalmConfig(state, false);
    const bundles = readJson(opConfigPath).bundles as Record<string, Record<string, unknown>>;
    expect(Object.keys(bundles).sort()).toEqual([HOST_SOURCE_NAME, "openpalm"]);
    expect(bundles[HOST_SOURCE_NAME].writable).toBe(false);
  });

  it("never repoints an existing defaultBundle and preserves extra fields on the openpalm bundle", () => {
    writeFileSync(opConfigPath, JSON.stringify({
      configVersion: "0.9.0",
      bundles: { openpalm: { path: "/elsewhere", writable: false, components: { docs: { root: "docs" } } } },
      defaultBundle: "openpalm",
    }));
    addHostStashToOpenpalmConfig(state, true);
    const cfg = readJson(opConfigPath);
    const bundles = cfg.bundles as Record<string, Record<string, unknown>>;
    // Path/writable are re-pinned (same as persistAkmConfig), extras survive.
    expect(bundles.openpalm).toEqual({ path: "/stash", writable: true, components: { docs: { root: "docs" } } });
    expect(cfg.defaultBundle).toBe("openpalm");
  });

  it("strips the retired 0.8 keys so akm 0.9.0 can load the result", () => {
    writeFileSync(opConfigPath, JSON.stringify({
      stashDir: "/old/stash",
      sources: [{ name: "legacy", path: "/legacy" }],
      profiles: { llm: { default: { endpoint: "x", model: "m" } } },
      defaults: { llm: "default", llmEngine: "default" },
      wikiName: "wiki",
    }));
    addHostStashToOpenpalmConfig(state, true);
    const cfg = readJson(opConfigPath);
    expect(cfg.stashDir).toBeUndefined();
    expect(cfg.sources).toBeUndefined();
    expect(cfg.profiles).toBeUndefined();
    expect(cfg.wikiName).toBeUndefined();
    expect((cfg.defaults as Record<string, unknown>).llm).toBeUndefined();
    expect((cfg.defaults as Record<string, unknown>).llmEngine).toBe("default");
    expect(cfg.configVersion).toBe("0.9.0");
  });

  it("preserves unrelated existing bundles and config keys", () => {
    writeFileSync(opConfigPath, JSON.stringify({
      embedding: { model: "nomic-embed-text", dimension: 768 },
      bundles: { other: { path: "/other", enabled: true } },
    }));
    addHostStashToOpenpalmConfig(state, true);
    const cfg = readJson(opConfigPath);
    expect((cfg.embedding as Record<string, unknown>).dimension).toBe(768);
    const ids = Object.keys(cfg.bundles as Record<string, unknown>);
    expect(ids).toContain("other");
    expect(ids).toContain(HOST_SOURCE_NAME);
  });

  it("preserves unrelated fields on the host-akm bundle entry itself", () => {
    writeFileSync(opConfigPath, JSON.stringify({
      bundles: { [HOST_SOURCE_NAME]: { path: "/old", components: { docs: { root: "docs" } } } },
    }));
    addHostStashToOpenpalmConfig(state, true);
    const bundles = readJson(opConfigPath).bundles as Record<string, Record<string, unknown>>;
    expect(bundles[HOST_SOURCE_NAME].path).toBe("/host-stash");
    expect(bundles[HOST_SOURCE_NAME].components).toEqual({ docs: { root: "docs" } });
  });

  it("recovers from a corrupt OpenPalm config (parse-tolerant → starts from {})", () => {
    writeFileSync(opConfigPath, "{ this is not json");
    addHostStashToOpenpalmConfig(state, true);
    const bundles = readJson(opConfigPath).bundles as Record<string, unknown>;
    expect(Object.keys(bundles).sort()).toEqual([HOST_SOURCE_NAME, "openpalm"]);
  });

  it("writes mode 0600", () => {
    addHostStashToOpenpalmConfig(state, true);
    expect(statSync(opConfigPath).mode & 0o777).toBe(0o600);
  });
});


describe("importHostProfiles (read-only snapshot of host engine config)", () => {
  function seedHostConfig(obj: Record<string, unknown>): string {
    mkdirSync(join(root, "home", ".config", "akm"), { recursive: true });
    const original = JSON.stringify(obj, null, 2);
    writeFileSync(hostConfigPath, original);
    return original;
  }

  it("copies engines + defaults + improve.strategies + embedding into an empty config", () => {
    seedHostConfig({
      configVersion: "0.9.0",
      engines: {
        fast: { kind: "llm", endpoint: "http://h/v1/chat/completions", model: "qwen", provider: "ollama" },
        reviewer: { kind: "agent", platform: "opencode" },
      },
      defaults: { llmEngine: "fast", engine: "reviewer", improveStrategy: "thorough" },
      improve: { strategies: { thorough: { engine: "fast" } } },
      embedding: { provider: "ollama", model: "nomic-embed-text", dimension: 768 },
    });
    writeFileSync(opConfigPath, "{}");
    const { imported } = importHostProfiles(state, hostConfigPath);
    expect(imported).toContain("engines");
    expect(imported).toContain("defaults.engine");
    expect(imported).toContain("defaults.llmEngine");
    expect(imported).toContain("defaults.improveStrategy");
    expect(imported).toContain("improve.strategies");
    expect(imported).toContain("embedding");
    const cfg = readJson(opConfigPath);
    const engines = cfg.engines as Record<string, Record<string, unknown>>;
    expect(engines.fast.model).toBe("qwen");
    expect(engines.reviewer.platform).toBe("opencode");
    expect((cfg.defaults as Record<string, unknown>).improveStrategy).toBe("thorough");
    expect(((cfg.improve as Record<string, unknown>).strategies as Record<string, unknown>).thorough).toEqual({ engine: "fast" });
    expect((cfg.embedding as Record<string, unknown>).model).toBe("nomic-embed-text");
    expect((cfg.embedding as Record<string, unknown>).dimension).toBe(768);
    expect(cfg.llm).toBeUndefined();
    expect(cfg.configVersion).toBe("0.9.0");
  });

  it("strips retired 0.8 keys and stamps configVersion on the merged write (pre-0.9 OpenPalm config)", () => {
    seedHostConfig({
      configVersion: "0.9.0",
      engines: { fast: { kind: "llm", endpoint: "x", model: "m" } },
    });
    // A pre-0.9 / versionless OpenPalm config still carrying retired keys.
    writeFileSync(opConfigPath, JSON.stringify({
      stashDir: "/old/stash",
      profiles: { llm: { default: { endpoint: "x", model: "m" } } },
      defaults: { llm: "default" },
    }));
    const { imported } = importHostProfiles(state, hostConfigPath);
    expect(imported).toContain("engines");
    const cfg = readJson(opConfigPath);
    expect(cfg.configVersion).toBe("0.9.0");
    expect(cfg.stashDir).toBeUndefined();
    expect(cfg.profiles).toBeUndefined();
    expect((cfg.defaults as Record<string, unknown>).llm).toBeUndefined();
    // bundles/defaultBundle remain untouched by the import path.
    expect(cfg.bundles).toBeUndefined();
    expect(cfg.defaultBundle).toBeUndefined();
  });

  it("is ADDITIVE — never overwrites existing engines, defaults, or embedding fields", () => {
    seedHostConfig({
      configVersion: "0.9.0",
      engines: {
        default: { kind: "llm", endpoint: "http://host/v1/chat/completions", model: "host-model" }, // conflicts with existing
        "host-only": { kind: "llm", endpoint: "http://host/v1/chat/completions", model: "extra" },  // new → added
      },
      defaults: { llmEngine: "host-only" }, // existing already has defaults.llmEngine → must NOT change
      embedding: { provider: "ollama", model: "host-emb", dimension: 768, batchSize: 32 }, // model conflicts; batchSize new
    });
    writeFileSync(opConfigPath, JSON.stringify({
      engines: { default: { kind: "llm", endpoint: "http://op/v1/chat/completions", model: "op-model" } },
      defaults: { llmEngine: "default" },
      embedding: { provider: "openai", model: "op-emb", dimension: 1536 },
    }));

    const { imported } = importHostProfiles(state, hostConfigPath);
    const cfg = readJson(opConfigPath);
    const engines = cfg.engines as Record<string, Record<string, unknown>>;
    // Existing 'default' engine is preserved untouched.
    expect(engines.default.model).toBe("op-model");
    // Host-only engine is added.
    expect(engines["host-only"].model).toBe("extra");
    expect(imported).toContain("engines");
    // Existing default selection is NOT overwritten.
    expect((cfg.defaults as Record<string, unknown>).llmEngine).toBe("default");
    expect(imported).not.toContain("defaults.llmEngine");
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
      engines: { default: { kind: "llm", endpoint: "x", model: "host" } },
      defaults: { llmEngine: "default" },
    });
    writeFileSync(opConfigPath, JSON.stringify({
      engines: { default: { kind: "llm", endpoint: "y", model: "op" } },
      defaults: { llmEngine: "default" },
    }));
    const { imported } = importHostProfiles(state, hostConfigPath);
    expect(imported).not.toContain("engines"); // 'default' already present, nothing added
    expect(imported).not.toContain("defaults.llmEngine");
    // existing values untouched
    const cfg = readJson(opConfigPath);
    expect((cfg.engines as Record<string, Record<string, unknown>>).default.model).toBe("op");
  });

  it("reads the host config READ-ONLY (host file unchanged byte-for-byte)", () => {
    const original = seedHostConfig({ engines: { default: { kind: "llm", endpoint: "x", model: "m" } }, defaults: { llmEngine: "default" } });
    writeFileSync(opConfigPath, "{}");
    importHostProfiles(state, hostConfigPath);
    expect(readFileSync(hostConfigPath, "utf-8")).toBe(original);
  });

  it("imports nothing (and does not throw) when host has no engines — including a retired 0.8 profiles shape", () => {
    seedHostConfig({
      stashDir: "/home/u/akm",
      profiles: { llm: { default: { endpoint: "x", model: "m" } } },
      defaults: { llm: "default" },
    });
    writeFileSync(opConfigPath, "{}");
    expect(importHostProfiles(state, hostConfigPath).imported).toEqual([]);
    // The retired shape is never copied into the OpenPalm config.
    const cfg = readJson(opConfigPath);
    expect(cfg.profiles).toBeUndefined();
  });

  it("returns empty imported list (does not throw) when host config is absent", () => {
    writeFileSync(opConfigPath, "{}");
    expect(importHostProfiles(state, hostConfigPath).imported).toEqual([]);
  });
});
