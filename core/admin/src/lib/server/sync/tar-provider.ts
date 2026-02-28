/**
 * Tar sync provider — local archive-based config snapshots.
 *
 * Each snapshot creates a timestamped tar.gz of CONFIG_HOME (excluding
 * secrets.env). Snapshots are stored locally alongside CONFIG_HOME.
 * On push(), the latest snapshot is copied to a configurable output
 * directory (defaults to DATA_HOME/snapshots/config).
 *
 * This provider is fully local — pull() is a no-op and setRemote()
 * configures the snapshot output directory instead of a remote URL.
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
  rmSync,
  statSync
} from "node:fs";
import { resolve as resolvePath, basename } from "node:path";
import type {
  ConfigSyncProvider,
  SyncResult,
  SnapshotResult,
  HistoryResult,
  SyncSnapshot,
  SyncStatus
} from "./types.js";

/**
 * Tar provider state is stored in CONFIG_HOME/.tar-sync/:
 *   snapshots/        — timestamped tar.gz archives
 *   manifest.json     — ordered list of snapshot metadata
 */

type TarManifestEntry = {
  id: string;
  filename: string;
  message: string;
  timestamp: string;
};

type TarManifest = {
  snapshots: TarManifestEntry[];
  lastPush?: string;
};

/** Resolve the internal snapshot store directory. */
function snapshotStoreDir(configDir: string): string {
  return `${configDir}/.tar-sync/snapshots`;
}

/** Resolve the manifest path. */
function manifestPath(configDir: string): string {
  return `${configDir}/.tar-sync/manifest.json`;
}

/** Read the manifest, returning an empty one if missing/corrupt. */
function readManifest(configDir: string): TarManifest {
  const path = manifestPath(configDir);
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      return {
        snapshots: Array.isArray(raw.snapshots) ? raw.snapshots : [],
        lastPush: typeof raw.lastPush === "string" ? raw.lastPush : undefined
      };
    }
  } catch {
    // Corrupt — start fresh
  }
  return { snapshots: [] };
}

/** Persist the manifest. */
function writeManifest(configDir: string, manifest: TarManifest): void {
  const dir = `${configDir}/.tar-sync`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath(configDir), JSON.stringify(manifest, null, 2) + "\n");
}

/** Generate a snapshot ID from current timestamp. */
function generateId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Resolve the push target directory. Priority:
 * 1. Explicit snapshotDir from sync.json
 * 2. DATA_HOME/snapshots/config (default)
 */
function resolvePushDir(configDir: string): string {
  // Read sync.json to check for snapshotDir override
  const syncConfigPath = `${configDir}/sync.json`;
  try {
    if (existsSync(syncConfigPath)) {
      const raw = JSON.parse(readFileSync(syncConfigPath, "utf-8"));
      if (typeof raw.snapshotDir === "string" && raw.snapshotDir.trim()) {
        return resolvePath(raw.snapshotDir);
      }
    }
  } catch {
    // Fall through to default
  }

  // Default: DATA_HOME/snapshots/config
  const dataHome = process.env.OPENPALM_DATA_HOME
    ?? `${process.env.HOME ?? "/tmp"}/.local/share/openpalm`;
  return `${resolvePath(dataHome)}/snapshots/config`;
}

/** Check if the tar provider has been initialized for this configDir. */
function isInitialized(configDir: string): boolean {
  return existsSync(manifestPath(configDir));
}

type TarResult = { ok: boolean; stdout: string; stderr: string };

/** Create a tar.gz archive, excluding secrets.env and the .tar-sync dir. */
function createTarArchive(configDir: string, outputPath: string): Promise<TarResult> {
  return new Promise((resolve) => {
    execFile(
      "tar",
      [
        "czf", outputPath,
        "--exclude=secrets.env",
        "--exclude=.tar-sync",
        "--exclude=.git",
        "-C", configDir,
        "."
      ],
      { timeout: 60_000 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? ""
        });
      }
    );
  });
}

/** Extract a tar.gz archive into configDir, overwriting existing files. */
function extractTarArchive(archivePath: string, configDir: string): Promise<TarResult> {
  return new Promise((resolve) => {
    execFile(
      "tar",
      ["xzf", archivePath, "-C", configDir],
      { timeout: 60_000 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? ""
        });
      }
    );
  });
}

/** Check if configDir has changed since the last snapshot by comparing mtimes. */
function hasChanges(configDir: string): boolean {
  const manifest = readManifest(configDir);
  if (manifest.snapshots.length === 0) return true;

  const lastSnapshot = manifest.snapshots[manifest.snapshots.length - 1];
  const lastTime = new Date(lastSnapshot.timestamp).getTime();

  // Walk configDir (shallow) and check mtimes
  try {
    const entries = readdirSync(configDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".tar-sync" || entry.name === ".git" || entry.name === "secrets.env") continue;
      const st = statSync(`${configDir}/${entry.name}`);
      if (st.mtimeMs > lastTime) return true;
    }
  } catch {
    return true;
  }
  return false;
}

