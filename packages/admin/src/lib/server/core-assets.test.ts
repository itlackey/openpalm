/**
 * Tests for core-assets.ts — DATA_HOME source-of-truth files:
 * Caddyfile, compose, and access scope management.
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
  ensureCoreCaddyfile,
  readCoreCaddyfile,
  detectAccessScope,
  setCoreCaddyAccessScope,
  ensureCoreCompose,
  readCoreCompose,
  ensureOllamaCompose,
  readOllamaCompose,
  ensureOpenCodeSystemConfig,
  refreshCoreAssets
} from "./core-assets.js";
import { makeTempDir, trackDir, registerCleanup } from "./test-helpers.js";

registerCleanup();

// ── Access Scope Detection ──────────────────────────────────────────────

describe("detectAccessScope", () => {
  test("detects host-only scope", () => {
    const caddyfile = `
:8080 {
  @denied not remote_ip 127.0.0.0/8 ::1
  respond @denied 403
}`;
    expect(detectAccessScope(caddyfile)).toBe("host");
  });

  test("detects LAN scope", () => {
    const caddyfile = `
:8080 {
  @denied not remote_ip 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8 ::1 fc00::/7 fe80::/10
  respond @denied 403
}`;
    expect(detectAccessScope(caddyfile)).toBe("lan");
  });

  test("returns custom for unknown IP ranges", () => {
    const caddyfile = `
:8080 {
  @denied not remote_ip 192.168.1.0/24
  respond @denied 403
}`;
    expect(detectAccessScope(caddyfile)).toBe("custom");
  });

  test("returns custom when @denied line is missing", () => {
    const caddyfile = `:8080 {\n  respond "OK"\n}`;
    expect(detectAccessScope(caddyfile)).toBe("custom");
  });
});

// ── Access Scope Management (Filesystem) ────────────────────────────────

describe("ensureCoreCaddyfile / setCoreCaddyAccessScope", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OPENPALM_DATA_HOME = process.env.OPENPALM_DATA_HOME;
    process.env.OPENPALM_DATA_HOME = trackDir(makeTempDir());
  });

  afterEach(() => {
    process.env.OPENPALM_DATA_HOME = origEnv.OPENPALM_DATA_HOME;
  });

  test("ensureCoreCaddyfile creates Caddyfile if missing", () => {
    const path = ensureCoreCaddyfile();
    expect(existsSync(path)).toBe(true);
    expect(path).toContain("caddy/Caddyfile");
  });

  test("ensureCoreCaddyfile is idempotent", () => {
    const path1 = ensureCoreCaddyfile();
    const content1 = readFileSync(path1, "utf-8");
    const path2 = ensureCoreCaddyfile();
    const content2 = readFileSync(path2, "utf-8");
    expect(content1).toBe(content2);
  });

  test("setCoreCaddyAccessScope returns error if @denied line missing", () => {
    const dataHome = process.env.OPENPALM_DATA_HOME!;
    const caddyDir = join(dataHome, "caddy");
    mkdirSync(caddyDir, { recursive: true });
    writeFileSync(join(caddyDir, "Caddyfile"), ":8080 {\n  respond 200\n}");

    const result = setCoreCaddyAccessScope("host");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("@denied not remote_ip");
  });

  test("setCoreCaddyAccessScope sets host scope", () => {
    // Seed a Caddyfile with the default asset (which has @denied line)
    ensureCoreCaddyfile();

    const result = setCoreCaddyAccessScope("host");
    expect(result.ok).toBe(true);

    const content = readCoreCaddyfile();
    expect(detectAccessScope(content)).toBe("host");
    expect(content).toContain("127.0.0.0/8 ::1");
    // Should NOT contain LAN-specific ranges
    expect(content).not.toContain("10.0.0.0/8");
  });

  test("setCoreCaddyAccessScope sets lan scope", () => {
    ensureCoreCaddyfile();

    const result = setCoreCaddyAccessScope("lan");
    expect(result.ok).toBe(true);

    const content = readCoreCaddyfile();
    expect(detectAccessScope(content)).toBe("lan");
    expect(content).toContain("10.0.0.0/8");
    expect(content).toContain("172.16.0.0/12");
    expect(content).toContain("192.168.0.0/16");
  });

  test("setCoreCaddyAccessScope round-trip: host then lan", () => {
    ensureCoreCaddyfile();

    setCoreCaddyAccessScope("host");
    expect(detectAccessScope(readCoreCaddyfile())).toBe("host");

    setCoreCaddyAccessScope("lan");
    expect(detectAccessScope(readCoreCaddyfile())).toBe("lan");

    setCoreCaddyAccessScope("host");
    expect(detectAccessScope(readCoreCaddyfile())).toBe("host");
  });
});

// ── Core Compose (DATA_HOME source of truth) ────────────────────────────

describe("ensureCoreCompose / readCoreCompose", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OPENPALM_DATA_HOME = process.env.OPENPALM_DATA_HOME;
    process.env.OPENPALM_DATA_HOME = trackDir(makeTempDir());
  });

  afterEach(() => {
    process.env.OPENPALM_DATA_HOME = origEnv.OPENPALM_DATA_HOME;
  });

  test("ensureCoreCompose creates docker-compose.yml if missing", () => {
    const path = ensureCoreCompose();
    expect(existsSync(path)).toBe(true);
    expect(path).toContain("docker-compose.yml");
  });

  test("ensureCoreCompose is idempotent", () => {
    const path1 = ensureCoreCompose();
    const content1 = readFileSync(path1, "utf-8");
    const path2 = ensureCoreCompose();
    const content2 = readFileSync(path2, "utf-8");
    expect(content1).toBe(content2);
  });

  test("ensureCoreCompose overwrites stale file and creates backup", () => {
    const dataHome = process.env.OPENPALM_DATA_HOME!;
    mkdirSync(dataHome, { recursive: true });
    const staleContent = "# stale compose\nservices: {}";
    writeFileSync(join(dataHome, "docker-compose.yml"), staleContent);

    const path = ensureCoreCompose();
    const content = readFileSync(path, "utf-8");
    expect(content).not.toBe(staleContent);
    expect(content).toContain("services:");

    // Verify backup was created
    const backupDir = join(dataHome, "backups");
    expect(existsSync(backupDir)).toBe(true);
    const backups = readdirSync(backupDir).filter(f => f.startsWith("docker-compose."));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(backupDir, backups[0]), "utf-8")).toBe(staleContent);
  });

  test("readCoreCompose returns file content", () => {
    const content = readCoreCompose();
    expect(content).toBeTruthy();
    expect(typeof content).toBe("string");
    expect(content).toContain("HOME: /app/data");
    expect(content).toContain("HOME: ${OPENPALM_DATA_HOME:-${HOME}/.local/share/openpalm}/admin");
  });
});

// ── Ollama Compose Overlay (DATA_HOME source of truth) ──────────────────

describe("ensureOllamaCompose / readOllamaCompose", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OPENPALM_DATA_HOME = process.env.OPENPALM_DATA_HOME;
    process.env.OPENPALM_DATA_HOME = trackDir(makeTempDir());
  });

  afterEach(() => {
    process.env.OPENPALM_DATA_HOME = origEnv.OPENPALM_DATA_HOME;
  });

  test("ensureOllamaCompose creates ollama.yml if missing", () => {
    const path = ensureOllamaCompose();
    expect(existsSync(path)).toBe(true);
    expect(path).toContain("ollama.yml");
  });

  test("ensureOllamaCompose is idempotent", () => {
    const path1 = ensureOllamaCompose();
    const content1 = readFileSync(path1, "utf-8");
    const path2 = ensureOllamaCompose();
    const content2 = readFileSync(path2, "utf-8");
    expect(content1).toBe(content2);
  });

  test("ensureOllamaCompose overwrites stale file and creates backup", () => {
    const dataHome = process.env.OPENPALM_DATA_HOME!;
    mkdirSync(dataHome, { recursive: true });
    const staleContent = "# stale ollama compose\nservices: {}";
    writeFileSync(join(dataHome, "ollama.yml"), staleContent);

    const path = ensureOllamaCompose();
    const content = readFileSync(path, "utf-8");
    expect(content).not.toBe(staleContent);

    // Verify backup was created
    const backupDir = join(dataHome, "backups");
    expect(existsSync(backupDir)).toBe(true);
    const backups = readdirSync(backupDir).filter(f => f.startsWith("ollama."));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(backupDir, backups[0]), "utf-8")).toBe(staleContent);
  });

  test("readOllamaCompose returns file content", () => {
    const content = readOllamaCompose();
    expect(content).toBeTruthy();
    expect(typeof content).toBe("string");
  });
});

// ── ensureOpenCodeSystemConfig ────────────────────────────────────────────

describe("ensureOpenCodeSystemConfig", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OPENPALM_DATA_HOME = process.env.OPENPALM_DATA_HOME;
    process.env.OPENPALM_DATA_HOME = trackDir(makeTempDir());
  });

  afterEach(() => {
    process.env.OPENPALM_DATA_HOME = origEnv.OPENPALM_DATA_HOME;
  });

  test("seeds opencode.jsonc and AGENTS.md on first run", () => {
    const dataHome = process.env.OPENPALM_DATA_HOME!;
    ensureOpenCodeSystemConfig();

    const configPath = join(dataHome, "assistant", "opencode.jsonc");
    const agentsPath = join(dataHome, "assistant", "AGENTS.md");
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(agentsPath)).toBe(true);

    const configContent = readFileSync(configPath, "utf-8");
    expect(configContent).toContain("$schema");
    const agentsContent = readFileSync(agentsPath, "utf-8");
    expect(agentsContent.length).toBeGreaterThan(0);
  });

  test("is idempotent — skips unchanged files", () => {
    ensureOpenCodeSystemConfig();
    const dataHome = process.env.OPENPALM_DATA_HOME!;
    const configPath = join(dataHome, "assistant", "opencode.jsonc");
    const content1 = readFileSync(configPath, "utf-8");

    ensureOpenCodeSystemConfig();
    const content2 = readFileSync(configPath, "utf-8");
    expect(content1).toBe(content2);

    // No backups should exist since content didn't change
    const backupDir = join(dataHome, "assistant", "backups");
    expect(existsSync(backupDir)).toBe(false);
  });

  test("overwrites stale files and creates backups", () => {
    const dataHome = process.env.OPENPALM_DATA_HOME!;
    const assistantDir = join(dataHome, "assistant");
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
    origEnv.OPENPALM_DATA_HOME = process.env.OPENPALM_DATA_HOME;
    process.env.OPENPALM_DATA_HOME = trackDir(makeTempDir());
  });

  afterEach(() => {
    process.env.OPENPALM_DATA_HOME = origEnv.OPENPALM_DATA_HOME;
    vi.restoreAllMocks();
  });

  test("downloads and writes new assets when none exist", async () => {
    const dataHome = process.env.OPENPALM_DATA_HOME!;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("docker-compose.yml")) {
        return new Response("services:\n  admin:\n    image: test\n", { status: 200 });
      }
      if (url.includes("Caddyfile")) {
        return new Response(":8080 {\n  respond 200\n}\n", { status: 200 });
      }
      if (url.includes("opencode.jsonc")) {
        return new Response('{"$schema":"https://opencode.ai/config.json"}\n', { status: 200 });
      }
      if (url.includes("AGENTS.md")) {
        return new Response("# OpenCode Agents\n", { status: 200 });
      }
      if (url.includes("ollama.yml")) {
        return new Response("services:\n  ollama:\n    image: ollama/ollama\n", { status: 200 });
      }
      if (url.includes("secrets.env.schema")) {
        return new Response("# @defaultSensitive=true\n", { status: 200 });
      }
      if (url.includes("stack.env.schema")) {
        return new Response("# @defaultSensitive=false\n", { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await refreshCoreAssets();
    expect(result.updated).toContain("docker-compose.yml");
    expect(result.updated).toContain("caddy/Caddyfile");
    expect(result.updated).toContain("assistant/opencode.jsonc");
    expect(result.updated).toContain("assistant/AGENTS.md");
    expect(result.updated).toContain("ollama.yml");
    expect(result.updated).toContain("secrets.env.schema");
    expect(result.updated).toContain("stack.env.schema");
    expect(result.backupDir).toBeNull(); // no existing files to back up

    expect(existsSync(join(dataHome, "docker-compose.yml"))).toBe(true);
    expect(existsSync(join(dataHome, "caddy/Caddyfile"))).toBe(true);
    expect(existsSync(join(dataHome, "assistant/opencode.jsonc"))).toBe(true);
    expect(existsSync(join(dataHome, "assistant/AGENTS.md"))).toBe(true);
    expect(existsSync(join(dataHome, "ollama.yml"))).toBe(true);
    expect(existsSync(join(dataHome, "secrets.env.schema"))).toBe(true);
    expect(existsSync(join(dataHome, "stack.env.schema"))).toBe(true);
  });

  test("backs up changed files before overwriting", async () => {
    const dataHome = process.env.OPENPALM_DATA_HOME!;
    mkdirSync(dataHome, { recursive: true });
    writeFileSync(join(dataHome, "docker-compose.yml"), "old-compose-content");
    mkdirSync(join(dataHome, "caddy"), { recursive: true });
    writeFileSync(join(dataHome, "caddy/Caddyfile"), "old-caddy-content");
    mkdirSync(join(dataHome, "assistant"), { recursive: true });
    writeFileSync(join(dataHome, "assistant/opencode.jsonc"), "old-opencode-content");
    writeFileSync(join(dataHome, "assistant/AGENTS.md"), "old-agents-content");
    writeFileSync(join(dataHome, "ollama.yml"), "old-ollama-content");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("docker-compose.yml")) {
        return new Response("new-compose-content", { status: 200 });
      }
      if (url.includes("Caddyfile")) {
        return new Response("new-caddy-content", { status: 200 });
      }
      if (url.includes("opencode.jsonc")) {
        return new Response("new-opencode-content", { status: 200 });
      }
      if (url.includes("AGENTS.md")) {
        return new Response("new-agents-content", { status: 200 });
      }
      if (url.includes("ollama.yml")) {
        return new Response("new-ollama-content", { status: 200 });
      }
      if (url.includes("secrets.env.schema")) {
        return new Response("new-secrets-schema-content", { status: 200 });
      }
      if (url.includes("stack.env.schema")) {
        return new Response("new-stack-schema-content", { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await refreshCoreAssets();
    expect(result.updated).toHaveLength(7);
    expect(result.backupDir).not.toBeNull();

    // Verify backup contains old content
    const backupCompose = readFileSync(join(result.backupDir!, "docker-compose.yml"), "utf-8");
    expect(backupCompose).toBe("old-compose-content");
    const backupCaddy = readFileSync(join(result.backupDir!, "caddy/Caddyfile"), "utf-8");
    expect(backupCaddy).toBe("old-caddy-content");
    const backupOpencode = readFileSync(join(result.backupDir!, "assistant/opencode.jsonc"), "utf-8");
    expect(backupOpencode).toBe("old-opencode-content");
    const backupAgents = readFileSync(join(result.backupDir!, "assistant/AGENTS.md"), "utf-8");
    expect(backupAgents).toBe("old-agents-content");
    const backupOllama = readFileSync(join(result.backupDir!, "ollama.yml"), "utf-8");
    expect(backupOllama).toBe("old-ollama-content");

    // Verify new content written
    expect(readFileSync(join(dataHome, "docker-compose.yml"), "utf-8")).toBe("new-compose-content");
    expect(readFileSync(join(dataHome, "caddy/Caddyfile"), "utf-8")).toBe("new-caddy-content");
    expect(readFileSync(join(dataHome, "assistant/opencode.jsonc"), "utf-8")).toBe("new-opencode-content");
    expect(readFileSync(join(dataHome, "assistant/AGENTS.md"), "utf-8")).toBe("new-agents-content");
    expect(readFileSync(join(dataHome, "ollama.yml"), "utf-8")).toBe("new-ollama-content");
  });

  test("skips assets with identical content", async () => {
    const dataHome = process.env.OPENPALM_DATA_HOME!;
    const content = "same-content";
    mkdirSync(dataHome, { recursive: true });
    writeFileSync(join(dataHome, "docker-compose.yml"), content);
    mkdirSync(join(dataHome, "caddy"), { recursive: true });
    writeFileSync(join(dataHome, "caddy/Caddyfile"), content);
    mkdirSync(join(dataHome, "memory"), { recursive: true });
    writeFileSync(join(dataHome, "memory/memory.py"), content);
    mkdirSync(join(dataHome, "assistant"), { recursive: true });
    writeFileSync(join(dataHome, "assistant/opencode.jsonc"), content);
    writeFileSync(join(dataHome, "assistant/AGENTS.md"), content);
    writeFileSync(join(dataHome, "ollama.yml"), content);
    writeFileSync(join(dataHome, "secrets.env.schema"), content);
    writeFileSync(join(dataHome, "stack.env.schema"), content);

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
