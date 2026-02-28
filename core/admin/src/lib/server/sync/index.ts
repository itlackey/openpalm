/**
 * Config Sync — provider loader and mutation hook.
 *
 * Loads the configured sync provider and exposes `afterMutation()` —
 * the single hook called by admin API routes after every config change.
 * Failures in sync operations are logged but never block the caller.
 *
 * Configuration lives in CONFIG_HOME/config.json under the "sync" key:
 *   { "sync": { "provider": "tar", "enabled": true, "remoteUrl": "/some/path" } }
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gitProvider } from "./git-provider.js";
import { tarProvider } from "./tar-provider.js";
import type { ConfigSyncProvider, SyncConfig } from "./types.js";

// Re-export types for convenience
export type {
  ConfigSyncProvider,
  SyncConfig,
  SyncSnapshot,
  SyncStatus,
  SyncResult,
  SnapshotResult,
  HistoryResult
} from "./types.js";

/** Default sync configuration — syncing is off by default. */
const DEFAULT_CONFIG: SyncConfig = {
  provider: "git",
  enabled: false,
  remoteUrl: ""
};

/** Registry of available providers. New providers register here. */
const PROVIDERS: Record<string, ConfigSyncProvider> = {
  git: gitProvider,
  tar: tarProvider
};

/** Resolve the path to config.json within CONFIG_HOME. */
function configFilePath(configDir: string): string {
  return `${configDir}/config.json`;
}

/**
 * Read the full CONFIG_HOME/config.json, returning an empty object if missing.
 * This is the root config file — sync settings live under the "sync" key.
 */
function readConfigFile(configDir: string): Record<string, unknown> {
  const path = configFilePath(configDir);
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    }
  } catch {
    // Corrupt or unreadable
  }
  return {};
}

/** Write the full CONFIG_HOME/config.json, preserving non-sync keys. */
function writeConfigFile(configDir: string, data: Record<string, unknown>): void {
  const path = configFilePath(configDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

/** Read sync configuration from CONFIG_HOME/config.json → .sync */
export function readSyncConfig(configDir: string): SyncConfig {
  const root = readConfigFile(configDir);
  const raw = root.sync as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_CONFIG };
  }
  return {
    provider: typeof raw.provider === "string" ? raw.provider : DEFAULT_CONFIG.provider,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    remoteUrl: typeof raw.remoteUrl === "string" ? raw.remoteUrl : DEFAULT_CONFIG.remoteUrl
  };
}

/** Write sync configuration to CONFIG_HOME/config.json → .sync, preserving other keys. */
export function writeSyncConfig(configDir: string, config: SyncConfig): void {
  const root = readConfigFile(configDir);
  root.sync = config;
  writeConfigFile(configDir, root);
}

/** Get the configured provider instance. Falls back to git if unknown. */
export function getProvider(configDir: string): ConfigSyncProvider {
  const config = readSyncConfig(configDir);
  return PROVIDERS[config.provider] ?? PROVIDERS.git;
}

/**
 * afterMutation — call after any config-changing operation.
 *
 * If sync is enabled, creates a snapshot with the given message.
 * If a remoteUrl is configured, also pushes to remote after the snapshot.
 *
 * Failures are returned (for audit logging) but never throw.
 */
export async function afterMutation(
  configDir: string,
  message: string
): Promise<{ snapshotOk: boolean; pushOk: boolean; error?: string }> {
  const config = readSyncConfig(configDir);
  if (!config.enabled) {
    return { snapshotOk: true, pushOk: true };
  }

  const provider = getProvider(configDir);
  const status = await provider.status(configDir);
  if (!status.initialized) {
    return { snapshotOk: true, pushOk: true };
  }

  // Snapshot
  const snapResult = await provider.snapshot(configDir, message);
  if (!snapResult.ok) {
    return { snapshotOk: false, pushOk: false, error: snapResult.error };
  }

  // Auto-push if a remote is configured
  if (config.remoteUrl) {
    const pushResult = await provider.push(configDir);
    if (!pushResult.ok) {
      return { snapshotOk: true, pushOk: false, error: pushResult.error };
    }
  }

  return { snapshotOk: true, pushOk: true };
}
