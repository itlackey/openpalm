/**
 * Config Sync — Provider interface and shared types.
 *
 * Defines the pluggable contract that any sync backend (git, rclone, rsync, …)
 * must implement. The admin service loads the configured provider and delegates
 * all versioning / sync operations to it.
 */

/** A point-in-time snapshot of CONFIG_HOME. */
export type SyncSnapshot = {
  /** Provider-specific identifier (git SHA, timestamp, archive name, etc.) */
  id: string;
  /** Human-readable description of what changed */
  message: string;
  /** ISO 8601 timestamp */
  timestamp: string;
};

/** Current sync status returned by the provider. */
export type SyncStatus = {
  /** Whether the sync backend has been initialized for this CONFIG_HOME */
  initialized: boolean;
  /** Provider name (e.g. "git", "rclone", "none") */
  provider: string;
  /** Remote target URL/path (masked if sensitive). Empty when no remote is configured. */
  remote: string;
  /** ISO 8601 timestamp of last successful push/pull. Empty if never synced. */
  lastSync: string;
  /** Whether CONFIG_HOME has unsaved local changes */
  dirty: boolean;
};

/** Persistent sync configuration stored alongside CONFIG_HOME. */
export type SyncConfig = {
  /** Which provider to use (default: "git") */
  provider: string;
  /** Auto-snapshot after every config mutation */
  autoSnapshot: boolean;
  /** Auto-push to remote after every snapshot */
  autoPush: boolean;
};

/** Standard result envelope for provider operations. */
export type SyncResult = {
  ok: boolean;
  error?: string;
};

/** Result of a snapshot operation. */
export type SnapshotResult = SyncResult & {
  /** Provider-specific snapshot ID (e.g. git commit SHA) */
  id?: string;
};

/** Result of listing history. */
export type HistoryResult = SyncResult & {
  snapshots: SyncSnapshot[];
};

/**
 * ConfigSyncProvider — the contract every sync backend implements.
 *
 * All methods receive the absolute path to CONFIG_HOME so providers
 * are stateless and can be swapped at runtime.
 */
export interface ConfigSyncProvider {
  /** Provider name (e.g. "git", "rclone") */
  readonly name: string;

  /** One-time initialization of the sync backend in CONFIG_HOME. */
  init(configDir: string): Promise<SyncResult>;

  /** Create a local snapshot with a descriptive message. */
  snapshot(configDir: string, message: string): Promise<SnapshotResult>;

  /** Push local snapshots to the configured remote. */
  push(configDir: string): Promise<SyncResult>;

  /** Pull remote snapshots to local (fast-forward only; abort on conflict). */
  pull(configDir: string): Promise<SyncResult>;

  /** List recent snapshots (newest first). */
  history(configDir: string, limit?: number): Promise<HistoryResult>;

  /** Restore CONFIG_HOME to a specific snapshot. Skips secrets.env. */
  restore(configDir: string, snapshotId: string): Promise<SyncResult>;

  /** Get current sync status. */
  status(configDir: string): Promise<SyncStatus>;

  /** Configure the remote target (URL, path, bucket, etc.). */
  setRemote(configDir: string, remote: string): Promise<SyncResult>;
}
