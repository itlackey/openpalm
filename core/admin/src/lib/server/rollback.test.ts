/**
 * Tests for staging rollback and failure recovery improvements.
 *
 * Verifies that:
 * 1. Snapshots are created before apply and can be used to restore state
 * 2. Atomic directory swap (.pending → live) prevents partial state
 * 3. Config-protect backup/rollback works for channel install and uninstall
 * 4. Stale .pending and config-backup directories are cleaned on startup
 * 5. Snapshot pruning keeps only the most recent N snapshots
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  readdirSync,
  cpSync,
  renameSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Import functions under test ────────────────────────────────────────
import {
  snapshotCurrentState,
  restoreSnapshot,
  pruneSnapshots,
  latestSnapshot,
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
 * Create a minimal STATE_HOME with artifacts and channels for snapshot tests.
 */
function seedStateDir(stateDir: string): void {
  const artifactDir = join(stateDir, "artifacts");
  const channelsDir = join(stateDir, "channels");
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(join(channelsDir, "public"), { recursive: true });
  mkdirSync(join(channelsDir, "lan"), { recursive: true });

  writeFileSync(join(artifactDir, "docker-compose.yml"), "services:\n  admin:\n    image: admin:v1\n");
  writeFileSync(join(artifactDir, "stack.env"), "OPENPALM_UID=1000\n");
  writeFileSync(join(artifactDir, "secrets.env"), "ADMIN_TOKEN=test\n");
  writeFileSync(
    join(artifactDir, "manifest.json"),
    JSON.stringify([{ name: "compose", sha256: "abc123", generatedAt: "2026-01-01", bytes: 42 }])
  );
  writeFileSync(join(stateDir, "Caddyfile"), "# Caddyfile v1\n");
  writeFileSync(join(channelsDir, "chat.yml"), "services:\n  channel-chat:\n    image: chat:v1\n");
  writeFileSync(join(channelsDir, "lan", "chat.caddy"), "handle_path /chat/* {\n}\n");
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

// ── Snapshot-Before-Write ──────────────────────────────────────────────

describe("Snapshot-Before-Write", () => {
  test("snapshotCurrentState creates a snapshot of artifacts and channels", () => {
    seedStateDir(stateDir);

    const snapshotDir = snapshotCurrentState(stateDir);

    expect(snapshotDir).not.toBeNull();
    expect(existsSync(join(snapshotDir!, "artifacts", "docker-compose.yml"))).toBe(true);
    expect(existsSync(join(snapshotDir!, "artifacts", "manifest.json"))).toBe(true);
    expect(existsSync(join(snapshotDir!, "channels", "chat.yml"))).toBe(true);
    expect(existsSync(join(snapshotDir!, "Caddyfile"))).toBe(true);
  });

  test("snapshotCurrentState returns null on first-ever apply (no manifest)", () => {
    // Empty stateDir — no artifacts yet
    const result = snapshotCurrentState(stateDir);
    expect(result).toBeNull();
  });

  test("restoreSnapshot overwrites current state from snapshot", () => {
    seedStateDir(stateDir);
    const snapshotDir = snapshotCurrentState(stateDir)!;

    // Corrupt the live state
    writeFileSync(join(stateDir, "artifacts", "docker-compose.yml"), "CORRUPTED");
    writeFileSync(join(stateDir, "Caddyfile"), "CORRUPTED");
    rmSync(join(stateDir, "channels", "chat.yml"), { force: true });

    // Restore from snapshot
    restoreSnapshot(stateDir, snapshotDir);

    // Verify restored
    expect(readFileSync(join(stateDir, "artifacts", "docker-compose.yml"), "utf-8")).toContain("admin:v1");
    expect(readFileSync(join(stateDir, "Caddyfile"), "utf-8")).toBe("# Caddyfile v1\n");
    expect(existsSync(join(stateDir, "channels", "chat.yml"))).toBe(true);
  });

  test("latestSnapshot returns the most recent snapshot", () => {
    seedStateDir(stateDir);

    // Create two snapshots with different timestamps
    const snap1 = snapshotCurrentState(stateDir)!;
    // Small delay not needed — timestamps include ms

    // Modify state slightly to get a different timestamp
    writeFileSync(join(stateDir, "artifacts", "docker-compose.yml"), "services:\n  admin:\n    image: admin:v2\n");
    const snap2 = snapshotCurrentState(stateDir)!;

    const latest = latestSnapshot(stateDir);
    expect(latest).toBe(snap2);
    expect(latest).not.toBe(snap1);
  });

  test("latestSnapshot returns null when no snapshots exist", () => {
    expect(latestSnapshot(stateDir)).toBeNull();
  });
});

describe("Snapshot pruning", () => {
  test("pruneSnapshots keeps only MAX_SNAPSHOTS (3) most recent", () => {
    seedStateDir(stateDir);

    // Create 5 snapshots
    const snapshotNames: string[] = [];
    for (let i = 0; i < 5; i++) {
      // Create unique timestamps by modifying a file
      writeFileSync(
        join(stateDir, "artifacts", "docker-compose.yml"),
        `services:\n  admin:\n    image: admin:v${i}\n`
      );
      const snap = snapshotCurrentState(stateDir)!;
      snapshotNames.push(snap);
    }

    // pruneSnapshots is called automatically by snapshotCurrentState,
    // so only the latest 3 should remain
    const snapshotsDir = join(stateDir, "snapshots");
    const remaining = readdirSync(snapshotsDir);
    expect(remaining.length).toBeLessThanOrEqual(3);
  });
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
    // Should not throw
    cleanupStalePending(stateDir);
    // Verify stateDir still exists and is intact
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

    // Record intent
    backupChannelConfig("install", "chat", configDir, stateDir);

    // Rollback should remove the installed files
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

    // Backup before uninstall
    backupChannelConfig("uninstall", "chat", configDir, stateDir);

    // Simulate uninstall — delete the files
    rmSync(join(configDir, "channels", "chat.yml"), { force: true });
    rmSync(join(configDir, "channels", "chat.caddy"), { force: true });
    expect(existsSync(join(configDir, "channels", "chat.yml"))).toBe(false);

    // Rollback should restore them
    rollbackChannelConfig("chat", configDir, stateDir);

    expect(existsSync(join(configDir, "channels", "chat.yml"))).toBe(true);
    expect(existsSync(join(configDir, "channels", "chat.caddy"))).toBe(true);

    // File content should match original
    expect(readFileSync(join(configDir, "channels", "chat.yml"), "utf-8")).toContain("channel-chat");
  });

  test("rollbackChannelConfig is a no-op if no backup exists", () => {
    // Should not throw and should not create any files
    rollbackChannelConfig("nonexistent", configDir, stateDir);
    expect(existsSync(join(stateDir, "config-backups", "nonexistent"))).toBe(false);
  });
});