export const tarProvider: ConfigSyncProvider = {
  name: "tar",

  async init(configDir: string): Promise<SyncResult> {
    const storeDir = snapshotStoreDir(configDir);
    mkdirSync(storeDir, { recursive: true });

    if (!isInitialized(configDir)) {
      writeManifest(configDir, { snapshots: [] });
    }

    return { ok: true };
  },

  async snapshot(configDir: string, message: string): Promise<SnapshotResult> {
    if (!isInitialized(configDir)) {
      return { ok: false, error: "Not initialized — run init first" };
    }

    if (!hasChanges(configDir)) {
      return { ok: true };
    }

    const id = generateId();
    const filename = `config-${id}.tar.gz`;
    const storeDir = snapshotStoreDir(configDir);
    mkdirSync(storeDir, { recursive: true });
    const archivePath = `${storeDir}/${filename}`;

    const result = await createTarArchive(configDir, archivePath);
    if (!result.ok) {
      return { ok: false, error: `tar create failed: ${result.stderr}` };
    }

    const manifest = readManifest(configDir);
    manifest.snapshots.push({
      id,
      filename,
      message,
      timestamp: new Date().toISOString()
    });
    writeManifest(configDir, manifest);

    return { ok: true, id };
  },

  async push(configDir: string): Promise<SyncResult> {
    if (!isInitialized(configDir)) {
      return { ok: false, error: "Not initialized — run init first" };
    }

    const manifest = readManifest(configDir);
    if (manifest.snapshots.length === 0) {
      return { ok: false, error: "No snapshots to push" };
    }

    const latest = manifest.snapshots[manifest.snapshots.length - 1];
    const sourcePath = `${snapshotStoreDir(configDir)}/${latest.filename}`;
    if (!existsSync(sourcePath)) {
      return { ok: false, error: `Snapshot archive not found: ${latest.filename}` };
    }

    const pushDir = resolvePushDir(configDir);
    mkdirSync(pushDir, { recursive: true });
    const destPath = `${pushDir}/${latest.filename}`;

    try {
      copyFileSync(sourcePath, destPath);
    } catch (err) {
      return { ok: false, error: `Failed to copy snapshot: ${err instanceof Error ? err.message : String(err)}` };
    }

    manifest.lastPush = new Date().toISOString();
    writeManifest(configDir, manifest);

    return { ok: true };
  },

  async pull(_configDir: string): Promise<SyncResult> {
    // Tar provider is local-only — pull is a no-op
    return { ok: true };
  },

  async history(configDir: string, limit = 20): Promise<HistoryResult> {
    if (!isInitialized(configDir)) {
      return { ok: false, snapshots: [], error: "Not initialized — run init first" };
    }

    const manifest = readManifest(configDir);
    const snapshots: SyncSnapshot[] = manifest.snapshots
      .slice(-limit)
      .reverse()
      .map((entry) => ({
        id: entry.id,
        message: entry.message,
        timestamp: entry.timestamp
      }));

    return { ok: true, snapshots };
  },

  async restore(configDir: string, snapshotId: string): Promise<SyncResult> {
    if (!isInitialized(configDir)) {
      return { ok: false, error: "Not initialized — run init first" };
    }

    const manifest = readManifest(configDir);
    const entry = manifest.snapshots.find((s) => s.id === snapshotId);
    if (!entry) {
      return { ok: false, error: `Snapshot not found: ${snapshotId}` };
    }

    const archivePath = `${snapshotStoreDir(configDir)}/${entry.filename}`;
    if (!existsSync(archivePath)) {
      return { ok: false, error: `Snapshot archive not found: ${entry.filename}` };
    }

    // Remove existing config files (except secrets.env, .tar-sync, .git)
    const entries = readdirSync(configDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "secrets.env" || e.name === ".tar-sync" || e.name === ".git" || e.name === "sync.json") continue;
      rmSync(`${configDir}/${e.name}`, { recursive: true, force: true });
    }

    // Extract the snapshot archive
    const result = await extractTarArchive(archivePath, configDir);
    if (!result.ok) {
      return { ok: false, error: `Restore failed: ${result.stderr}` };
    }

    return { ok: true };
  },

  async status(configDir: string): Promise<SyncStatus> {
    const initialized = isInitialized(configDir);
    if (!initialized) {
      return {
        initialized: false,
        provider: "tar",
        remote: "",
        lastSync: "",
        dirty: false
      };
    }

    const manifest = readManifest(configDir);
    const pushDir = resolvePushDir(configDir);
    const dirty = hasChanges(configDir);

    return {
      initialized: true,
      provider: "tar",
      remote: pushDir,
      lastSync: manifest.lastPush ?? "",
      dirty
    };
  },

  async setRemote(configDir: string, remote: string): Promise<SyncResult> {
    // For tar provider, "remote" is the snapshot output directory.
    // Validate it's an absolute path.
    const resolved = resolvePath(remote);

    // Persist to sync.json as snapshotDir
    const syncConfigPath = `${configDir}/sync.json`;
    let config: Record<string, unknown> = {};
    try {
      if (existsSync(syncConfigPath)) {
        config = JSON.parse(readFileSync(syncConfigPath, "utf-8"));
      }
    } catch {
      // Start fresh
    }
    config.snapshotDir = resolved;
    writeFileSync(syncConfigPath, JSON.stringify(config, null, 2) + "\n");

    return { ok: true };
  }
};
