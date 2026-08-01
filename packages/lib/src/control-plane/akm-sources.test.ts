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
  it("writes the exact canonical fresh bundle config without escalating the default target", () => {
    addHostStashToOpenpalmConfig(state, true);
    const cfg = readJson(opConfigPath);
    expect(cfg).toEqual({
      configVersion: "0.9.0",
      bundles: {
        stash: { path: "/stash", writable: true },
        [HOST_SOURCE_NAME]: { path: "/host-stash", writable: true, enabled: true },
      },
      defaultBundle: "stash",
      semanticSearchMode: "auto",
    });
    expect(cfg.defaultWriteTarget).toBeUndefined();
    expect("primary" in (cfg.bundles as Record<string, Record<string, unknown>>)[HOST_SOURCE_NAME]).toBe(false);
  });

  it("is idempotent — upserts by name, never duplicates", () => {
    addHostStashToOpenpalmConfig(state, true);
    addHostStashToOpenpalmConfig(state, false);
    const bundles = readJson(opConfigPath).bundles as Record<string, Record<string, unknown>>;
    expect(Object.keys(bundles)).toEqual(["stash", HOST_SOURCE_NAME]);
    expect(bundles[HOST_SOURCE_NAME].writable).toBe(false);
  });

  it("preserves unrelated existing bundles and config keys", () => {
    writeFileSync(opConfigPath, JSON.stringify({
      embedding: { model: "nomic-embed-text", dimension: 768 },
      bundles: { other: { path: "/other", enabled: true } },
      defaultBundle: "other",
    }));
    addHostStashToOpenpalmConfig(state, true);
    const cfg = readJson(opConfigPath);
    expect((cfg.embedding as Record<string, unknown>).dimension).toBe(768);
    const bundles = cfg.bundles as Record<string, Record<string, unknown>>;
    expect(bundles.other).toEqual({ path: "/other", enabled: true });
    expect(bundles[HOST_SOURCE_NAME].path).toBe("/host-stash");
    expect(cfg.defaultBundle).toBe("other");
  });

  it("recovers from a corrupt OpenPalm config (parse-tolerant → starts from {})", () => {
    writeFileSync(opConfigPath, "{ this is not json");
    addHostStashToOpenpalmConfig(state, true);
    const cfg = readJson(opConfigPath);
    expect(Object.keys(cfg.bundles as Record<string, unknown>)).toEqual(["stash", HOST_SOURCE_NAME]);
    expect(cfg.configVersion).toBe("0.9.0");
  });

  it("writes mode 0600", () => {
    addHostStashToOpenpalmConfig(state, true);
    expect(statSync(opConfigPath).mode & 0o777).toBe(0o600);
  });
});


describe("importHostProfiles (read-only snapshot of host profiles)", () => {
  function seedHostConfig(obj: Record<string, unknown>): string {
    mkdirSync(join(root, "home", ".config", "akm"), { recursive: true });
    const original = JSON.stringify(obj, null, 2);
    writeFileSync(hostConfigPath, original);
    return original;
  }

  it("copies engines, improve strategies, defaults, and embedding into an empty config", () => {
    seedHostConfig({
      configVersion: "0.9.0",
      engines: {
        default: { kind: "llm", endpoint: "http://h/v1/chat/completions", model: "qwen", provider: "ollama" },
        agent: { kind: "agent", platform: "opencode" },
      },
      defaults: { engine: "agent", llmEngine: "default", improveStrategy: "thorough" },
      improve: { strategies: { thorough: { limit: 50 } } },
      embedding: { provider: "ollama", model: "nomic-embed-text", dimension: 768 },
    });
    writeFileSync(opConfigPath, "{}");
    const { imported } = importHostProfiles(state, hostConfigPath);
    expect(imported).toContain("engines");
    expect(imported).toContain("improve.strategies");
    expect(imported).toContain("defaults.llmEngine");
    expect(imported).toContain("defaults.improveStrategy");
    expect(imported).toContain("embedding");
    const cfg = readJson(opConfigPath);
    const engines = cfg.engines as Record<string, Record<string, unknown>>;
    expect(engines.default.model).toBe("qwen");
    expect(((cfg.improve as Record<string, Record<string, Record<string, unknown>>>).strategies).thorough.limit).toBe(50);
    expect((cfg.defaults as Record<string, unknown>).improveStrategy).toBe("thorough");
    expect((cfg.embedding as Record<string, unknown>).model).toBe("nomic-embed-text");
    expect((cfg.embedding as Record<string, unknown>).dimension).toBe(768);
    expect(cfg.configVersion).toBe("0.9.0");
  });

  it("is ADDITIVE — never overwrites existing profiles, defaults, or embedding fields", () => {
    seedHostConfig({
      engines: {
        default: { kind: "llm", endpoint: "http://host/v1/chat/completions", model: "host-model" },
        "host-only": { kind: "llm", endpoint: "http://host/v1/chat/completions", model: "extra" },
      },
      defaults: { llmEngine: "host-only" },
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
    expect(engines.default.model).toBe("op-model");
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
    expect(imported).not.toContain("engines");
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

  it("imports nothing (and does not throw) when host has no engines or strategies", () => {
    seedHostConfig({ bundles: { stash: { path: "/home/u/akm", writable: true } }, defaultBundle: "stash" });
    writeFileSync(opConfigPath, "{}");
    expect(importHostProfiles(state, hostConfigPath).imported).toEqual([]);
  });

  it("returns empty imported list (does not throw) when host config is absent", () => {
    writeFileSync(opConfigPath, "{}");
    expect(importHostProfiles(state, hostConfigPath).imported).toEqual([]);
  });
});
