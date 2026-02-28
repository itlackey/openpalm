/**
 * Tar sync provider — local archive-based config snapshots.
 *
 * Each snapshot creates a timestamped tar.gz of CONFIG_HOME (excluding
 * secrets.env). Snapshots are treated as state and stored in
 * STATE_HOME/snapshots/config. On push(), the latest snapshot is copied
 * to the remoteUrl directory configured in config.json.
 *
 * This provider is fully local — pull() is a no-op.
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
import { resolve as resolvePath } from "node:path";
import type {
  ConfigSyncProvider,
  SyncResult,
  SnapshotResult,
  HistoryResult,
  SyncSnapshot,
  SyncStatus
} from "./types.js";

/**
 * Tar provider state lives in STATE_HOME/snapshots/config/:
 *   *.tar.gz          — timestamped archives
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

/** Resolve STATE_HOME using the same convention as control-plane.ts. */
function resolveStateHome(): string {
  const raw = process.env.OPENPALM_STATE_HOME;
  if (raw) return resolvePath(raw);
  return `${process.env.HOME ?? "/tmp"}/.local/state/openpalm`;
}

/** Resolve the snapshot store directory in STATE_HOME. */
function snapshotStoreDir(): string {
  return `${resolveStateHome()}/snapshots/config`;
}

/** Resolve the manifest path. */
function manifestPath(): string {
  return `${snapshotStoreDir()}/manifest.json`;
}

/** Read the manifest, returning an empty one if missing/corrupt. */
function readManifest(): TarManifest {
  const path = manifestPath();
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
function writeManifest(manifest: TarManifest): void {
  const dir = snapshotStoreDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2) + "\n");
}

/** Generate a snapshot ID from current timestamp. */
function generateId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Read remoteUrl from CONFIG_HOME/config.json → .sync.remoteUrl.
 * Returns empty string if not set.
 */
function readRemoteUrl(configDir: string): string {
  try {
    const path = `${configDir}/config.json`;
    if (existsSync(path)) {
      const root = JSON.parse(readFileSync(path, "utf-8"));
      const sync = root?.sync;
      if (sync && typeof sync.remoteUrl === "string") {
        return sync.remoteUrl;
      }
    }
  } catch {
    // Fall through
  }
  return "";
}

/** Check if the tar provider has been initialized. */
function isInitialized(): boolean {
  return existsSync(manifestPath());
}

type TarResult = { ok: boolean; stdout: string; stderr: string };

/** Create a tar.gz archive, excluding secrets.env and internal dirs. */
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
  const manifest = readManifest();
  if (manifest.snapshots.length === 0) return true;

  const lastSnapshot = manifest.snapshots[manifest.snapshots.length - 1];
  const lastTime = new Date(lastSnapshot.timestamp).getTime();

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

  async init(_configDir: string): Promise<SyncResult> {
    const storeDir = snapshotStoreDir();
    mkdirSync(storeDir, { recursive: true });

    if (!isInitialized()) {
      writeManifest({ snapshots: [] });
    }

    return { ok: true };
  },

  async snapshot(configDir: string, message: string): Promise<SnapshotResult> {
    if (!isInitialized()) {
      return { ok: false, error: "Not initialized — run init first" };
    }

    if (!hasChanges(configDir)) {
      return { ok: true };
    }

    const id = generateId();
    const filename = `config-${id}.tar.gz`;
    const storeDir = snapshotStoreDir();
    mkdirSync(storeDir, { recursive: true });
    const archivePath = `${storeDir}/${filename}`;

    const result = await createTarArchive(configDir, archivePath);
    if (!result.ok) {
      return { ok: false, error: `tar create failed: ${result.stderr}` };
    }

    const manifest = readManifest();
    manifest.snapshots.push({
      id,
      filename,
      message,
      timestamp: new Date().toISOString()
    });
    writeManifest(manifest);

    return { ok: true, id };
  },

  async push(configDir: string): Promise<SyncResult> {
    if (!isInitialized()) {
      return { ok: false, error: "Not initialized — run init first" };
    }

    const remoteUrl = readRemoteUrl(configDir);
    if (!remoteUrl) {
      return { ok: false, error: "No remote configured — set remoteUrl in config.json" };
    }

    const manifest = readManifest();
    if (manifest.snapshots.length === 0) {
      return { ok: false, error: "No snapshots to push" };
    }

    const latest = manifest.snapshots[manifest.snapshots.length - 1];
    const sourcePath = `${snapshotStoreDir()}/${latest.filename}`;
    if (!existsSync(sourcePath)) {
      return { ok: false, error: `Snapshot archive not found: ${latest.filename}` };
    }

    const destDir = resolvePath(remoteUrl);
    mkdirSync(destDir, { recursive: true });
    const destPath = `${destDir}/${latest.filename}`;

    try {
      copyFileSync(sourcePath, destPath);
    } catch (err) {
      return { ok: false, error: `Failed to copy snapshot: ${err instanceof Error ? err.message : String(err)}` };
    }

    manifest.lastPush = new Date().toISOString();
    writeManifest(manifest);

    return { ok: true };
  },

  async pull(_configDir: string): Promise<SyncResult> {
    // Tar provider is local-only — pull is a no-op
    return { ok: true };
  },

  async history(_configDir: string, limit = 20): Promise<HistoryResult> {
    if (!isInitialized()) {
      return { ok: false, snapshots: [], error: "Not initialized — run init first" };
    }

    const manifest = readManifest();
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
    if (!isInitialized()) {
      return { ok: false, error: "Not initialized — run init first" };
    }

    const manifest = readManifest();
    const entry = manifest.snapshots.find((s) => s.id === snapshotId);
    if (!entry) {
      return { ok: false, error: `Snapshot not found: ${snapshotId}` };
    }

    const archivePath = `${snapshotStoreDir()}/${entry.filename}`;
    if (!existsSync(archivePath)) {
      return { ok: false, error: `Snapshot archive not found: ${entry.filename}` };
    }

    // Remove existing config files (except secrets.env, config.json, .git)
    const entries = readdirSync(configDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "secrets.env" || e.name === "config.json" || e.name === ".git") continue;
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
    const initialized = isInitialized();
    if (!initialized) {
      return {
        initialized: false,
        provider: "tar",
        remote: "",
        lastSync: "",
        dirty: false
      };
    }

    const manifest = readManifest();
    const remoteUrl = readRemoteUrl(configDir);
    const dirty = hasChanges(configDir);

    return {
      initialized: true,
      provider: "tar",
      remote: remoteUrl,
      lastSync: manifest.lastPush ?? "",
      dirty
    };
  },

  async setRemote(configDir: string, remote: string): Promise<SyncResult> {
    // For tar provider, "remote" is the directory path to copy snapshots to.
    const resolved = resolvePath(remote);

    // Write to config.json → .sync.remoteUrl
    const configPath = `${configDir}/config.json`;
    let root: Record<string, unknown> = {};
    try {
      if (existsSync(configPath)) {
        root = JSON.parse(readFileSync(configPath, "utf-8"));
      }
    } catch {
      // Start fresh
    }
    const sync = (root.sync as Record<string, unknown>) ?? {};
    sync.remoteUrl = resolved;
    root.sync = sync;
    writeFileSync(configPath, JSON.stringify(root, null, 2) + "\n");

    return { ok: true };
  }
};
