/**
 * Shared UI-server supervisor primitives.
 *
 * The CLI UI commands and the Electron desktop shell both run a
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
import {
  existsSync as nodeExistsSync,
  mkdirSync,
  readFileSync,
  renameSync as nodeRenameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { errMessage } from './errors.js';
import { join } from 'node:path';

/**
 * Default readiness timeout (ms). Unifies the previously-divergent CLI (15s) and
 * Electron (60s) values on the more tolerant 60s so a slow first start — where
 * the UI child may pull/build images before it can answer /health — does not
 * spuriously fail the supervisor.
 */
export const DEFAULT_READY_TIMEOUT_MS = 60_000;
const UI_BACKUP_MARKER = '.ui-update-backup';

/** Persist an on-demand UI swap's backup path for the parent supervisor. */
export function recordPendingUiBackup(dataDir: string, backupDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const marker = join(dataDir, UI_BACKUP_MARKER);
  const tmp = `${marker}.tmp`;
  writeFileSync(tmp, `${backupDir}\n`, { mode: 0o600 });
  nodeRenameSync(tmp, marker);
}

/** Read and clear the backup path handed off by the UI child. */
export function consumePendingUiBackup(dataDir: string): string | null {
  const marker = join(dataDir, UI_BACKUP_MARKER);
  try {
    const backupDir = readFileSync(marker, 'utf8').trim();
    return backupDir || null;
  } catch {
    return null;
  } finally {
    rmSync(marker, { force: true });
  }
}

