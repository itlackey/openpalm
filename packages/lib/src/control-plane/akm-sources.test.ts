import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_SOURCE_NAME,
  addHostStashToOpenpalmConfig,
  ensureSystemBundle,
  reconcileDuplicateBundles,
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
  it("creates a loadable 0.9.0 config: /host-stash secondary bundle + configVersion + primary openpalm bundle + read-only system bundle", () => {
    addHostStashToOpenpalmConfig(state, true);
    const cfg = readJson(opConfigPath);
    const bundles = cfg.bundles as Record<string, Record<string, unknown>>;
    expect(Object.keys(bundles).sort()).toEqual([HOST_SOURCE_NAME, "openpalm", "openpalm-system"]);
    expect(bundles[HOST_SOURCE_NAME]).toEqual({ path: "/host-stash", writable: true, enabled: true });
    // Mirrors persistAkmConfig: akm 0.9.0 refuses a config without these.
    expect(cfg.configVersion).toBe("0.9.0");
    expect(bundles.openpalm).toEqual({ path: "/stash", writable: true });
    // Release-shipped skills: never a write target (`:ro` in compose is the
    // boundary; this flag is the routing half).
    expect(bundles["openpalm-system"]).toEqual({ path: "/system-stash", writable: false, enabled: true });
    expect(cfg.defaultBundle).toBe("openpalm");
    expect(cfg.defaultWriteTarget).toBeUndefined();
    expect(cfg.stashDir).toBeUndefined();
  });

  it("is idempotent — upserts by id, never duplicates", () => {
    addHostStashToOpenpalmConfig(state, true);
    addHostStashToOpenpalmConfig(state, false);
    const bundles = readJson(opConfigPath).bundles as Record<string, Record<string, unknown>>;
    expect(Object.keys(bundles).sort()).toEqual([HOST_SOURCE_NAME, "openpalm", "openpalm-system"]);
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
    expect(Object.keys(bundles).sort()).toEqual([HOST_SOURCE_NAME, "openpalm", "openpalm-system"]);
  });

  it("writes mode 0600", () => {
    addHostStashToOpenpalmConfig(state, true);
    expect(statSync(opConfigPath).mode & 0o777).toBe(0o600);
  });
});


describe("ensureSystemBundle (upgrade heals a config written before system/skills)", () => {
  it("adds the read-only /system-stash bundle to an existing config, touching nothing else", () => {
    writeFileSync(opConfigPath, JSON.stringify({
      configVersion: "0.9.0",
      bundles: { openpalm: { path: "/stash", writable: true } },
      defaultBundle: "openpalm",
      engines: { default: { kind: "llm" } },
    }, null, 2));

    expect(ensureSystemBundle(state)).toBe(true);

    const cfg = readJson(opConfigPath);
    const bundles = cfg.bundles as Record<string, Record<string, unknown>>;
    expect(bundles["openpalm-system"]).toEqual({ path: "/system-stash", writable: false, enabled: true });
    expect(bundles.openpalm).toEqual({ path: "/stash", writable: true });
    expect(cfg.defaultBundle).toBe("openpalm");
    expect(cfg.defaultWriteTarget).toBeUndefined();
    expect(cfg.engines).toEqual({ default: { kind: "llm" } });
  });

  it("is a no-op once the entry is present — no rewrite on every lifecycle pass", () => {
    writeFileSync(opConfigPath, JSON.stringify({ configVersion: "0.9.0", bundles: {} }));
    expect(ensureSystemBundle(state)).toBe(true);
    const after = readFileSync(opConfigPath, "utf-8");

    expect(ensureSystemBundle(state)).toBe(false);
    expect(readFileSync(opConfigPath, "utf-8")).toBe(after);
    // The neighbouring sweep must not fight it back the other way: both run on
    // every lifecycle pass, and they used to disagree about a trailing newline.
    expect(stripRetiredAkmConfigKeys(state)).toBe(false);
    expect(readFileSync(opConfigPath, "utf-8")).toBe(after);
    expect(ensureSystemBundle(state)).toBe(false);
    expect(readFileSync(opConfigPath, "utf-8")).toBe(after);
  });

  it("leaves an absent config absent — install owns creation, not this sweep", () => {
    expect(ensureSystemBundle(state)).toBe(false);
    expect(existsSync(opConfigPath)).toBe(false);
  });
});

