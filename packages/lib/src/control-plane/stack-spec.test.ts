/**
 * Stack spec parser tests.
 *
 * Verifies that readStackSpec / writeStackSpec produce consistent results.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readStackSpec,
  writeStackSpec,
  STACK_SPEC_FILENAME,
} from "./stack-spec.js";
import type { StackSpec } from "./stack-spec.js";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "stack-spec-test-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

const MINIMAL_SPEC: StackSpec = { version: 2 };

// ── readStackSpec / writeStackSpec round-trip ────────────────────────────

describe("readStackSpec / writeStackSpec round-trip", () => {
  it("round-trips a minimal spec", () => {
    writeStackSpec(configDir, MINIMAL_SPEC);
    const read = readStackSpec(configDir);
    expect(read).not.toBeNull();
    expect(read!.version).toBe(2);
  });

  it("writes to the canonical filename", () => {
    writeStackSpec(configDir, MINIMAL_SPEC);
    const expectedPath = join(configDir, STACK_SPEC_FILENAME);
    expect(expectedPath).toBe(join(configDir, "stack.yml"));
    expect(readStackSpec(configDir)).not.toBeNull();
  });

  it("ignores legacy capabilities fields on read", () => {
    // On upgraded installs, old stack.yml may have capabilities — should still parse
    writeFileSync(join(configDir, STACK_SPEC_FILENAME),
      "version: 2\ncapabilities:\n  llm: openai/gpt-4o\n  embeddings:\n    provider: openai\n    model: text-embedding-3-small\n    dims: 1536\n"
    );
    const read = readStackSpec(configDir);
    expect(read).not.toBeNull();
    expect(read!.version).toBe(2);
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

  it("returns valid spec for version 2 with no other fields", () => {
    writeFileSync(join(configDir, STACK_SPEC_FILENAME), "version: 2\n");
    const spec = readStackSpec(configDir);
    expect(spec).not.toBeNull();
    expect(spec!.version).toBe(2);
  });
});

// ── STACK_SPEC_FILENAME ───────────────────────────────────────────────────

describe("STACK_SPEC_FILENAME", () => {
  it("is stack.yml", () => {
    expect(STACK_SPEC_FILENAME).toBe("stack.yml");
  });
});