/** Injectable dependencies for {@link waitForReady} (defaults to real timers/fetch). */
export interface WaitForReadyDeps {
  /** Hostname used by the health probe (defaults to IPv4 loopback). */
  host?: string;
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
 * Poll the selected loopback host's `/health` until the UI server answers or the
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
    host = '127.0.0.1',
    fetchFn = fetch,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    pollIntervalMs = 300,
    requestTimeoutMs = 1000,
    now = Date.now,
  } = deps;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const res = await fetchFn(`http://${host}:${port}/health`, {
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

// ── UiSupervisor state machine ────────────────────────────────────────────────
// The CLI UI commands and the Electron desktop shell run the same
// supervisor STATE MACHINE around the UI child — spawn → wait-for-ready, and, on
// a SIGUSR2/IPC restart trigger, kill → respawn → wait-for-ready → (on failure)
// restore-backup — but they differ in every harness-scoped DETAIL:
//
//   • how the child is spawned/killed (Bun.Subprocess + proc.exited race vs
//     node child_process + killProcessTree + fixed delay),
//   • what happens on a ready-failure (CLI process.exit(1) vs Electron
//     dialog.showErrorBox + app.quit(), and on RESTART failure CLI exits while
//     Electron stays up),
//   • whether the renderer is reloaded afterwards (Electron yes, CLI no renderer).
//
// This class owns ONLY the state machine (ordering + the `restarting`/
// `shuttingDown` guards). Every harness-scoped effect is an injected strategy
// method or callback, so the lib stays `process.exit`-free (design §6.2 / §4.4).

/**
 * Per-harness process strategy: abstracts the Bun.Subprocess vs
 * node:child_process + killProcessTree divergence behind spawn/stop. `Handle` is
 * the opaque child handle the harness understands (never inspected by the
 * supervisor).
 */
export interface UiChildStrategy<Handle> {
  /**
   * Spawn a fresh UI child and return its handle. The harness owns everything
   * around the spawn (update-checks, env-building, pid-file, stdio/log wiring).
   */
  spawn(): Promise<Handle> | Handle;
  /**
   * Graceful-then-force stop of a running child. The harness owns the EXACT
   * kill sequence — CLI: `kill('SIGTERM')` → race `proc.exited` against a
   * timeout → conditional `kill('SIGKILL')`; Electron: `killProcessTree('SIGTERM')`
   * → fixed delay → `killProcessTree('SIGKILL')`.
   */
  stop(handle: Handle): Promise<void>;
}

/**
 * Harness-scoped callbacks. The supervisor stays `process.exit`-free: the exit /
 * quit / dialog / renderer-reload decisions all live in these adapter hooks.
 */
export interface UiSupervisorCallbacks<Handle> {
  /** Readiness poll (adapter injects its own timeout wrapper around {@link waitForReady}). */
  waitForReady(port: number): Promise<boolean>;
  /**
   * Invoked ONCE at the very start of {@link restart}, BEFORE the (conditional)
   * stop — so it runs UNCONDITIONALLY, even when there is no live child to stop
   * (`handle === null` after an unsupervised crash + {@link detachHandle}).
   * Electron uses it to capture-and-clear its pending `data/ui` backup
   * exactly-once, so a failed respawn still restores the CORRECT backup rather
   * than a null/stale one. CLI omits it (its backup is captured on each spawn).
   */
  beforeRestart?(): void;
  /**
   * The INITIAL start never became ready. The lib does NOT exit — the adapter
   * decides: CLI kills the child + `process.exit(1)`. Receives the spawned
   * handle so the adapter can kill it if it wants to. Optional: harnesses that
   * drive their own bespoke initial spawn and {@link UiSupervisor.adopt} the
   * child (e.g. Electron) never call {@link UiSupervisor.start} and omit this.
   */
  onStartFailure?(handle: Handle): void | Promise<void>;
  /**
   * A RESTART's respawn never became ready. Called AFTER {@link restoreBackup}.
   * CLI: `process.exit(1)`. Electron: omitted (no-op) — the app stays running
   * and `restart()` returns false.
   */
  onRestartFailure?(): void | Promise<void>;
  /**
   * Restore the previous `data/ui` after a post-restart ready-failure (§4.4).
   * Bound by the adapter to its own `dataDir` + backup path (via
   * {@link restoreUiBackup}) so the supervisor stays free of fs/backup provenance.
   */
  restoreBackup?(): void;
  /**
   * Fired after a SUCCESSFUL restart. Electron reloads the BrowserWindow onto
   * the freshly-restarted control plane; the CLI has no renderer, so it omits
   * this (no-op).
   */
  onReloadRenderer?(): void;
  /** A restart threw. CLI logs via its structured logger; Electron via console.error. */
  onRestartError?(err: unknown): void;
  /** Log sink for the shared informational state-machine lines (defaults to console.log — stdout). */
  log?(...args: unknown[]): void;
  /**
   * Log sink for the shared FAILURE lines (defaults to console.error — stderr).
   * Kept distinct from {@link log} so the "did not become ready after restart"
   * message stays on stderr, exactly as both pre-refactor harnesses emitted it.
   */
  logError?(...args: unknown[]): void;
}

export interface UiSupervisorOptions<Handle> {
  /** UI-server port the readiness poll targets. */
  port: number;
  strategy: UiChildStrategy<Handle>;
  callbacks: UiSupervisorCallbacks<Handle>;
}

/**
 * Shared supervisor state machine for the UI child. Both harnesses construct one
 * with their own {@link UiChildStrategy} + {@link UiSupervisorCallbacks}; the CLI
 * and Electron entry points become thin adapters that supply the divergent
 * spawn/kill/exit/dialog/reload behavior.
 */
export class UiSupervisor<Handle> {
  private handle: Handle | null = null;
  private restarting = false;
  private shuttingDown = false;
  private readonly port: number;
  private readonly strategy: UiChildStrategy<Handle>;
  private readonly cb: UiSupervisorCallbacks<Handle>;

  constructor(opts: UiSupervisorOptions<Handle>) {
    this.port = opts.port;
    this.strategy = opts.strategy;
    this.cb = opts.callbacks;
  }

  /** The current child handle (null before the first start / after a failed spawn). */
  get current(): Handle | null {
    return this.handle;
  }

  /** True while a restart is in flight (mirrors the old `uiServerRestarting`/`restarting` flags). */
  get isRestarting(): boolean {
    return this.restarting;
  }

  /**
   * Adopt a child that was spawned OUTSIDE the supervisor so a subsequent
   * {@link restart} knows which handle to stop. Use this when a harness owns a
   * bespoke initial-spawn path (e.g. Electron's seed-or-quit + splash + stderr
   * ring-buffer prelude) but still wants the shared restart state machine.
   * The alternative to {@link start} for the first child.
   */
  adopt(handle: Handle): void {
    this.handle = handle;
  }

  /**
   * Forget the current child WITHOUT stopping it. The Electron adapter calls this
   * from the UI child's `exit` handler when the child dies UNSUPERVISED (not
   * during a restart), so a later {@link restart} does not `stop()` a dead handle
   * — matching the pre-refactor `prev = uiProcess` (null) → skip-kill behavior.
   */
  detachHandle(): void {
    this.handle = null;
  }

  private log(...args: unknown[]): void {
    (this.cb.log ?? console.log)(...args);
  }

  private logError(...args: unknown[]): void {
    (this.cb.logError ?? console.error)(...args);
  }

  /**
   * Spawn the UI child and wait for it to become ready. On a ready-timeout the
   * {@link UiSupervisorCallbacks.onStartFailure} hook runs (the lib never exits).
   *
   * @returns true once the child is ready; false if it timed out (after the hook ran).
   */
  async start(): Promise<boolean> {
    this.handle = await this.strategy.spawn();
    if (!(await this.cb.waitForReady(this.port))) {
      await this.cb.onStartFailure?.(this.handle);
      return false;
    }
    return true;
  }

  /**
   * SIGUSR2/IPC-triggered restart: kill the current child, respawn against the
   * freshly-seeded build, and wait for ready. On failure, restore the backup and
   * run the restart-failure hook; on success, reload the renderer (Electron).
   *
   * Guarded by the `restarting` flag (re-entrant calls no-op) and `shuttingDown`
   * (set by the CLI's signal-shutdown; Electron never sets it, so the guard
   * reduces to `restarting` there — preserving each harness's original guard).
   *
   * @returns true on a successful restart; false if guarded out, aborted, or failed.
   */
  async restart(): Promise<boolean> {
    if (this.shuttingDown || this.restarting) return false;
    this.restarting = true;
    this.log('UI update detected — restarting UI server...');
    try {
      // Capture-and-clear the pending backup UNCONDITIONALLY, before the
      // conditional stop below — a detached (null) handle must NOT skip it.
      this.cb.beforeRestart?.();
      if (this.handle) await this.strategy.stop(this.handle);
      this.handle = await this.strategy.spawn();
      if (!(await this.cb.waitForReady(this.port))) {
        this.logError('UI server did not become ready after restart.');
        this.cb.restoreBackup?.();
        await this.cb.onRestartFailure?.();
        return false;
      }
      this.log('UI server restarted.');
      this.cb.onReloadRenderer?.();
      return true;
    } catch (err) {
      this.cb.restoreBackup?.();
      await this.cb.onRestartFailure?.();
      this.cb.onRestartError?.(err);
      return false;
    } finally {
      this.restarting = false;
    }
  }

  /**
   * Mark the supervisor as shutting down so an in-flight or subsequent
   * {@link restart} no-ops (the CLI's SIGINT/SIGTERM path sets this before it
   * kills the child and exits).
   */
  markShuttingDown(): void {
    this.shuttingDown = true;
  }
}
