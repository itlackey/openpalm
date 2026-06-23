/**
 * Tests for core-assets — directory creation and compose reading.
 *
 * After the CoreAssetProvider removal, ensure* functions only create
 * directories. Asset file content is seeded from the BUNDLED local source by
 * refreshCoreAssetsFromSource() (covered in packages/lib core-assets tests) or
 * by the CLI install command. The GitHub-download path (refreshCoreAssets) was
 * removed entirely.
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
  ensureCoreCompose,
  readCoreCompose,
  ensureOpenCodeSystemConfig
} from "@openpalm/lib";
import { makeTempDir, trackDir, registerCleanup } from "./test-helpers.js";

registerCleanup();

// ── Core Compose (stack/ source of truth) ──────────────────────────────

describe("ensureCoreCompose / readCoreCompose", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OP_HOME = process.env.OP_HOME;
    process.env.OP_HOME = trackDir(makeTempDir());
  });

  afterEach(() => {
    process.env.OP_HOME = origEnv.OP_HOME;
  });

  test("ensureCoreCompose creates stack/ directory and returns path", () => {
    const path = ensureCoreCompose();
    expect(path).toContain("core.compose.yml");
    expect(path).toContain("stack");
    // Directory should exist even though file is not written
    const stackDir = join(process.env.OP_HOME!, "config", "stack");
    expect(existsSync(stackDir)).toBe(true);
  });

  test("ensureCoreCompose is idempotent", () => {
    const path1 = ensureCoreCompose();
    const path2 = ensureCoreCompose();
    expect(path1).toBe(path2);
  });

  test("ensureCoreCompose does not overwrite existing file", () => {
    const stackDir = join(process.env.OP_HOME!, "config", "stack");
    mkdirSync(stackDir, { recursive: true });
    const existingContent = "# user-managed compose\nservices: {}";
    writeFileSync(join(stackDir, "core.compose.yml"), existingContent);

    ensureCoreCompose();
    const content = readFileSync(join(stackDir, "core.compose.yml"), "utf-8");
    expect(content).toBe(existingContent);
  });

  test("readCoreCompose returns file content when file exists", () => {
    const stackDir = join(process.env.OP_HOME!, "config", "stack");
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
    const assistantDir = join(process.env.OP_HOME!, "data", "assistant");
    expect(existsSync(assistantDir)).toBe(true);
  });

  test("is idempotent", () => {
    ensureOpenCodeSystemConfig();
    ensureOpenCodeSystemConfig();
    const assistantDir = join(process.env.OP_HOME!, "data", "assistant");
    expect(existsSync(assistantDir)).toBe(true);
  });

  test("does not overwrite existing files", () => {
    const assistantDir = join(process.env.OP_HOME!, "data", "assistant");
    mkdirSync(assistantDir, { recursive: true });
    writeFileSync(join(assistantDir, "opencode.jsonc"), "user-config");
    writeFileSync(join(assistantDir, "AGENTS.md"), "user-agents");

    ensureOpenCodeSystemConfig();

    expect(readFileSync(join(assistantDir, "opencode.jsonc"), "utf-8")).toBe("user-config");
    expect(readFileSync(join(assistantDir, "AGENTS.md"), "utf-8")).toBe("user-agents");
  });
});
