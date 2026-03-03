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
      return new Response("Not found", { status: 404 });
    });

    const result = await refreshCoreAssets();
    expect(result.updated).toContain("docker-compose.yml");
    expect(result.updated).toContain("caddy/Caddyfile");
    expect(result.backupDir).toBeNull(); // no existing files to back up

    expect(existsSync(join(dataHome, "docker-compose.yml"))).toBe(true);
    expect(existsSync(join(dataHome, "caddy/Caddyfile"))).toBe(true);
  });

  test("backs up changed files before overwriting", async () => {
    const dataHome = process.env.OPENPALM_DATA_HOME!;
    mkdirSync(dataHome, { recursive: true });
    writeFileSync(join(dataHome, "docker-compose.yml"), "old-compose-content");
    mkdirSync(join(dataHome, "caddy"), { recursive: true });
    writeFileSync(join(dataHome, "caddy/Caddyfile"), "old-caddy-content");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("docker-compose.yml")) {
        return new Response("new-compose-content", { status: 200 });
      }
      if (url.includes("Caddyfile")) {
        return new Response("new-caddy-content", { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await refreshCoreAssets();
    expect(result.updated).toHaveLength(2);
    expect(result.backupDir).not.toBeNull();

    // Verify backup contains old content
    const backupCompose = readFileSync(join(result.backupDir!, "docker-compose.yml"), "utf-8");
    expect(backupCompose).toBe("old-compose-content");
    const backupCaddy = readFileSync(join(result.backupDir!, "caddy/Caddyfile"), "utf-8");
    expect(backupCaddy).toBe("old-caddy-content");

    // Verify new content written
    expect(readFileSync(join(dataHome, "docker-compose.yml"), "utf-8")).toBe("new-compose-content");
    expect(readFileSync(join(dataHome, "caddy/Caddyfile"), "utf-8")).toBe("new-caddy-content");
  });

  test("skips assets with identical content", async () => {
    const dataHome = process.env.OPENPALM_DATA_HOME!;
    const content = "same-content";
    mkdirSync(dataHome, { recursive: true });
    writeFileSync(join(dataHome, "docker-compose.yml"), content);
    mkdirSync(join(dataHome, "caddy"), { recursive: true });
    writeFileSync(join(dataHome, "caddy/Caddyfile"), content);

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
