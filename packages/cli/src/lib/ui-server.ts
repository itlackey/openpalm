/**
 * UI host server — the SvelteKit adapter-node build that serves the
 * OpenPalm web UI + admin API. Runs as a host process (not a container)
 * starting in v0.11.0.
 *
 * The build artifact lives at packages/ui/build/ relative to the repo root
 * and is resolved at compile time.
 */
import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import {
  resolveOpenPalmHome, resolveUiBuildDir, createLogger, readSecret,
  checkAndUpdateUiBuild, checkAndUpdateSkeleton, PLATFORM_VERSION,
  isRemoteSetupAllowed, waitForReady, restoreUiBackup, UiSupervisor,
} from '@openpalm/lib';
import { ensureValidState } from './cli-state.ts';
import { openBrowser } from './browser.ts';
import { DEFAULT_UI_PORT } from './ports.ts';

const logger = createLogger('cli:ui');
const DEFAULT_PORT = Number(process.env.OP_HOST_UI_PORT) || DEFAULT_UI_PORT;
const STOP_TIMEOUT_MS  = 5_000;

export interface UIServerOptions {
  port?: number;
  open?: boolean;
}

/**
 * Self-update the control plane (npm `@openpalm/ui` → data/ui) and skeleton
 * (npm `@openpalm/skeleton` → system/), then resolve and spawn the SvelteKit
 * Node child. Re-callable so a UI-build update can respawn the child against the
 * freshly downloaded data/ui without restarting the whole `openpalm ui serve`
 * supervisor (design §6.2).
 *
 * Non-fatal update: any network/registry error leaves the existing build/skeleton
 * in place. Resolution happens AFTER the update so a strictly-newer data/ui wins.
 * Returns the UI backup path so the supervisor can restore on restart failure (§4.4).
 */
async function spawnUiChild(
  port: number,
  homeDir: string,
  state: ReturnType<typeof ensureValidState>,
): Promise<{ proc: Bun.Subprocess; uiBackupDir: string | undefined }> {
  // Hot-swap the skeleton (managed system/ tree) before spawning.
  console.log('Checking for skeleton update...');
  const skelResult = await checkAndUpdateSkeleton(PLATFORM_VERSION, homeDir, state.dataDir);
  if (skelResult.updated) {
    console.log(`Skeleton updated to v${skelResult.latestVersion}.`);
  } else if (skelResult.error) {
    console.warn(`Warning: skeleton update skipped — ${skelResult.error}. Existing skeleton still active.`);
  }

  // Self-update the control plane BEFORE spawning, matching the Electron harness
  // (main.ts: checkAndUpdateUiBuild before resolveUiBuildDir). `openpalm ui serve`
  // is a long-lived supervisor too, so without this the served UI/lib would only
  // ever update via the `openpalm update` command.
  console.log('Checking for UI build update...');
  const uiResult = await checkAndUpdateUiBuild(PLATFORM_VERSION, state.dataDir);
  if (uiResult.updated) {
    console.log(`UI build updated to v${uiResult.latestVersion}.`);
  } else if (uiResult.error) {
    console.warn(`Warning: UI build update skipped — ${uiResult.error}. Existing build still active.`);
  }

  // Resolve AFTER the update so a freshly downloaded, strictly-newer data/ui is
  // the build we spawn (resolveUiBuildDir re-reads data/ui's version stamp).
  const uiBuildDir = resolveUiBuildDir();
  if (!existsSync(join(uiBuildDir, 'index.js'))) {
    console.error(`UI build not found at ${uiBuildDir}`);
    console.error('Run: bun run ui:build');
    process.exit(1);
  }
  // OP_UI_LOGIN_PASSWORD is unset during first-run install — the SvelteKit
  // hooks detect that and redirect /* to /setup, where the wizard sets
  // it. Don't short-circuit here, or the install wizard can never come up.
  const uiLoginPassword =
    process.env.OP_UI_LOGIN_PASSWORD
      ?? readSecret(state.homeDir, 'op_ui_login_password')?.trimEnd()
      ?? '';

  console.log('Starting UI server...');
  // Spawn the UI child on THIS binary's embedded runtime (no system `node`
  // required): re-invoke `openpalm ui`, which imports the adapter-node build
  // in-process via runUiBuild(). Mirrors the Electron harness, which spawns its
  // UI child with Electron's own Node rather than a system one.
  //   compiled binary → [binary, 'ui']
  //   dev (bun src/main.ts) → [bun, <entry>, 'ui']
  const execName = basename(process.execPath).toLowerCase();
  const runningAsBun = execName === 'bun' || execName === 'bun.exe';
  const childArgs = runningAsBun ? [Bun.main, 'ui'] : ['ui'];
  // Default: bind loopback with a pinned ORIGIN. With OP_ALLOW_REMOTE_SETUP the
  // server binds all interfaces and lets adapter-node derive the origin from the
  // request Host header (HOST_HEADER), so it works under whatever LAN host/IP the
  // operator reaches it by.
  const remote = isRemoteSetupAllowed();
  const networkEnv = remote
    ? { HOST: '0.0.0.0', PORT: String(port), HOST_HEADER: 'host', PROTOCOL_HEADER: 'x-forwarded-proto' }
    : { HOST: '127.0.0.1', PORT: String(port), ORIGIN: `http://127.0.0.1:${port}` };
  const proc = Bun.spawn(
    [process.execPath, ...childArgs],
    {
      cwd: uiBuildDir,
      env: {
        ...process.env,
        // Pass resolved absolute OP_HOME so the child doesn't re-resolve a
        // relative value (e.g. `.dev` from a repo-root .env) against its
        // own cwd (packages/ui/build/).
        OP_HOME:                homeDir,
        ...networkEnv,
        OP_UI_LOGIN_PASSWORD:   uiLoginPassword,
        // Tell the UI child it has a supervisor that can respawn it on demand
        // (design §6.2). The admin "install UI version" route signals SIGUSR2 to
        // its parent (this process) after seeding a newer data/ui.
        OP_UI_SUPERVISOR:       'cli',
      },
      stdout: 'inherit',
      stderr: 'inherit',
    }
  );
  return { proc, uiBackupDir: uiResult.backupDir };
}

