/**
 * Config Sync — provider loader and mutation hook.
 *
 * Loads the configured sync provider and exposes `afterMutation()` —
 * the single hook called by admin API routes after every config change.
 * Failures in sync operations are logged but never block the caller.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gitProvider } from "./git-provider.js";
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

/** Default sync configuration. */
const DEFAULT_CONFIG: SyncConfig = {
  provider: "git",
  autoSnapshot: true,
  autoPush: false
};

/** Registry of available providers. New providers register here. */
const PROVIDERS: Record<string, ConfigSyncProvider> = {
  git: gitProvider
};

/** Resolve the path to sync.json within CONFIG_HOME. */
function syncConfigPath(configDir: string): string {
  return `${configDir}/sync.json`;
}

/** Read sync configuration from CONFIG_HOME/sync.json. */
export function readSyncConfig(configDir: string): SyncConfig {
  const path = syncConfigPath(configDir);
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      return {
        provider: typeof raw.provider === "string" ? raw.provider : DEFAULT_CONFIG.provider,
        autoSnapshot: typeof raw.autoSnapshot === "boolean" ? raw.autoSnapshot : DEFAULT_CONFIG.autoSnapshot,
        autoPush: typeof raw.autoPush === "boolean" ? raw.autoPush : DEFAULT_CONFIG.autoPush
      };
    }
  } catch {
    // Corrupt or unreadable — fall back to defaults
  }
  return { ...DEFAULT_CONFIG };
}

/** Write sync configuration to CONFIG_HOME/sync.json. */
export function writeSyncConfig(configDir: string, config: SyncConfig): void {
  const path = syncConfigPath(configDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

/** Get the configured provider instance. Falls back to git if unknown. */
export function getProvider(configDir: string): ConfigSyncProvider {
  const config = readSyncConfig(configDir);
  return PROVIDERS[config.provider] ?? PROVIDERS.git;
}

/**
 * afterMutation — call after any config-changing operation.
 *
 * If autoSnapshot is enabled, creates a snapshot with the given message.
 * If autoPush is also enabled, pushes to remote after the snapshot.
 *
 * Failures are returned (for audit logging) but never throw.
 */
export async function afterMutation(
  configDir: string,
  message: string
): Promise<{ snapshotOk: boolean; pushOk: boolean; error?: string }> {
  const config = readSyncConfig(configDir);
  if (!config.autoSnapshot) {
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

  // Auto-push if enabled and a remote is configured
  if (config.autoPush && status.remote) {
    const pushResult = await provider.push(configDir);
    if (!pushResult.ok) {
      return { snapshotOk: true, pushOk: false, error: pushResult.error };
    }
  }

  return { snapshotOk: true, pushOk: true };
}
