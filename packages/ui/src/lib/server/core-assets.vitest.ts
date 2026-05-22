/**
 * Tests for core-assets — directory creation, compose reading, and
 * GitHub-based asset refresh.
 *
 * After the CoreAssetProvider removal, ensure* functions only create
 * directories. File content is written by refreshCoreAssets() (GitHub
 * download) or by the CLI install command.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync
} from "node:fs";
import { join } from "node:path";

import {
  ensureCoreCompose,
  readCoreCompose,
  ensureOpenCodeSystemConfig,
  refreshCoreAssets
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

  test("readCoreCompose throws when file does not exist", () => {
    expect(() => readCoreCompose()).toThrow();
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

  test("creates state/assistant/ directory", () => {
    ensureOpenCodeSystemConfig();
    const assistantDir = join(process.env.OP_HOME!, "state", "assistant");
    expect(existsSync(assistantDir)).toBe(true);
  });

  test("is idempotent", () => {
    ensureOpenCodeSystemConfig();
    ensureOpenCodeSystemConfig();
    const assistantDir = join(process.env.OP_HOME!, "state", "assistant");
    expect(existsSync(assistantDir)).toBe(true);
  });

  test("does not overwrite existing files", () => {
    const dataDir = join(process.env.OP_HOME!, "data");
    const assistantDir = join(dataDir, "assistant");
    mkdirSync(assistantDir, { recursive: true });
    writeFileSync(join(assistantDir, "opencode.jsonc"), "user-config");
    writeFileSync(join(assistantDir, "AGENTS.md"), "user-agents");

    ensureOpenCodeSystemConfig();

    expect(readFileSync(join(assistantDir, "opencode.jsonc"), "utf-8")).toBe("user-config");
    expect(readFileSync(join(assistantDir, "AGENTS.md"), "utf-8")).toBe("user-agents");
  });
});

// ── refreshCoreAssets ────────────────────────────────────────────────────

describe("refreshCoreAssets", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OP_HOME = process.env.OP_HOME;
    process.env.OP_HOME = trackDir(makeTempDir());
  });

  afterEach(() => {
    process.env.OP_HOME = origEnv.OP_HOME;
    vi.restoreAllMocks();
  });

  /** Mock fetch to return content for all managed asset URLs. */
  function mockFetchAll() {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("core.compose.yml")) {
        return new Response("services:\n  admin:\n    image: test\n", { status: 200 });
      }
      if (url.includes("opencode.jsonc")) {
        return new Response('{"$schema":"https://opencode.ai/config.json"}\n', { status: 200 });
      }
      if (url.includes("openpalm.md")) {
        return new Response("# OpenPalm Operational Guide\n", { status: 200 });
      }
      if (url.includes("system.md")) {
        return new Response("# System Prompt\n", { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });
  }

  test("downloads and writes new assets when none exist", async () => {
    const homeDir = process.env.OP_HOME!;
    mockFetchAll();

    const result = await refreshCoreAssets();
    expect(result.updated).toContain("config/stack/core.compose.yml");
    expect(result.updated).toContain("config/assistant/opencode.jsonc");
    expect(result.updated).toContain("config/assistant/openpalm.md");
    expect(result.updated).toContain("config/assistant/system.md");
    // Pre-v0.11 paths must not be resurrected.
    expect(result.updated).not.toContain("state/assistant/opencode.jsonc");
    expect(result.updated).not.toContain("state/assistant/AGENTS.md");
    expect(result.updated).not.toContain("vault/user/user.env.schema");
    expect(result.updated).not.toContain("config/stack/stack.env.schema");
    expect(result.backupDir).toBeNull(); // no existing files to back up

    expect(existsSync(join(homeDir, "config/stack/core.compose.yml"))).toBe(true);
    expect(existsSync(join(homeDir, "config/assistant/opencode.jsonc"))).toBe(true);
    expect(existsSync(join(homeDir, "config/assistant/openpalm.md"))).toBe(true);
    expect(existsSync(join(homeDir, "config/assistant/system.md"))).toBe(true);
    expect(existsSync(join(homeDir, "vault/user/user.env.schema"))).toBe(false);
    expect(existsSync(join(homeDir, "config/stack/stack.env.schema"))).toBe(false);
  });

  test("backs up changed files before overwriting", async () => {
    const homeDir = process.env.OP_HOME!;
    mkdirSync(join(homeDir, "config/stack"), { recursive: true });
    writeFileSync(join(homeDir, "config/stack/core.compose.yml"), "old-compose-content");
    mkdirSync(join(homeDir, "config/assistant"), { recursive: true });
    writeFileSync(join(homeDir, "config/assistant/opencode.jsonc"), "old-opencode-content");
    writeFileSync(join(homeDir, "config/assistant/openpalm.md"), "old-openpalm-content");
    writeFileSync(join(homeDir, "config/assistant/system.md"), "old-system-content");
    mockFetchAll();

    const result = await refreshCoreAssets();
    expect(result.updated.length).toBeGreaterThanOrEqual(4);
    expect(result.backupDir).not.toBeNull();

    // Verify backup contains old content
    const backupCompose = readFileSync(join(result.backupDir!, "config/stack/core.compose.yml"), "utf-8");
    expect(backupCompose).toBe("old-compose-content");
    const backupOpencode = readFileSync(join(result.backupDir!, "config/assistant/opencode.jsonc"), "utf-8");
    expect(backupOpencode).toBe("old-opencode-content");
    const backupOpenpalm = readFileSync(join(result.backupDir!, "config/assistant/openpalm.md"), "utf-8");
    expect(backupOpenpalm).toBe("old-openpalm-content");
    const backupSystem = readFileSync(join(result.backupDir!, "config/assistant/system.md"), "utf-8");
    expect(backupSystem).toBe("old-system-content");

    // Verify new content written
    expect(readFileSync(join(homeDir, "config/stack/core.compose.yml"), "utf-8")).not.toBe("old-compose-content");
    expect(readFileSync(join(homeDir, "config/assistant/opencode.jsonc"), "utf-8")).not.toBe("old-opencode-content");
    expect(readFileSync(join(homeDir, "config/assistant/openpalm.md"), "utf-8")).not.toBe("old-openpalm-content");
    expect(readFileSync(join(homeDir, "config/assistant/system.md"), "utf-8")).not.toBe("old-system-content");
  });

  test("skips assets with identical content", async () => {
    const homeDir = process.env.OP_HOME!;
    const content = "same-content";
    mkdirSync(join(homeDir, "config/stack"), { recursive: true });
    writeFileSync(join(homeDir, "config/stack/core.compose.yml"), content);
    mkdirSync(join(homeDir, "config/assistant"), { recursive: true });
    writeFileSync(join(homeDir, "config/assistant/opencode.jsonc"), content);
    writeFileSync(join(homeDir, "config/assistant/openpalm.md"), content);
    writeFileSync(join(homeDir, "config/assistant/system.md"), content);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(content, { status: 200 });
    });

    const result = await refreshCoreAssets();
    expect(result.updated).toHaveLength(0);
    expect(result.backupDir).toBeNull();
  });

  test("throws when both GitHub URLs fail", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("Not found", { status: 404 });
    });

    await expect(refreshCoreAssets()).rejects.toThrow("Failed to download");
  });
});