/**
 * Run the SvelteKit adapter-node build in THIS process. Backs the `openpalm ui`
 * command: the supervisor (startUIServer) spawns `openpalm ui` as its killable/
 * respawnable child, and a user can run it directly to serve the UI standalone
 * (no auto-update). Importing the build runs it on the embedded Bun runtime, so
 * no system `node` is required. The adapter-node entry reads HOST/PORT/ORIGIN
 * from the environment and self-starts; the listening socket keeps us alive.
 */
export async function runUiBuild(opts: { port?: number } = {}): Promise<void> {
  const uiBuildDir = resolveUiBuildDir();
  const indexPath = join(uiBuildDir, 'index.js');
  if (!existsSync(indexPath)) {
    console.error(`UI build not found at ${uiBuildDir}`);
    console.error('Run: bun run ui:build');
    process.exit(1);
  }
  const port = opts.port ?? (Number(process.env.PORT) || DEFAULT_PORT);
  process.env.PORT = String(port);
  if (isRemoteSetupAllowed()) {
    // Bind all interfaces; let adapter-node derive the origin from the request
    // Host header rather than pinning it to loopback (do NOT set ORIGIN).
    process.env.HOST ??= '0.0.0.0';
    process.env.HOST_HEADER ??= 'host';
  } else {
    process.env.HOST ??= '127.0.0.1';
    process.env.ORIGIN ??= `http://127.0.0.1:${port}`;
  }
  process.chdir(uiBuildDir);
  await import(indexPath);
}

/** Minimal Bun.Subprocess surface the CLI supervisor adapter drives (injectable for tests). */
export type CliChildProc = Pick<Bun.Subprocess, 'kill' | 'exited' | 'killed'>;

/** Injectable dependencies for {@link createCliUiSupervisor} (real process/fs/exit by default). */
export interface CliUiSupervisorDeps {
  /** UI-server port the readiness poll targets. */
  port: number;
  /** Spawn the UI child (self-updates data/ui, returns handle + backup path). */
  spawnChild: () => Promise<{ proc: Bun.Subprocess; uiBackupDir: string | undefined }>;
  /** Readiness poll (defaults to the shared lib waitForReady). */
  waitForReadyFn?: (port: number) => Promise<boolean>;
  /** Restore the previous data/ui after a post-restart ready-failure. */
  restoreBackup: (backupDir: string | undefined) => void;
  /** Process exit (defaults to process.exit) — the exit-based failure policy. */
  exit?: (code: number) => void;
  /** Structured restart-error logger (defaults to the cli:ui logger). */
  logRestartError?: (err: unknown) => void;
  /** Force-kill grace window, ms (defaults to STOP_TIMEOUT_MS). */
  stopTimeoutMs?: number;
  /** Sleep for the stop race (defaults to a real setTimeout-backed delay). */
  sleep?: (ms: number) => Promise<void>;
  /** Stderr sink for the "did not become ready in time." line (defaults to console.error). */
  logError?: (...args: unknown[]) => void;
}

