/**
 * UI host server — the SvelteKit adapter-node build that serves the
 * OpenPalm web UI + admin API. Runs as a host process (not a container)
 * starting in v0.11.0.
 *
 * The build artifact lives at packages/ui/build/ relative to the repo root
 * and is resolved at compile time.
 */
import { join, basename } from 'node:path';
import { existsSync, renameSync } from 'node:fs';
import {
  resolveOpenPalmHome, resolveUiBuildDir, createLogger, readSecret,
  checkAndUpdateUiBuild, checkAndUpdateSkeleton, PLATFORM_VERSION,
} from '@openpalm/lib';
import { ensureValidState } from './cli-state.ts';
import { openBrowser } from './browser.ts';

const logger = createLogger('cli:ui');
const DEFAULT_PORT = Number(process.env.OP_HOST_UI_PORT) || 3880;
const READY_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS  = 5_000;

async function waitForReady(port: number): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok || res.status === 401) return true;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

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
        HOST:                   '127.0.0.1',
        PORT:                   String(port),
        ORIGIN:                 `http://127.0.0.1:${port}`,
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
  process.env.HOST ??= '127.0.0.1';
  process.env.PORT = String(port);
  process.env.ORIGIN ??= `http://127.0.0.1:${port}`;
  process.chdir(uiBuildDir);
  await import(indexPath);
}

/**
 * Start the UI host server. Blocks until shutdown (SIGINT/SIGTERM).
 * Exits the process on error.
 */
export async function startUIServer(opts: UIServerOptions = {}): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT;
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${port}`);
    process.exit(1);
  }

  const homeDir = resolveOpenPalmHome();

  const state = ensureValidState();

  let spawnResult = await spawnUiChild(port, homeDir, state);
  let uiProc = spawnResult.proc;

  if (!await waitForReady(port)) {
    uiProc.kill('SIGTERM');
    console.error('UI server did not become ready in time.');
    process.exit(1);
  }

  const uiUrl = `http://localhost:${port}`;
  console.log(`UI server running at ${uiUrl}`);
  if (opts.open !== false) await openBrowser(uiUrl);

  let shuttingDown = false;
  let restarting = false;

  // Supervisor restart (§4.4): the UI child (admin "install UI version" route)
  // sends SIGUSR2/SIGHUP to this parent after seeding a newer data/ui. Kill the
  // current child and respawn against the freshly downloaded build — the new
  // @openpalm/lib only takes effect once the Node child restarts (automatic,
  // no "apply" click needed). On restart failure, restore the backup (§6).
  async function restartUiServer(): Promise<void> {
    if (shuttingDown || restarting) return;
    restarting = true;
    console.log('UI update detected — restarting UI server...');
    try {
      uiProc.kill('SIGTERM');
      await Promise.race([
        uiProc.exited,
        new Promise(r => setTimeout(r, STOP_TIMEOUT_MS)),
      ]);
      if (!uiProc.killed) uiProc.kill('SIGKILL');
      spawnResult = await spawnUiChild(port, homeDir, state);
      uiProc = spawnResult.proc;
      if (!await waitForReady(port)) {
        console.error('UI server did not become ready after restart.');
        // Post-swap failure → restore backup (§4.4 / §6). Reinstate the prior
        // data/ui with a local rename — no registry needed.
        const uiBackup = spawnResult.uiBackupDir;
        if (uiBackup && existsSync(uiBackup)) {
          try {
            const dataUiDir = join(state.dataDir, 'ui');
            const failedDir = join(state.dataDir, `.ui-failed-${Date.now()}`);
            if (existsSync(dataUiDir)) renameSync(dataUiDir, failedDir);
            renameSync(uiBackup, dataUiDir);
            console.error(`UI build restore: reinstated backup from ${uiBackup}; failed build at ${failedDir}`);
          } catch (restoreErr) {
            console.error('UI backup restore failed:', restoreErr instanceof Error ? restoreErr.message : String(restoreErr));
          }
        }
        process.exit(1);
      }
      console.log(`UI server restarted at ${uiUrl}`);
    } catch (err) {
      logger.error('Error restarting UI server', { error: String(err) });
    } finally {
      restarting = false;
    }
  }

  async function shutdown(signal: string): Promise<void> {
    shuttingDown = true;
    console.log(`\nReceived ${signal}. Shutting down...`);
    try {
      uiProc.kill('SIGTERM');
      await Promise.race([
        uiProc.exited,
        new Promise(r => setTimeout(r, STOP_TIMEOUT_MS)),
      ]);
      if (!uiProc.killed) uiProc.kill('SIGKILL');
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
  process.on('SIGUSR2', () => { void restartUiServer(); });
  process.on('SIGHUP',  () => { void restartUiServer(); });

  // Keep the process alive
  await new Promise<never>(() => {});
}