describe("Config-Protect: Startup cleanup", () => {
  test("cleanupStaleConfigBackups detects and rolls back stale uninstall", () => {
    seedConfigDir(configDir);
    const state = mockState(stateDir, configDir) as any;

    // Create a stale backup for an uninstall that didn't complete
    backupChannelConfig("uninstall", "chat", configDir, stateDir);

    // Simulate the files being deleted (incomplete uninstall)
    rmSync(join(configDir, "channels", "chat.yml"), { force: true });
    rmSync(join(configDir, "channels", "chat.caddy"), { force: true });

    // Startup cleanup should restore them
    cleanupStaleConfigBackups(stateDir, configDir, state);

    expect(existsSync(join(configDir, "channels", "chat.yml"))).toBe(true);
    expect(existsSync(join(configDir, "channels", "chat.caddy"))).toBe(true);

    // Should log an audit entry
    expect(state.audit.length).toBe(1);
    expect(state.audit[0].action).toBe("startup.stale_backup");
  });

  test("cleanupStaleConfigBackups is safe when no backups exist", () => {
    const state = mockState(stateDir, configDir) as any;
    // Should not throw and should produce no audit entries
    cleanupStaleConfigBackups(stateDir, configDir, state);
    expect(state.audit.length).toBe(0);
  });
});
