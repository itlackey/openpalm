/**
 * Tests for staging rollback and failure recovery improvements.
 *
 * Verifies that:
 * 1. Atomic directory swap (.pending → live) prevents partial state
 * 2. Config-protect backup/rollback works for channel install and uninstall
 * 3. Stale .pending and config-backup directories are cleaned on startup
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Import functions under test ────────────────────────────────────────
import {
  cleanupStalePending,
  backupChannelConfig,
  rollbackChannelConfig,
  clearChannelConfigBackup,
  cleanupStaleConfigBackups
} from "./control-plane.js";

// ── Test helpers ───────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-rollback-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a minimal CONFIG_HOME with channel files.
 */
function seedConfigDir(configDir: string): void {
  const channelsDir = join(configDir, "channels");
  mkdirSync(channelsDir, { recursive: true });
  writeFileSync(join(channelsDir, "chat.yml"), "services:\n  channel-chat:\n    image: chat:v1\n");
  writeFileSync(join(channelsDir, "chat.caddy"), "handle_path /chat/* {\n}\n");
}

// ── Minimal ControlPlaneState mock for cleanupStaleConfigBackups ──────

function mockState(stateDir: string, configDir: string) {
  return {
    stateDir,
    configDir,
    dataDir: "",
    adminToken: "test",
    postgresPassword: "test",
    channelSecrets: {} as Record<string, string>,
    services: {} as Record<string, string>,
    installedExtensions: new Set<string>(),
    artifacts: { compose: "", caddyfile: "" },
    artifactMeta: [],
    audit: [] as Array<{
      at: string;
      requestId: string;
      actor: string;
      callerType: string;
      action: string;
      args: Record<string, unknown>;
      ok: boolean;
    }>
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

let stateDir: string;
let configDir: string;

beforeEach(() => {
  stateDir = makeTempDir();
  configDir = makeTempDir();
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

// ── Atomic Directory Swap ──────────────────────────────────────────────

describe("Atomic Directory Swap (cleanupStalePending)", () => {
  test("cleanupStalePending removes .pending directories", () => {
    const pendingArtifacts = join(stateDir, "artifacts.pending");
    const pendingChannels = join(stateDir, "channels.pending");
    const pendingCaddyfile = join(stateDir, "Caddyfile.pending");

    mkdirSync(pendingArtifacts, { recursive: true });
    mkdirSync(pendingChannels, { recursive: true });
    writeFileSync(pendingCaddyfile, "stale");
    writeFileSync(join(pendingArtifacts, "docker-compose.yml"), "stale");

    cleanupStalePending(stateDir);

    expect(existsSync(pendingArtifacts)).toBe(false);
    expect(existsSync(pendingChannels)).toBe(false);
    expect(existsSync(pendingCaddyfile)).toBe(false);
  });

  test("cleanupStalePending removes .old directories", () => {
    const oldArtifacts = join(stateDir, "artifacts.old");
    const oldChannels = join(stateDir, "channels.old");
    const oldCaddyfile = join(stateDir, "Caddyfile.old");

    mkdirSync(oldArtifacts, { recursive: true });
    mkdirSync(oldChannels, { recursive: true });
    writeFileSync(oldCaddyfile, "old");

    cleanupStalePending(stateDir);

    expect(existsSync(oldArtifacts)).toBe(false);
    expect(existsSync(oldChannels)).toBe(false);
    expect(existsSync(oldCaddyfile)).toBe(false);
  });

  test("cleanupStalePending is safe when no stale state exists", () => {
    cleanupStalePending(stateDir);
    expect(existsSync(stateDir)).toBe(true);
  });
});

// ── Config-Protect (Channel Backup/Rollback) ──────────────────────────

describe("Config-Protect: Channel Install", () => {
  test("backupChannelConfig for install records intent", () => {
    backupChannelConfig("install", "chat", configDir, stateDir);

    const intentPath = join(stateDir, "config-backups", "chat", "intent.json");
    expect(existsSync(intentPath)).toBe(true);

    const intent = JSON.parse(readFileSync(intentPath, "utf-8"));
    expect(intent.action).toBe("install");
    expect(intent.channel).toBe("chat");
  });

  test("rollbackChannelConfig for install removes newly created files", () => {
    seedConfigDir(configDir);

    backupChannelConfig("install", "chat", configDir, stateDir);

    rollbackChannelConfig("chat", configDir, stateDir);

    expect(existsSync(join(configDir, "channels", "chat.yml"))).toBe(false);
    expect(existsSync(join(configDir, "channels", "chat.caddy"))).toBe(false);
  });

  test("clearChannelConfigBackup removes backup after success", () => {
    backupChannelConfig("install", "chat", configDir, stateDir);

    clearChannelConfigBackup("chat", stateDir);

    expect(existsSync(join(stateDir, "config-backups", "chat"))).toBe(false);
  });
});

describe("Config-Protect: Channel Uninstall", () => {
  test("backupChannelConfig for uninstall copies channel files", () => {
    seedConfigDir(configDir);

    backupChannelConfig("uninstall", "chat", configDir, stateDir);

    const backupDir = join(stateDir, "config-backups", "chat");
    expect(existsSync(join(backupDir, "intent.json"))).toBe(true);
    expect(existsSync(join(backupDir, "chat.yml"))).toBe(true);
    expect(existsSync(join(backupDir, "chat.caddy"))).toBe(true);

    const intent = JSON.parse(readFileSync(join(backupDir, "intent.json"), "utf-8"));
    expect(intent.action).toBe("uninstall");
  });

  test("rollbackChannelConfig for uninstall restores deleted files", () => {
    seedConfigDir(configDir);

    backupChannelConfig("uninstall", "chat", configDir, stateDir);

    // Simulate uninstall — delete the files
    rmSync(join(configDir, "channels", "chat.yml"), { force: true });
    rmSync(join(configDir, "channels", "chat.caddy"), { force: true });
    expect(existsSync(join(configDir, "channels", "chat.yml"))).toBe(false);

    // Rollback should restore them
    rollbackChannelConfig("chat", configDir, stateDir);

    expect(existsSync(join(configDir, "channels", "chat.yml"))).toBe(true);
    expect(existsSync(join(configDir, "channels", "chat.caddy"))).toBe(true);
    expect(readFileSync(join(configDir, "channels", "chat.yml"), "utf-8")).toContain("channel-chat");
  });

  test("rollbackChannelConfig is a no-op if no backup exists", () => {
    rollbackChannelConfig("nonexistent", configDir, stateDir);
    expect(existsSync(join(stateDir, "config-backups", "nonexistent"))).toBe(false);
  });
});

describe("Config-Protect: Startup cleanup", () => {
  test("cleanupStaleConfigBackups clears stale backup and logs audit entry", () => {
    seedConfigDir(configDir);
    const state = mockState(stateDir, configDir) as any;

    backupChannelConfig("uninstall", "chat", configDir, stateDir);

    // Stale backup exists
    expect(existsSync(join(stateDir, "config-backups", "chat", "intent.json"))).toBe(true);

    // Startup cleanup should clear the backup and log, NOT rollback
    cleanupStaleConfigBackups(stateDir, configDir, state);

    // Backup should be gone
    expect(existsSync(join(stateDir, "config-backups", "chat"))).toBe(false);

    // Audit entry logged
    expect(state.audit.length).toBe(1);
    expect(state.audit[0].action).toBe("startup.stale_backup");
  });

  test("cleanupStaleConfigBackups is safe when no backups exist", () => {
    const state = mockState(stateDir, configDir) as any;
    cleanupStaleConfigBackups(stateDir, configDir, state);
    expect(state.audit.length).toBe(0);
  });
});
