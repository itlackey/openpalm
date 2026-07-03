/**
 * Tests for core-assets — directory creation and compose reading.
 *
 * After the CoreAssetProvider removal, ensure* functions only create
 * directories. The managed system/ tree is overwritten from the BUNDLED local
 * source by overwriteSystemTree() (covered in packages/lib core-assets tests).
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync
} from "node:fs";
import { join } from "node:path";

import {
  readCoreCompose,
  ensureOpenCodeSystemConfig
} from "@openpalm/lib";
import { makeTempDir, trackDir, registerCleanup } from "./test-helpers.js";

registerCleanup();

// ── Core Compose (stack/ source of truth) ──────────────────────────────

describe("readCoreCompose", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OP_HOME = process.env.OP_HOME;
    process.env.OP_HOME = trackDir(makeTempDir());
  });

  afterEach(() => {
    process.env.OP_HOME = origEnv.OP_HOME;
  });

  test("readCoreCompose returns file content when file exists", () => {
    // biome-ignore lint/style/noNonNullAssertion: OP_HOME is assigned in beforeEach, so it is defined for every test in this suite.
    const stackDir = join(process.env.OP_HOME!, "system", "stack");
    mkdirSync(stackDir, { recursive: true });
    const composeContent = "services:\n  memory:\n    image: test\n";
    writeFileSync(join(stackDir, "core.compose.yml"), composeContent);

    const content = readCoreCompose();
    expect(content).toBe(composeContent);
  });

  test("readCoreCompose falls back to the bundled repo asset when live file is missing", () => {
    const content = readCoreCompose();
    expect(content).toContain('services:');
    expect(content).toContain('assistant:');
  });
});

// ── ensureOpenCodeSystemConfig ────────────────────────────────────────────

describe("ensureOpenCodeSystemConfig", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OP_HOME = process.env.OP_HOME;
    process.env.OP_HOME = trackDir(makeTempDir());
  });

  afterEach(() => {
    process.env.OP_HOME = origEnv.OP_HOME;
  });

  test("creates data/assistant/ directory", () => {
    ensureOpenCodeSystemConfig();
    // biome-ignore lint/style/noNonNullAssertion: OP_HOME is assigned in beforeEach, so it is defined for every test in this suite.
    const assistantDir = join(process.env.OP_HOME!, "data", "assistant");
    expect(existsSync(assistantDir)).toBe(true);
  });

  test("is idempotent", () => {
    ensureOpenCodeSystemConfig();
    ensureOpenCodeSystemConfig();
    // biome-ignore lint/style/noNonNullAssertion: OP_HOME is assigned in beforeEach, so it is defined for every test in this suite.
    const assistantDir = join(process.env.OP_HOME!, "data", "assistant");
    expect(existsSync(assistantDir)).toBe(true);
  });

  test("does not overwrite existing files", () => {
    // biome-ignore lint/style/noNonNullAssertion: OP_HOME is assigned in beforeEach, so it is defined for every test in this suite.
    const assistantDir = join(process.env.OP_HOME!, "data", "assistant");
    mkdirSync(assistantDir, { recursive: true });
    writeFileSync(join(assistantDir, "opencode.jsonc"), "user-config");
    writeFileSync(join(assistantDir, "AGENTS.md"), "user-agents");

    ensureOpenCodeSystemConfig();

    expect(readFileSync(join(assistantDir, "opencode.jsonc"), "utf-8")).toBe("user-config");
    expect(readFileSync(join(assistantDir, "AGENTS.md"), "utf-8")).toBe("user-agents");
  });
});
