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

function makeSpec(): StackSpec {
  return {
    version: 2,
    capabilities: {
      llm: "openai/gpt-4o",
      embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 },
      memory: { userId: "test-user" },
    },
  };
}

// ── readStackSpec / writeStackSpec round-trip ────────────────────────────

describe("readStackSpec / writeStackSpec round-trip", () => {
  it("round-trips a spec with capabilities only", () => {
    const spec = makeSpec();
    writeStackSpec(configDir, spec);
    const read = readStackSpec(configDir);
    expect(read).not.toBeNull();
    expect(read!.version).toBe(2);
    expect(read!.capabilities.llm).toBe("openai/gpt-4o");
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
    writeFileSync(join(configDir, STACK_SPEC_FILENAME), "version: 2\n");
    expect(readStackSpec(configDir)).toBeNull();
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
    expect(() => updateCapability(configDir, "llm", "test")).toThrow("stack.yml not found or invalid");
  });
});

// ── stackSpecPath / STACK_SPEC_FILENAME ──────────────────────────────────

describe("stackSpecPath", () => {
  it("returns configDir/stack.yml", () => {
    expect(stackSpecPath("/foo/config")).toBe("/foo/config/stack.yml");
  });

  it("uses STACK_SPEC_FILENAME constant", () => {
    expect(STACK_SPEC_FILENAME).toBe("stack.yml");
    expect(stackSpecPath(configDir)).toBe(`${configDir}/${STACK_SPEC_FILENAME}`);
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
