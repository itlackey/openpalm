import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_SOURCE_NAME,
  addHostStashToOpenpalmConfig,
} from "./akm-sources.js";
import type { ControlPlaneState } from "./types.js";

let root = "";
let state: ControlPlaneState;
let opConfigPath = "";

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf-8"));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "akm-sources-"));
  const configDir = join(root, "config");
  mkdirSync(join(configDir, "akm"), { recursive: true });
  opConfigPath = join(configDir, "akm", "config.json");
  state = { configDir, stashDir: join(root, "knowledge") } as ControlPlaneState;
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