describe("reconcileDuplicateBundles (two ids, one directory, blocked akm migration)", () => {
  // akm >= 0.9.7 fixed the minting side of this (akm#870) and no longer throws
  // on an existing duplicate — but it does NOT rewrite the config, so every
  // home that ran 0.9.1-0.9.5 still carries the duplicate and a `defaultBundle`
  // naming an id akm synthesized. Verified against the shipped 0.9.6: `migrate
  // status` returns `current` and the file is byte-identical afterwards. These
  // cases are therefore still live, not history.
  /** The shape observed on a real running instance, verbatim. */
  const liveShape = () => ({
    configVersion: "0.9.0",
    engines: { default: { kind: "llm" } },
    bundles: {
      stash: { path: "/stash", writable: true, components: { main: { adapter: "akm" } } },
      "host-stash": { path: "/host-stash", registryId: "/host-stash" },
      "openpalm-system": { path: "/system-stash", writable: false, enabled: true },
      openpalm: { path: "/stash", writable: true },
    },
    defaultBundle: "stash",
  });

  it("collapses the live shape to a single openpalm bundle and moves the default with it", () => {
    // Without this, `akm migrate apply` exits 70 on EVERY boot with
    // `duplicate task migration file path: /stash/tasks/akm-improve.yml`.
    writeFileSync(opConfigPath, JSON.stringify(liveShape(), null, 2));

    expect(reconcileDuplicateBundles(state)).toBe(true);

    const cfg = readJson(opConfigPath);
    const bundles = cfg.bundles as Record<string, Record<string, unknown>>;
    expect(Object.keys(bundles).sort()).toEqual(["host-stash", "openpalm", "openpalm-system"]);
    // The removed entry's DECLARED adapter comes with it. Dropping it would put
    // /stash back on auto-detection, and akm probes eight other adapters ahead
    // of `akm` while taskRoots skips any root that is not `akm`/`akm-task` — a
    // loud failure traded for a silent skip.
    expect(bundles.openpalm).toEqual({
      path: "/stash",
      writable: true,
      components: { main: { adapter: "akm" } },
    });
    // The default named the entry we removed — leaving it would name a bundle
    // that no longer exists, strictly worse than the duplicate.
    expect(cfg.defaultBundle).toBe("openpalm");
    // Everything else is untouched.
    expect(cfg.engines).toEqual({ default: { kind: "llm" } });
    expect(cfg.configVersion).toBe("0.9.0");
  });

  it("never removes the host or system bundles — different directories", () => {
    writeFileSync(opConfigPath, JSON.stringify({
      bundles: {
        openpalm: { path: "/stash", writable: true },
        stash: { path: "/stash", writable: true },
        [HOST_SOURCE_NAME]: { path: "/host-stash", writable: true, enabled: true },
        "openpalm-system": { path: "/system-stash", writable: false, enabled: true },
      },
    }, null, 2));

    expect(reconcileDuplicateBundles(state)).toBe(true);

    const bundles = readJson(opConfigPath).bundles as Record<string, Record<string, unknown>>;
    expect(Object.keys(bundles).sort()).toEqual([HOST_SOURCE_NAME, "openpalm", "openpalm-system"]);
    expect(bundles[HOST_SOURCE_NAME]).toEqual({ path: "/host-stash", writable: true, enabled: true });
    expect(bundles["openpalm-system"]).toEqual({ path: "/system-stash", writable: false, enabled: true });
  });

  it("keeps a bundle whose COMPONENT ROOT makes it a different directory", () => {
    // akm resolves a bundle's content root as resolve(path, component.root ?? ".")
    // — both taskRoots and primaryBundlePath. `path: "/stash"` + root "docs" is
    // /stash/docs: a genuinely different root, never the collision that blocks
    // the migration. Comparing the bare `path` would delete it.
    const raw = `${JSON.stringify({
      bundles: {
        openpalm: { path: "/stash", writable: true },
        docs: { path: "/stash", components: { docs: { root: "docs" } } },
      },
    }, null, 2)}\n`;
    writeFileSync(opConfigPath, raw);

    expect(reconcileDuplicateBundles(state)).toBe(false);
    expect(readFileSync(opConfigPath, "utf-8")).toBe(raw);
  });

  it("still collapses two entries whose component roots resolve to the same directory", () => {
    writeFileSync(opConfigPath, JSON.stringify({
      bundles: {
        openpalm: { path: "/stash", writable: true, components: { main: { root: "docs" } } },
        stash: { path: "/stash/docs", writable: true },
      },
    }, null, 2));

    expect(reconcileDuplicateBundles(state)).toBe(true);
    expect(Object.keys(readJson(opConfigPath).bundles as Record<string, unknown>)).toEqual(["openpalm"]);
  });

  it("leaves a bundle an operator parked with `enabled: false` alone", () => {
    // taskRoots opens with `if (bundle.enabled === false) continue`, so a
    // disabled bundle never contributes the second enumeration that causes the
    // failure. akm documents the flag as opting out "without deleting it".
    const raw = `${JSON.stringify({
      bundles: {
        openpalm: { path: "/stash", writable: true },
        archived: { path: "/stash", enabled: false, components: { m: { adapter: "akm-task" } } },
      },
    }, null, 2)}\n`;
    writeFileSync(opConfigPath, raw);

    expect(reconcileDuplicateBundles(state)).toBe(false);
    expect(readFileSync(opConfigPath, "utf-8")).toBe(raw);
  });

  it("does nothing when the PRIMARY itself is parked — akm enumerates neither", () => {
    const raw = `${JSON.stringify({
      bundles: {
        openpalm: { path: "/stash", writable: true, enabled: false },
        stash: { path: "/stash", writable: true },
      },
    }, null, 2)}\n`;
    writeFileSync(opConfigPath, raw);

    expect(reconcileDuplicateBundles(state)).toBe(false);
    expect(readFileSync(opConfigPath, "utf-8")).toBe(raw);
  });

  it("never lets a removed duplicate flip the primary's path, writability or enablement", () => {
    writeFileSync(opConfigPath, JSON.stringify({
      bundles: {
        openpalm: { path: "/stash", writable: true },
        stash: { path: "/stash/", writable: false, registryId: "/stash" },
      },
    }, null, 2));

    expect(reconcileDuplicateBundles(state)).toBe(true);
    const bundles = readJson(opConfigPath).bundles as Record<string, Record<string, unknown>>;
    // registryId is adopted; `writable: false` is NOT.
    expect(bundles.openpalm).toEqual({ path: "/stash", writable: true, registryId: "/stash" });
  });

  it("never adopts a component root that would move the survivor off its own directory", () => {
    // Both resolve to /stash, so they ARE duplicates — but the removed entry's
    // root is relative to "/", and the survivor keeps the primary's "/stash".
    writeFileSync(opConfigPath, JSON.stringify({
      bundles: {
        openpalm: { path: "/stash", writable: true },
        stash: { path: "/", writable: true, components: { m: { root: "stash" } }, registryId: "r" },
      },
    }, null, 2));

    expect(reconcileDuplicateBundles(state)).toBe(true);
    const bundles = readJson(opConfigPath).bundles as Record<string, Record<string, unknown>>;
    // registryId is adopted; the relocating components block is not.
    expect(bundles.openpalm).toEqual({ path: "/stash", writable: true, registryId: "r" });
  });

  it("counts path spellings that differ only by trailing slash, `//` or `/./`", () => {
    for (const spelling of ["/stash/", "/stash//", "/stash/./", "/stash/sub/../", "  /stash  "]) {
      writeFileSync(opConfigPath, JSON.stringify({
        bundles: { openpalm: { path: "/stash", writable: true }, stash: { path: spelling } },
      }, null, 2));
      expect(reconcileDuplicateBundles(state)).toBe(true);
      const bundles = readJson(opConfigPath).bundles as Record<string, unknown>;
      expect(Object.keys(bundles)).toEqual(["openpalm"]);
    }
  });

  it("repoints defaultWriteTarget when it names a removed bundle", () => {
    writeFileSync(opConfigPath, JSON.stringify({
      bundles: { openpalm: { path: "/stash", writable: true }, stash: { path: "/stash", writable: true } },
      defaultBundle: "openpalm",
      defaultWriteTarget: "stash",
    }, null, 2));

    expect(reconcileDuplicateBundles(state)).toBe(true);

    const cfg = readJson(opConfigPath);
    expect(cfg.defaultBundle).toBe("openpalm");
    expect(cfg.defaultWriteTarget).toBe("openpalm");
  });

  it("leaves a default that names a SURVIVING bundle exactly where it is", () => {
    writeFileSync(opConfigPath, JSON.stringify({
      bundles: {
        openpalm: { path: "/stash", writable: true },
        stash: { path: "/stash", writable: true },
        [HOST_SOURCE_NAME]: { path: "/host-stash", writable: true },
      },
      defaultBundle: HOST_SOURCE_NAME,
    }, null, 2));

    expect(reconcileDuplicateBundles(state)).toBe(true);
    // Not our business to "fix" — the guard only permits moving a default that
    // named a bundle this sweep removed.
    expect(readJson(opConfigPath).defaultBundle).toBe(HOST_SOURCE_NAME);
  });

  it("is a no-op returning false when no bundle duplicates the primary — byte-identical file", () => {
    const raw = `${JSON.stringify({
      configVersion: "0.9.0",
      bundles: {
        openpalm: { path: "/stash", writable: true },
        [HOST_SOURCE_NAME]: { path: "/host-stash", writable: true },
        "openpalm-system": { path: "/system-stash", writable: false, enabled: true },
      },
      defaultBundle: "openpalm",
    }, null, 2)}\n`;
    writeFileSync(opConfigPath, raw);

    expect(reconcileDuplicateBundles(state)).toBe(false);
    expect(readFileSync(opConfigPath, "utf-8")).toBe(raw);
  });

  it("is a no-op on a second run — no rewrite on every boot", () => {
    writeFileSync(opConfigPath, JSON.stringify(liveShape(), null, 2));
    expect(reconcileDuplicateBundles(state)).toBe(true);
    const after = readFileSync(opConfigPath, "utf-8");

    expect(reconcileDuplicateBundles(state)).toBe(false);
    expect(readFileSync(opConfigPath, "utf-8")).toBe(after);
    // The neighbouring sweeps must not fight it back the other way — all three
    // run on every lifecycle pass against this one file.
    expect(stripRetiredAkmConfigKeys(state)).toBe(false);
    expect(ensureSystemBundle(state)).toBe(false);
    expect(reconcileDuplicateBundles(state)).toBe(false);
    expect(readFileSync(opConfigPath, "utf-8")).toBe(after);
  });

  it("leaves an unparseable config alone rather than destroying it", () => {
    writeFileSync(opConfigPath, "{ not json");
    expect(reconcileDuplicateBundles(state)).toBe(false);
    expect(readFileSync(opConfigPath, "utf-8")).toBe("{ not json");
  });

  it("does nothing when there is no primary bundle to be a duplicate of", () => {
    const raw = `${JSON.stringify({ bundles: { stash: { path: "/stash" }, other: { path: "/stash" } } }, null, 2)}\n`;
    writeFileSync(opConfigPath, raw);
    expect(reconcileDuplicateBundles(state)).toBe(false);
    expect(readFileSync(opConfigPath, "utf-8")).toBe(raw);
  });

  it("is a no-op when there is no config yet", () => {
    rmSync(opConfigPath, { force: true });
    expect(reconcileDuplicateBundles(state)).toBe(false);
    expect(existsSync(opConfigPath)).toBe(false);
  });

  it("writes mode 0600", () => {
    writeFileSync(opConfigPath, JSON.stringify(liveShape(), null, 2));
    expect(reconcileDuplicateBundles(state)).toBe(true);
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

  it("issue #645: translates a 0.12.x profiles.llm.default into engines.default instead of dropping it into engines: {}", () => {
    // The exact reported shape: a 0.12.x-era config upgraded in place. Before
    // the fix, stripRetiredAkmConfigKeys deleted `profiles` and stamped
    // configVersion "0.9.0" without ever reading it, leaving `engines: {}` —
    // structurally valid, silently useless.
    writeFileSync(opConfigPath, JSON.stringify({
      profiles: {
        llm: {
          default: {
            endpoint: "https://api.openai.com/v1/chat/completions",
            model: "gpt-4o-mini",
            provider: "openai",
            apiKey: "sk-live-legacy-secret-abc123",
          },
        },
      },
      defaults: { llm: "default" },
      bundles: { openpalm: { path: "/stash", writable: true } },
      defaultBundle: "openpalm",
    }, null, 2));

    expect(stripRetiredAkmConfigKeys(state)).toBe(true);

    const cfg = readJson(opConfigPath);
    expect(cfg.profiles).toBeUndefined();
    // The whole point: an engine now exists instead of `engines: {}`.
    expect(cfg.engines).toEqual({
      default: { kind: "llm", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini", provider: "openai" },
    });
    expect((cfg.defaults as Record<string, unknown>).llmEngine).toBe("default");
    expect((cfg.defaults as Record<string, unknown>).llm).toBeUndefined();
    // A literal apiKey is never carried over: akm 0.9's engine schema requires
    // an env-var reference ($VAR), and config/akm/config.json is non-secret.
    expect((cfg.engines as Record<string, Record<string, unknown>>).default.apiKey).toBeUndefined();
  });

  it("issue #645: never overwrites a live engine with the same name as a legacy profile", () => {
    writeFileSync(opConfigPath, JSON.stringify({
      profiles: { llm: { default: { endpoint: "https://old/v1/chat/completions", model: "old-model" } } },
      engines: { default: { kind: "llm", endpoint: "https://new/v1/chat/completions", model: "new-model" } },
      bundles: { openpalm: { path: "/stash", writable: true } },
      defaultBundle: "openpalm",
      configVersion: "0.9.0",
    }, null, 2));

    expect(stripRetiredAkmConfigKeys(state)).toBe(true);

    const cfg = readJson(opConfigPath);
    expect(cfg.profiles).toBeUndefined();
    expect(cfg.engines).toEqual({ default: { kind: "llm", endpoint: "https://new/v1/chat/completions", model: "new-model" } });
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

  it("rewrites loopback endpoints to host.docker.internal — the persisted file is container-view (W10)", () => {
    // The real report: a host LM Studio config imported verbatim. It loaded
    // fine, so validation kept it — and every LLM call then dialed the
    // assistant container's OWN loopback instead of the host.
    seedHost({
      engines: {
        lmstudio: { kind: "llm", endpoint: "http://localhost:1234/v1/chat/completions", model: "qwen" },
        dotted: { kind: "llm", endpoint: "https://127.0.0.1:8443/v1", model: "m" },
        v6: { kind: "llm", endpoint: "http://[::1]:11434/api", model: "m" },
      },
      embedding: { endpoint: "http://localhost:1234/v1/embeddings", model: "nomic", dimension: 768 },
    });
    writeFileSync(opConfigPath, "{}");

    const { imported } = importHostAkmConfig(state, hostCfg());

    expect(imported).toEqual(expect.arrayContaining(["engines", "embedding"]));
    const cfg = readJson(opConfigPath);
    const engines = cfg.engines as Record<string, Record<string, unknown>>;
    expect(engines.lmstudio.endpoint).toBe("http://host.docker.internal:1234/v1/chat/completions");
    expect(engines.dotted.endpoint).toBe("https://host.docker.internal:8443/v1");
    expect(engines.v6.endpoint).toBe("http://host.docker.internal:11434/api");
    // Non-URL strings are never touched.
    expect(engines.lmstudio.model).toBe("qwen");
    expect((cfg.embedding as Record<string, unknown>).endpoint).toBe(
      "http://host.docker.internal:1234/v1/embeddings",
    );
  });

  it("leaves non-loopback endpoints and the operator's own values alone", () => {
    seedHost({
      engines: {
        lan: { kind: "llm", endpoint: "http://192.168.1.50:1234/v1", model: "m" },
        remote: { kind: "llm", endpoint: "https://api.openai.com/v1", model: "m" },
      },
    });
    // A loopback endpoint the operator set in the ASSISTANT's own config
    // (e.g. an in-container sidecar) is theirs: the import must not rewrite
    // anything it was not asked to add.
    writeFileSync(opConfigPath, JSON.stringify({
      configVersion: "0.9.0",
      engines: { sidecar: { kind: "llm", endpoint: "http://localhost:8080/v1", model: "m" } },
    }, null, 2));

    importHostAkmConfig(state, hostCfg());

    const engines = readJson(opConfigPath).engines as Record<string, Record<string, unknown>>;
    expect(engines.lan.endpoint).toBe("http://192.168.1.50:1234/v1");
    expect(engines.remote.endpoint).toBe("https://api.openai.com/v1");
    expect(engines.sidecar.endpoint).toBe("http://localhost:8080/v1");
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