/**
 * Build the CLI's thin adapter over the shared {@link UiSupervisor}. The CLI
 * supplies the Bun.Subprocess spawn/kill strategy and its exit-based failure
 * policy (process.exit(1) on BOTH start- and restart-ready-failure); it has no
 * renderer, so onReloadRenderer is omitted. Exported (with injectable deps) so
 * the stop sequence and exit policy are testable without spawning real processes.
 *
 * @returns the supervisor plus the shared `stop` (reused by the signal-shutdown handler).
 */
export function createCliUiSupervisor(deps: CliUiSupervisorDeps): {
  supervisor: UiSupervisor<Bun.Subprocess>;
  stop: (proc: CliChildProc) => Promise<void>;
} {
  const { port, spawnChild, restoreBackup } = deps;
  const waitForReadyFn = deps.waitForReadyFn ?? ((p: number) => waitForReady(p));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const logRestartError = deps.logRestartError
    ?? ((err: unknown) => logger.error('Error restarting UI server', { error: String(err) }));
  const stopTimeoutMs = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const logError = deps.logError ?? console.error;

  // Tracks the LAST spawn's backup path so a post-restart ready-failure restores
  // the build that just failed (spawnUiChild re-runs the update check on each
  // respawn, so this is reassigned per spawn — matching the pre-refactor flow).
  let lastUiBackupDir: string | undefined;

  // Graceful-then-force stop of a Bun.Subprocess UI child: SIGTERM, race its
  // exit against the grace window, then SIGKILL only if it hasn't died. Shared by
  // the supervisor's restart path and the signal-shutdown handler.
  const stop = async (proc: CliChildProc): Promise<void> => {
    proc.kill('SIGTERM');
    await Promise.race([proc.exited, sleep(stopTimeoutMs)]);
    if (!proc.killed) proc.kill('SIGKILL');
  };

  const supervisor = new UiSupervisor<Bun.Subprocess>({
    port,
    strategy: {
      spawn: async () => {
        const spawnResult = await spawnChild();
        lastUiBackupDir = spawnResult.uiBackupDir;
        return spawnResult.proc;
      },
      stop,
    },
    callbacks: {
      waitForReady: waitForReadyFn,
      // Ready-timeout on first start → kill the child and exit non-zero (the lib
      // never exits; this policy hook does).
      onStartFailure: (proc) => {
        proc.kill('SIGTERM');
        logError('UI server did not become ready in time.');
        exit(1);
      },
      // Post-swap failure → restore the prior data/ui (§4.4 / §6) with a local
      // rename — no registry needed (shared lib routine)…
      restoreBackup: () => { restoreBackup(lastUiBackupDir); },
      // …then exit non-zero, as the pre-refactor CLI supervisor did.
      onRestartFailure: () => { exit(1); },
      onRestartError: logRestartError,
    },
  });

  return { supervisor, stop };
}

/**
 * Start the UI host server. Blocks until shutdown (SIGINT/SIGTERM).
 * Exits the process on error.
 */
export async function startUIServer(opts: UIServerOptions = {}): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT;
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${port}`);
    process.exit(1);
  }

  const homeDir = resolveOpenPalmHome();

  const state = ensureValidState();
  const uiUrl = `http://localhost:${port}`;

  const { supervisor, stop: stopUiProc } = createCliUiSupervisor({
    port,
    spawnChild: () => spawnUiChild(port, homeDir, state),
    restoreBackup: (backupDir) => restoreUiBackup(state.dataDir, backupDir),
  });

  if (!await supervisor.start()) return; // onStartFailure already exited

  console.log(`UI server running at ${uiUrl}`);
  if (opts.open !== false) await openBrowser(uiUrl);

  // Supervisor restart (§4.4): the UI child (admin "install UI version" route)
  // sends SIGUSR2/SIGHUP to this parent after seeding a newer data/ui. The
  // supervisor kills the current child and respawns against the freshly
  // downloaded build — the new @openpalm/lib only takes effect once the Node
  // child restarts (automatic, no "apply" click needed). On restart failure it
  // restores the backup and exits (§6).

  async function shutdown(signal: string): Promise<void> {
    supervisor.markShuttingDown();
    console.log(`\nReceived ${signal}. Shutting down...`);
    try {
      const proc = supervisor.current;
      if (proc) await stopUiProc(proc);
      console.log('Shutdown complete.');
    } catch (err) {
      logger.error('Error during shutdown', { error: String(err) });
    }
    process.exit(0);
  }

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // SIGUSR2: sent by the UI child's admin/ui-version route after seeding a new build.
  // SIGHUP:  kept for backward compatibility / manual use.
  process.on('SIGUSR2', () => { void supervisor.restart(); });
  process.on('SIGHUP',  () => { void supervisor.restart(); });

  // Keep the process alive
  await new Promise<never>(() => {});
}
