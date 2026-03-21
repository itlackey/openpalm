/**
 * Tests for core-assets.ts — data dir source-of-truth files:
 * compose and system config management.
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
} from "./core-assets.js";
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

  test("ensureCoreCompose creates core.compose.yml in stack/ if missing", () => {
    const path = ensureCoreCompose();
    expect(existsSync(path)).toBe(true);
    expect(path).toContain("core.compose.yml");
    expect(path).toContain("stack");
  });

  test("ensureCoreCompose is idempotent", () => {
    const path1 = ensureCoreCompose();
    const content1 = readFileSync(path1, "utf-8");
    const path2 = ensureCoreCompose();
    const content2 = readFileSync(path2, "utf-8");
    expect(content1).toBe(content2);
  });

  test("ensureCoreCompose overwrites stale file and creates backup", () => {
    const stackDir = join(process.env.OP_HOME!, "stack");
    mkdirSync(stackDir, { recursive: true });
    const staleContent = "# stale compose\nservices: {}";
    writeFileSync(join(stackDir, "core.compose.yml"), staleContent);

    const path = ensureCoreCompose();
    const content = readFileSync(path, "utf-8");
    expect(content).not.toBe(staleContent);
    expect(content).toContain("services:");

    // Verify backup was created
    const backupDir = join(stackDir, "backups");
    expect(existsSync(backupDir)).toBe(true);
    const backups = readdirSync(backupDir).filter(f => f.startsWith("core."));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(backupDir, backups[0]), "utf-8")).toBe(staleContent);
  });

  test("readCoreCompose returns file content", () => {
    const content = readCoreCompose();
    expect(content).toBeTruthy();
    expect(typeof content).toBe("string");
    expect(content).toContain("HOME: /data");
    expect(content).toContain("OP_HOME");
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

  test("seeds opencode.jsonc and AGENTS.md on first run", () => {
    const dataDir = join(process.env.OP_HOME!, "data");
    ensureOpenCodeSystemConfig();

    const configPath = join(dataDir, "assistant", "opencode.jsonc");
    const agentsPath = join(dataDir, "assistant", "AGENTS.md");
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(agentsPath)).toBe(true);

    const configContent = readFileSync(configPath, "utf-8");
    expect(configContent).toContain("$schema");
    const agentsContent = readFileSync(agentsPath, "utf-8");
    expect(agentsContent.length).toBeGreaterThan(0);
  });

  test("is idempotent — skips unchanged files", () => {
    ensureOpenCodeSystemConfig();
    const dataDir = join(process.env.OP_HOME!, "data");
    const configPath = join(dataDir, "assistant", "opencode.jsonc");
    const content1 = readFileSync(configPath, "utf-8");

    ensureOpenCodeSystemConfig();
    const content2 = readFileSync(configPath, "utf-8");
    expect(content1).toBe(content2);

    // No backups should exist since content didn't change
    const backupDir = join(dataDir, "assistant", "backups");
    expect(existsSync(backupDir)).toBe(false);
  });

  test("overwrites stale files and creates backups", () => {
    const dataDir = join(process.env.OP_HOME!, "data");
    const assistantDir = join(dataDir, "assistant");
    mkdirSync(assistantDir, { recursive: true });
    writeFileSync(join(assistantDir, "opencode.jsonc"), "stale-config");
    writeFileSync(join(assistantDir, "AGENTS.md"), "stale-agents");

    ensureOpenCodeSystemConfig();

    // Content should be updated
    const configContent = readFileSync(join(assistantDir, "opencode.jsonc"), "utf-8");
    expect(configContent).not.toBe("stale-config");
    expect(configContent).toContain("$schema");

    const agentsContent = readFileSync(join(assistantDir, "AGENTS.md"), "utf-8");
    expect(agentsContent).not.toBe("stale-agents");

    // Backups should exist
    const backupDir = join(assistantDir, "backups");
    expect(existsSync(backupDir)).toBe(true);
    const backups = readdirSync(backupDir);
    expect(backups.length).toBe(2);
    const configBackups = backups.filter(f => f.startsWith("opencode.jsonc."));
    const agentsBackups = backups.filter(f => f.startsWith("AGENTS.md."));
    expect(configBackups.length).toBe(1);
    expect(agentsBackups.length).toBe(1);
    expect(readFileSync(join(backupDir, configBackups[0]), "utf-8")).toBe("stale-config");
    expect(readFileSync(join(backupDir, agentsBackups[0]), "utf-8")).toBe("stale-agents");
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

  test("downloads and writes new assets when none exist", async () => {
    const homeDir = process.env.OP_HOME!;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("core.compose.yml")) {
        return new Response("services:\n  admin:\n    image: test\n", { status: 200 });
      }
      if (url.includes("admin-opencode.jsonc")) {
        return new Response('{"$schema":"https://opencode.ai/config.json","admin":true}\n', { status: 200 });
      }
      if (url.includes("opencode.jsonc")) {
        return new Response('{"$schema":"https://opencode.ai/config.json"}\n', { status: 200 });
      }
      if (url.includes("AGENTS.md")) {
        return new Response("# OpenCode Agents\n", { status: 200 });
      }
      if (url.includes("admin.yml")) {
        return new Response("services:\n  admin:\n    image: admin\n", { status: 200 });
      }
      if (url.includes("user.env.schema")) {
        return new Response("# @defaultSensitive=true\n", { status: 200 });
      }
      if (url.includes("stack.env.schema")) {
        return new Response("# @defaultSensitive=false\n", { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

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
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("core.compose.yml")) {
        return new Response("new-compose-content", { status: 200 });
      }
      if (url.includes("opencode.jsonc")) {
        return new Response("new-opencode-content", { status: 200 });
      }
      if (url.includes("AGENTS.md")) {
        return new Response("new-agents-content", { status: 200 });
      }
      if (url.includes("user.env.schema")) {
        return new Response("new-secrets-schema-content", { status: 200 });
      }
      if (url.includes("stack.env.schema")) {
        return new Response("new-stack-schema-content", { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await refreshCoreAssets();
    expect(result.updated).toHaveLength(5);
    expect(result.backupDir).not.toBeNull();

    // Verify backup contains old content
    const backupCompose = readFileSync(join(result.backupDir!, "stack/core.compose.yml"), "utf-8");
    expect(backupCompose).toBe("old-compose-content");
    const backupOpencode = readFileSync(join(result.backupDir!, "data/assistant/opencode.jsonc"), "utf-8");
    expect(backupOpencode).toBe("old-opencode-content");
    const backupAgents = readFileSync(join(result.backupDir!, "data/assistant/AGENTS.md"), "utf-8");
    expect(backupAgents).toBe("old-agents-content");

    // Verify new content written
    expect(readFileSync(join(homeDir, "stack/core.compose.yml"), "utf-8")).toBe("new-compose-content");
    expect(readFileSync(join(homeDir, "data/assistant/opencode.jsonc"), "utf-8")).toBe("new-opencode-content");
    expect(readFileSync(join(homeDir, "data/assistant/AGENTS.md"), "utf-8")).toBe("new-agents-content");
  });

  test("skips assets with identical content", async () => {
    const homeDir = process.env.OP_HOME!;
    const content = "same-content";
    mkdirSync(join(homeDir, "stack"), { recursive: true });
    writeFileSync(join(homeDir, "stack/core.compose.yml"), content);
    mkdirSync(join(homeDir, "data/assistant"), { recursive: true });
    writeFileSync(join(homeDir, "data/assistant/opencode.jsonc"), content);
    writeFileSync(join(homeDir, "data/assistant/AGENTS.md"), content);
    mkdirSync(join(homeDir, "data/admin"), { recursive: true });
    writeFileSync(join(homeDir, "data/admin/opencode.jsonc"), content);
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
