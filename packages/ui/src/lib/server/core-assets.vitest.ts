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
      if (url.includes("services.compose.yml")) {
        return new Response("services: {}\n", { status: 200 });
      }
      if (url.includes("channels.compose.yml")) {
        return new Response("services: {}\n", { status: 200 });
      }
      if (url.includes("custom.compose.yml")) {
        return new Response("services: {}\n", { status: 200 });
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

    const result = await refreshCoreAssets("v0.11.0-rc.6");
    // Fixed stack compose files are managed (overwritten on change)
    expect(result.updated).toContain("config/stack/core.compose.yml");
    expect(result.updated).toContain("config/stack/services.compose.yml");
    expect(result.updated).toContain("config/stack/channels.compose.yml");
    // custom.compose.yml is seeded-only.
    expect(result.updated).toContain("config/stack/custom.compose.yml");
    // opencode.jsonc is seeded-only: written when missing, never overwritten
    expect(result.updated).toContain("config/assistant/opencode.jsonc");
    // Persona files (openpalm.md, system.md) are seeded via seedOpenPalmDir,
    // not by refreshCoreAssets — they must not appear here.
    expect(result.updated).not.toContain("config/assistant/openpalm.md");
    expect(result.updated).not.toContain("config/assistant/system.md");
    // Pre-v0.11 paths must not be resurrected.
    expect(result.updated).not.toContain("state/assistant/opencode.jsonc");
    expect(result.updated).not.toContain("state/assistant/AGENTS.md");
    expect(result.updated).not.toContain("vault/user/user.env.schema");
    expect(result.updated).not.toContain("config/stack/stack.env.schema");
    expect(result.backupDir).toBeNull(); // no existing files to back up

    expect(existsSync(join(homeDir, "config/stack/core.compose.yml"))).toBe(true);
    expect(existsSync(join(homeDir, "config/stack/services.compose.yml"))).toBe(true);
    expect(existsSync(join(homeDir, "config/stack/channels.compose.yml"))).toBe(true);
    expect(existsSync(join(homeDir, "config/stack/custom.compose.yml"))).toBe(true);
    expect(existsSync(join(homeDir, "config/assistant/opencode.jsonc"))).toBe(true);
    expect(existsSync(join(homeDir, "vault/user/user.env.schema"))).toBe(false);
    expect(existsSync(join(homeDir, "config/stack/stack.env.schema"))).toBe(false);
  });

  test("backs up and overwrites managed assets; preserves seeded user-editable files", async () => {
    const homeDir = process.env.OP_HOME!;
    mkdirSync(join(homeDir, "config/stack"), { recursive: true });
    writeFileSync(join(homeDir, "config/stack/core.compose.yml"), "old-compose-content");
    writeFileSync(join(homeDir, "config/stack/services.compose.yml"), "old-services-content");
    writeFileSync(join(homeDir, "config/stack/channels.compose.yml"), "old-channels-content");
    writeFileSync(join(homeDir, "config/stack/custom.compose.yml"), "user-custom-compose");
    mkdirSync(join(homeDir, "config/assistant"), { recursive: true });
    writeFileSync(join(homeDir, "config/assistant/opencode.jsonc"), "user-customized-opencode");
    mockFetchAll();

    const result = await refreshCoreAssets("v0.11.0-rc.6");
    // core.compose.yml is managed — backed up and overwritten
    expect(result.updated).toContain("config/stack/core.compose.yml");
    expect(result.updated).toContain("config/stack/services.compose.yml");
    expect(result.updated).toContain("config/stack/channels.compose.yml");
    expect(result.backupDir).not.toBeNull();
    const backupCompose = readFileSync(join(result.backupDir!, "config/stack/core.compose.yml"), "utf-8");
    expect(backupCompose).toBe("old-compose-content");
    expect(readFileSync(join(homeDir, "config/stack/core.compose.yml"), "utf-8")).not.toBe("old-compose-content");

    // opencode.jsonc is seeded-only — existing user customizations must be preserved
    expect(result.updated).not.toContain("config/assistant/opencode.jsonc");
    expect(readFileSync(join(homeDir, "config/assistant/opencode.jsonc"), "utf-8")).toBe("user-customized-opencode");
    expect(result.updated).not.toContain("config/stack/custom.compose.yml");
    expect(readFileSync(join(homeDir, "config/stack/custom.compose.yml"), "utf-8")).toBe("user-custom-compose");
  });

  test("skips assets with identical content", async () => {
    const homeDir = process.env.OP_HOME!;
    const content = "same-content";
    mkdirSync(join(homeDir, "config/stack"), { recursive: true });
    writeFileSync(join(homeDir, "config/stack/core.compose.yml"), content);
    writeFileSync(join(homeDir, "config/stack/services.compose.yml"), content);
    writeFileSync(join(homeDir, "config/stack/channels.compose.yml"), content);
    writeFileSync(join(homeDir, "config/stack/custom.compose.yml"), content);
    mkdirSync(join(homeDir, "config/assistant"), { recursive: true });
    writeFileSync(join(homeDir, "config/assistant/opencode.jsonc"), content);
    writeFileSync(join(homeDir, "config/assistant/openpalm.md"), content);
    writeFileSync(join(homeDir, "config/assistant/system.md"), content);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(content, { status: 200 });
    });

    const result = await refreshCoreAssets("v0.11.0-rc.6");
    expect(result.updated).toHaveLength(0);
    expect(result.backupDir).toBeNull();
  });

  test("throws when both GitHub URLs fail", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("Not found", { status: 404 });
    });

    await expect(refreshCoreAssets("v0.11.0-rc.6")).rejects.toThrow("Failed to download");
  });
});
