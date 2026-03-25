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
    const stackDir = join(process.env.OP_HOME!, "stack");
    expect(existsSync(stackDir)).toBe(true);
  });

  test("ensureCoreCompose is idempotent", () => {
    const path1 = ensureCoreCompose();
    const path2 = ensureCoreCompose();
    expect(path1).toBe(path2);
  });

  test("ensureCoreCompose does not overwrite existing file", () => {
    const stackDir = join(process.env.OP_HOME!, "stack");
    mkdirSync(stackDir, { recursive: true });
    const existingContent = "# user-managed compose\nservices: {}";
    writeFileSync(join(stackDir, "core.compose.yml"), existingContent);

    ensureCoreCompose();
    const content = readFileSync(join(stackDir, "core.compose.yml"), "utf-8");
    expect(content).toBe(existingContent);
  });

  test("readCoreCompose returns file content when file exists", () => {
    const stackDir = join(process.env.OP_HOME!, "stack");
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
      if (url.includes("AGENTS.md")) {
        return new Response("# OpenCode Agents\n", { status: 200 });
      }
      if (url.includes("user.env.schema")) {
        return new Response("# @defaultSensitive=true\n", { status: 200 });
      }
      if (url.includes("stack.env.schema")) {
        return new Response("# @defaultSensitive=false\n", { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });
  }

  test("downloads and writes new assets when none exist", async () => {
    const homeDir = process.env.OP_HOME!;
    mockFetchAll();

    const result = await refreshCoreAssets();
    expect(result.updated).toContain("stack/core.compose.yml");
    expect(result.updated).toContain("data/assistant/opencode.jsonc");
    expect(result.updated).toContain("data/assistant/AGENTS.md");
    expect(result.updated).toContain("vault/user/user.env.schema");
    expect(result.updated).toContain("vault/stack/stack.env.schema");
    expect(result.backupDir).toBeNull(); // no existing files to back up

    expect(existsSync(join(homeDir, "stack/core.compose.yml"))).toBe(true);
    expect(existsSync(join(homeDir, "data/assistant/opencode.jsonc"))).toBe(true);
    expect(existsSync(join(homeDir, "data/assistant/AGENTS.md"))).toBe(true);
    expect(existsSync(join(homeDir, "vault/user/user.env.schema"))).toBe(true);
    expect(existsSync(join(homeDir, "vault/stack/stack.env.schema"))).toBe(true);
  });

  test("backs up changed files before overwriting", async () => {
    const homeDir = process.env.OP_HOME!;
    mkdirSync(join(homeDir, "stack"), { recursive: true });
    writeFileSync(join(homeDir, "stack/core.compose.yml"), "old-compose-content");
    mkdirSync(join(homeDir, "data/assistant"), { recursive: true });
    writeFileSync(join(homeDir, "data/assistant/opencode.jsonc"), "old-opencode-content");
    writeFileSync(join(homeDir, "data/assistant/AGENTS.md"), "old-agents-content");
    mockFetchAll();

    const result = await refreshCoreAssets();
    expect(result.updated.length).toBeGreaterThanOrEqual(3);
    expect(result.backupDir).not.toBeNull();

    // Verify backup contains old content
    const backupCompose = readFileSync(join(result.backupDir!, "stack/core.compose.yml"), "utf-8");
    expect(backupCompose).toBe("old-compose-content");
    const backupOpencode = readFileSync(join(result.backupDir!, "data/assistant/opencode.jsonc"), "utf-8");
    expect(backupOpencode).toBe("old-opencode-content");
    const backupAgents = readFileSync(join(result.backupDir!, "data/assistant/AGENTS.md"), "utf-8");
    expect(backupAgents).toBe("old-agents-content");

    // Verify new content written
    expect(readFileSync(join(homeDir, "stack/core.compose.yml"), "utf-8")).not.toBe("old-compose-content");
    expect(readFileSync(join(homeDir, "data/assistant/opencode.jsonc"), "utf-8")).not.toBe("old-opencode-content");
    expect(readFileSync(join(homeDir, "data/assistant/AGENTS.md"), "utf-8")).not.toBe("old-agents-content");
  });

  test("skips assets with identical content", async () => {
    const homeDir = process.env.OP_HOME!;
    const content = "same-content";
    mkdirSync(join(homeDir, "stack"), { recursive: true });
    writeFileSync(join(homeDir, "stack/core.compose.yml"), content);
    mkdirSync(join(homeDir, "data/assistant"), { recursive: true });
    writeFileSync(join(homeDir, "data/assistant/opencode.jsonc"), content);
    writeFileSync(join(homeDir, "data/assistant/AGENTS.md"), content);
    mkdirSync(join(homeDir, "vault/user"), { recursive: true });
    mkdirSync(join(homeDir, "vault/stack"), { recursive: true });
    writeFileSync(join(homeDir, "vault/user/user.env.schema"), content);
    writeFileSync(join(homeDir, "vault/stack/stack.env.schema"), content);
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
