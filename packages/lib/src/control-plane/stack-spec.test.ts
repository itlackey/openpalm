/**
 * Stack spec parser tests.
 *
 * Verifies that readStackSpec / writeStackSpec produce consistent results
 * and that all addon resolution goes through the canonical lib functions.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readStackSpec,
  writeStackSpec,
  hasAddon,
  addonNames,
  STACK_SPEC_FILENAME,
  stackSpecPath,
  parseCapabilityString,
  formatCapabilityString,
  updateCapability,
} from "./stack-spec.js";
import type { StackSpec } from "./stack-spec.js";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "stack-spec-test-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────

function makeSpec(addons: Record<string, boolean | { env?: Record<string, string> }> = {}): StackSpec {
  return {
    version: 2,
    capabilities: {
      llm: "openai/gpt-4o",
      embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 },
      memory: { userId: "test-user" },
    },
    addons,
  };
}

// ── readStackSpec / writeStackSpec round-trip ────────────────────────────

describe("readStackSpec / writeStackSpec round-trip", () => {
  it("round-trips a spec with no addons", () => {
    const spec = makeSpec();
    writeStackSpec(configDir, spec);
    const read = readStackSpec(configDir);
    expect(read).not.toBeNull();
    expect(read!.version).toBe(2);
    expect(read!.addons).toEqual({});
    expect(read!.capabilities.llm).toBe("openai/gpt-4o");
  });

  it("round-trips a spec with boolean addons", () => {
    const spec = makeSpec({ admin: true, chat: true, discord: false });
    writeStackSpec(configDir, spec);
    const read = readStackSpec(configDir);
    expect(read).not.toBeNull();
    expect(read!.addons.admin).toBe(true);
    expect(read!.addons.chat).toBe(true);
    expect(read!.addons.discord).toBe(false);
  });

  it("round-trips a spec with env-carrying addons", () => {
    const spec = makeSpec({ discord: { env: { DISCORD_TOKEN: "abc" } } });
    writeStackSpec(configDir, spec);
    const read = readStackSpec(configDir);
    expect(read).not.toBeNull();
    const discordVal = read!.addons.discord;
    expect(typeof discordVal).toBe("object");
    expect((discordVal as { env: Record<string, string> }).env.DISCORD_TOKEN).toBe("abc");
  });

  it("writes to the canonical filename", () => {
    writeStackSpec(configDir, makeSpec());
    const expectedPath = join(configDir, STACK_SPEC_FILENAME);
    const read = readStackSpec(configDir);
    expect(read).not.toBeNull();
    expect(stackSpecPath(configDir)).toBe(expectedPath);
  });
});

// ── readStackSpec edge cases ────────────────────────────────────────────

describe("readStackSpec edge cases", () => {
  it("returns null for missing file", () => {
    expect(readStackSpec(configDir)).toBeNull();
  });

  it("returns null for v1 format (connections array)", () => {
    writeFileSync(join(configDir, STACK_SPEC_FILENAME), "version: 1\nconnections: []\n");
    expect(readStackSpec(configDir)).toBeNull();
  });

  it("returns null for corrupt YAML", () => {
    writeFileSync(join(configDir, STACK_SPEC_FILENAME), "{{invalid yaml");
    expect(readStackSpec(configDir)).toBeNull();
  });

  it("returns null when capabilities is missing", () => {
    writeFileSync(join(configDir, STACK_SPEC_FILENAME), "version: 2\naddons: {}\n");
    expect(readStackSpec(configDir)).toBeNull();
  });

  it("defaults addons to empty object when missing", () => {
    writeFileSync(
      join(configDir, STACK_SPEC_FILENAME),
      "version: 2\ncapabilities:\n  llm: openai/gpt-4o\n  embeddings:\n    provider: openai\n    model: test\n    dims: 768\n  memory:\n    userId: test\n"
    );
    const spec = readStackSpec(configDir);
    expect(spec).not.toBeNull();
    expect(spec!.addons).toEqual({});
  });
});

// ── Addon helpers ───────────────────────────────────────────────────────

describe("hasAddon", () => {
  it("returns true for enabled boolean addon", () => {
    expect(hasAddon(makeSpec({ chat: true }), "chat")).toBe(true);
  });

  it("returns false for disabled boolean addon", () => {
    expect(hasAddon(makeSpec({ chat: false }), "chat")).toBe(false);
  });

  it("returns false for missing addon", () => {
    expect(hasAddon(makeSpec({}), "chat")).toBe(false);
  });

  it("returns true for addon with env config", () => {
    expect(hasAddon(makeSpec({ discord: { env: { TOKEN: "abc" } } }), "discord")).toBe(true);
  });
});

describe("addonNames", () => {
  it("returns only enabled addon names", () => {
    const spec = makeSpec({ admin: true, chat: true, discord: false, voice: { env: { KEY: "val" } } });
    const names = addonNames(spec);
    expect(names.sort()).toEqual(["admin", "chat", "voice"]);
  });

  it("returns empty array for no addons", () => {
    expect(addonNames(makeSpec())).toEqual([]);
  });
});

// ── Addon parsing consistency ───────────────────────────────────────────

describe("addon parsing consistency", () => {
  it("writeStackSpec + readStackSpec produces same addon set as addonNames", () => {
    const input: Record<string, boolean | { env?: Record<string, string> }> = {
      admin: true,
      chat: true,
      discord: false,
      voice: { env: { TTS_KEY: "secret" } },
      ollama: true,
    };
    writeStackSpec(configDir, makeSpec(input));
    const read = readStackSpec(configDir);
    expect(read).not.toBeNull();

    const expected = ["admin", "chat", "ollama", "voice"];
    expect(addonNames(read!).sort()).toEqual(expected);

    // Same result from hasAddon individually
    for (const name of expected) {
      expect(hasAddon(read!, name)).toBe(true);
    }
    expect(hasAddon(read!, "discord")).toBe(false);
    expect(hasAddon(read!, "slack")).toBe(false);
  });

  it("buildComposeFileList and addonNames agree (via readStackSpec)", () => {
    // Simulate what lifecycle.ts buildComposeFileList does internally:
    // it reads the spec, iterates spec.addons, and checks addon !== false.
    const spec = makeSpec({ admin: true, chat: true, api: false });
    writeStackSpec(configDir, spec);
    const read = readStackSpec(configDir);
    expect(read).not.toBeNull();

    // addonNames filters out disabled
    const enabledFromHelper = addonNames(read!);
    // Manual iteration (same logic as buildComposeFileList)
    const enabledFromManual: string[] = [];
    for (const [name, value] of Object.entries(read!.addons)) {
      if (value !== false) enabledFromManual.push(name);
    }

    expect(enabledFromHelper.sort()).toEqual(enabledFromManual.sort());
    expect(enabledFromHelper.sort()).toEqual(["admin", "chat"]);
  });
});

// ── Capability helpers ──────────────────────────────────────────────────

describe("parseCapabilityString", () => {
  it("splits provider/model", () => {
    expect(parseCapabilityString("openai/gpt-4o")).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("handles model with slashes", () => {
    expect(parseCapabilityString("ollama/qwen/2.5-coder:3b")).toEqual({ provider: "ollama", model: "qwen/2.5-coder:3b" });
  });

  it("handles missing slash", () => {
    expect(parseCapabilityString("openai")).toEqual({ provider: "openai", model: "" });
  });
});

describe("formatCapabilityString", () => {
  it("joins provider and model", () => {
    expect(formatCapabilityString("openai", "gpt-4o")).toBe("openai/gpt-4o");
  });
});

// ── updateCapability ────────────────────────────────────────────────────

describe("updateCapability", () => {
  it("updates a single capability key", () => {
    writeStackSpec(configDir, makeSpec());
    updateCapability(configDir, "llm", "anthropic/claude-sonnet-4");
    const read = readStackSpec(configDir);
    expect(read).not.toBeNull();
    expect(read!.capabilities.llm).toBe("anthropic/claude-sonnet-4");
  });

  it("throws when spec is missing", () => {
    expect(() => updateCapability(configDir, "llm", "test")).toThrow("stack.yaml not found or invalid");
  });
});

// ── stackSpecPath / STACK_SPEC_FILENAME ──────────────────────────────────

describe("stackSpecPath", () => {
  it("returns configDir/stack.yaml", () => {
    expect(stackSpecPath("/foo/config")).toBe("/foo/config/stack.yaml");
  });

  it("uses STACK_SPEC_FILENAME constant", () => {
    expect(STACK_SPEC_FILENAME).toBe("stack.yaml");
    expect(stackSpecPath(configDir)).toBe(`${configDir}/${STACK_SPEC_FILENAME}`);
  });
});

// ── Round-trip with services field ───────────────────────────────────────

describe("services field round-trip", () => {
  it("preserves services in round-trip", () => {
    const spec: StackSpec = {
      ...makeSpec(),
      services: {
        "custom-svc": { env: { PORT: "9090" } },
      },
    };
    writeStackSpec(configDir, spec);
    const read = readStackSpec(configDir);
    expect(read).not.toBeNull();
    expect(read!.services).toBeDefined();
    expect(read!.services!["custom-svc"]).toEqual({ env: { PORT: "9090" } });
  });

  it("services field is optional (undefined when not set)", () => {
    writeStackSpec(configDir, makeSpec());
    const read = readStackSpec(configDir);
    expect(read).not.toBeNull();
    // services not set in makeSpec, so it should be undefined
    expect(read!.services).toBeUndefined();
  });
});

// ── writeStackSpec creates directory ─────────────────────────────────────

describe("writeStackSpec", () => {
  it("creates configDir if it does not exist", () => {
    const nestedDir = join(configDir, "nested", "deep");
    writeStackSpec(nestedDir, makeSpec());
    const read = readStackSpec(nestedDir);
    expect(read).not.toBeNull();
    expect(read!.version).toBe(2);
  });
});
