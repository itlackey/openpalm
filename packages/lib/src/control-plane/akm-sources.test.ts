import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_SOURCE_NAME,
  addHostStashToOpenpalmConfig,
  stripRetiredAkmConfigKeys,
  importHostAkmConfig,
  detectHostAkmConfig,
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


describe("stripRetiredAkmConfigKeys (upgrade heals a pre-0.9 config)", () => {
  it("removes the retired keys that make akm 0.9 reject the whole file", () => {
    // The real report: after upgrading to an image with akm 0.9, every akm
    // call failed with `stashDir is retired in 0.9`, because nothing rewrites
    // this file on an upgrade — only setup and install ever did.
    writeFileSync(opConfigPath, JSON.stringify({
      configVersion: "0.9.0",
      stashDir: "/stash",
      profiles: { llm: {} },
      bundles: { openpalm: { path: "/stash", writable: true } },
      defaultBundle: "openpalm",
      engines: { fast: { kind: "llm", endpoint: "http://h/v1", model: "m" } },
      defaults: { llmEngine: "fast", llm: "retired" },
    }, null, 2));

    expect(stripRetiredAkmConfigKeys(state)).toBe(true);

    const cfg = readJson(opConfigPath);
    expect(cfg.stashDir).toBeUndefined();
    expect(cfg.profiles).toBeUndefined();
    expect((cfg.defaults as Record<string, unknown>).llm).toBeUndefined();
    // Everything the operator owns survives untouched.
    expect(cfg.bundles).toEqual({ openpalm: { path: "/stash", writable: true } });
    expect(cfg.defaultBundle).toBe("openpalm");
    expect(cfg.engines).toEqual({ fast: { kind: "llm", endpoint: "http://h/v1", model: "m" } });
    expect((cfg.defaults as Record<string, unknown>).llmEngine).toBe("fast");
  });

  it("does not rewrite a config that is already clean", () => {
    writeFileSync(opConfigPath, `${JSON.stringify({
      configVersion: "0.9.0",
      bundles: { openpalm: { path: "/stash", writable: true } },
    }, null, 2)}\n`);
    expect(stripRetiredAkmConfigKeys(state)).toBe(false);
  });

  it("leaves an unparseable config alone rather than destroying it", () => {
    writeFileSync(opConfigPath, "{ not json");
    expect(stripRetiredAkmConfigKeys(state)).toBe(false);
    expect(readFileSync(opConfigPath, "utf-8")).toBe("{ not json");
  });

  it("is a no-op when there is no config yet", () => {
    rmSync(opConfigPath, { force: true });
    expect(stripRetiredAkmConfigKeys(state)).toBe(false);
  });
});

describe("stripRetiredAkmConfigKeys covers paperclip's own akm config", () => {
  it("sweeps config/paperclip/akm/config.json too", () => {
    // Paperclip runs a second akm against its own config, seeded once from the
    // skeleton and never rewritten. Sweeping only the assistant's left the
    // identical INVALID_CONFIG_FILE failure waiting in that container.
    const pcDir = join(root, "config", "paperclip", "akm");
    mkdirSync(pcDir, { recursive: true });
    const pcPath = join(pcDir, "config.json");
    writeFileSync(pcPath, JSON.stringify({ profiles: { agent: {} }, stashDir: "/stash" }, null, 2));
    writeFileSync(opConfigPath, `${JSON.stringify({ configVersion: "0.9.0" }, null, 2)}\n`);

    expect(stripRetiredAkmConfigKeys(state)).toBe(true);

    const pc = JSON.parse(readFileSync(pcPath, "utf-8")) as Record<string, unknown>;
    expect(pc.profiles).toBeUndefined();
    expect(pc.stashDir).toBeUndefined();
    expect(pc.configVersion).toBe("0.9.0");
  });

  it("returns false when neither config needs a change", () => {
    writeFileSync(opConfigPath, `${JSON.stringify({ configVersion: "0.9.0" }, null, 2)}\n`);
    expect(stripRetiredAkmConfigKeys(state)).toBe(false);
  });
});

describe("importHostAkmConfig (manual host akm import)", () => {
  const hostCfg = () => join(root, "home", ".config", "akm", "config.json");

  function seedHost(obj: Record<string, unknown>): string {
    mkdirSync(join(root, "home", ".config", "akm"), { recursive: true });
    const raw = JSON.stringify(obj, null, 2);
    writeFileSync(hostCfg(), raw);
    return raw;
  }

  it("fills gaps without overwriting what the operator already set", () => {
    seedHost({
      engines: {
        hostOnly: { kind: "llm", endpoint: "http://host/v1", model: "m" },
        shared: { kind: "llm", endpoint: "http://host/OVERWRITTEN", model: "host" },
      },
      defaults: { llmEngine: "hostOnly" },
    });
    writeFileSync(opConfigPath, JSON.stringify({
      configVersion: "0.9.0",
      engines: { shared: { kind: "llm", endpoint: "http://mine/v1", model: "mine" } },
      defaults: { llmEngine: "shared" },
    }, null, 2));

    const { imported } = importHostAkmConfig(state, hostCfg());

    expect(imported).toContain("engines");
    const cfg = readJson(opConfigPath);
    const engines = cfg.engines as Record<string, Record<string, unknown>>;
    // Host-only engine adopted…
    expect(engines.hostOnly.endpoint).toBe("http://host/v1");
    // …and the operator's own engine and default selection survive untouched.
    expect(engines.shared.endpoint).toBe("http://mine/v1");
    expect((cfg.defaults as Record<string, unknown>).llmEngine).toBe("shared");
  });

  it("never writes to the host config", () => {
    const original = seedHost({ engines: { a: { kind: "llm", endpoint: "http://h", model: "m" } } });
    writeFileSync(opConfigPath, "{}");
    importHostAkmConfig(state, hostCfg());
    expect(readFileSync(hostCfg(), "utf-8")).toBe(original);
  });

  it("imports nothing when the host config is absent", () => {
    writeFileSync(opConfigPath, "{}");
    expect(importHostAkmConfig(state, hostCfg()).imported).toEqual([]);
  });

  it("detects what an import would find, for the affordance", () => {
    const savedHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    try {
      expect(detectHostAkmConfig().available).toBe(false);
      seedHost({ engines: { a: {}, b: {} }, embedding: { endpoint: "http://e" } });
      const found = detectHostAkmConfig();
      expect(found).toMatchObject({ available: true, engineCount: 2, hasEmbedding: true });
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});
