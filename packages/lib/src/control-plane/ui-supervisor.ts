/**
 * Shared UI-server supervisor primitives.
 *
 * The CLI (`openpalm ui serve`) and the Electron desktop shell both run a
 * long-lived supervisor around the SvelteKit adapter-node UI child: they spawn
 * it, wait for it to become ready, and — on a SIGUSR2-triggered UI-build
 * update — kill/respawn it and, on failure, restore the previous data/ui backup.
 *
 * These two harnesses independently reimplemented the same logic and DRIFTED
 * (notably the ready-timeout: CLI 15s vs Electron 60s). This module is the SSOT
 * for the pure, harness-agnostic pieces so both consume one implementation.
 *
 * Node.js-compatible only (no Bun.* APIs) so the Electron Node child can use it.
 * No `process.exit` here — these functions return/throw and the CLI/Electron
 * entry points decide exit behavior.
 */
import { existsSync as nodeExistsSync, renameSync as nodeRenameSync } from 'node:fs';
import { errMessage } from './errors.js';
import { join } from 'node:path';

/**
 * Default readiness timeout (ms). Unifies the previously-divergent CLI (15s) and
 * Electron (60s) values on the more tolerant 60s so a slow first start — where
 * the UI child may pull/build images before it can answer /health — does not
 * spuriously fail the supervisor.
 */
export const DEFAULT_READY_TIMEOUT_MS = 60_000;

/** Injectable dependencies for {@link waitForReady} (defaults to real timers/fetch). */
export interface WaitForReadyDeps {
  /** Fetch implementation (defaults to the global `fetch`). */
  fetchFn?: typeof fetch;
  /** Sleep between polls (defaults to a real setTimeout-backed delay). */
  sleep?: (ms: number) => Promise<void>;
  /** Delay between health polls, ms (default 300). */
  pollIntervalMs?: number;
  /** Per-request abort timeout, ms (default 1000). */
  requestTimeoutMs?: number;
  /** Clock (defaults to Date.now); injectable for deterministic tests. */
  now?: () => number;
}

/**
 * Poll `http://127.0.0.1:<port>/health` until the UI server answers or the
 * timeout elapses. A 200 OR a 401 both count as ready: 401 means the server is
 * up but behind the login wall, which is still "started".
 *
 * @returns true once ready; false if the deadline passes first.
 */
export async function waitForReady(
  port: number,
  timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
  deps: WaitForReadyDeps = {},
): Promise<boolean> {
  const {
    fetchFn = fetch,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    pollIntervalMs = 300,
    requestTimeoutMs = 1000,
    now = Date.now,
  } = deps;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const res = await fetchFn(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (res.ok || res.status === 401) return true;
    } catch {
      // not ready yet
    }
    await sleep(pollIntervalMs);
  }
  return false;
}

/** Injectable dependencies for {@link restoreUiBackup} (defaults to real fs/clock/log). */
export interface RestoreUiBackupDeps {
  existsSync?: (path: string) => boolean;
  renameSync?: (from: string, to: string) => void;
  /** Clock for the `.ui-failed-<ts>` suffix (defaults to Date.now). */
  now?: () => number;
  /** Log sink (defaults to console.error) — carries the same messages both harnesses emitted. */
  log?: (...args: unknown[]) => void;
}

/** Outcome of {@link restoreUiBackup}. */
export interface RestoreUiBackupOutcome {
  /**
   * - `no-backup`  — no usable backup dir was available; nothing changed.
   * - `restored`   — the failed data/ui was moved aside and the backup reinstated.
   * - `error`      — a rename threw; see `error`.
   */
  status: 'no-backup' | 'restored' | 'error';
  /** Path the failed build was moved to (only when status === 'restored'). */
  failedDir?: string;
  error?: unknown;
}

/**
 * Restore the previous `data/ui` after a UI-build update failed to become ready
 * (design §4.4 / §6). Moves the failed build to `.ui-failed-<ts>` and renames the
 * backup back into place — a purely local operation, no registry needed.
 *
 * Behavior-preserving extraction of the block both supervisors copy-pasted; the
 * exact log messages are retained here so the SSOT owns them.
 */
export function restoreUiBackup(
  dataDir: string,
  uiBackupDir: string | undefined | null,
  deps: RestoreUiBackupDeps = {},
): RestoreUiBackupOutcome {
  const {
    existsSync = nodeExistsSync,
    renameSync = nodeRenameSync,
    now = Date.now,
    log = console.error,
  } = deps;

  if (!uiBackupDir || !existsSync(uiBackupDir)) {
    return { status: 'no-backup' };
  }
  try {
    const dataUiDir = join(dataDir, 'ui');
    const failedDir = join(dataDir, `.ui-failed-${now()}`);
    if (existsSync(dataUiDir)) renameSync(dataUiDir, failedDir);
    renameSync(uiBackupDir, dataUiDir);
    log(`UI build restore: reinstated backup from ${uiBackupDir}; failed build at ${failedDir}`);
    return { status: 'restored', failedDir };
  } catch (restoreErr) {
    log('UI backup restore failed:', errMessage(restoreErr));
    return { status: 'error', error: restoreErr };
  }
}
