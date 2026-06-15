/**
 * UI host server — the SvelteKit adapter-node build that serves the
 * OpenPalm web UI + admin API. Runs as a host process (not a container)
 * starting in v0.11.0.
 *
 * The build artifact lives at packages/ui/build/ relative to the repo root
 * and is resolved at compile time.
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  resolveOpenPalmHome, resolveUiBuildDir, createLogger, readSecret,
  checkAndUpdateUiBuild, PLATFORM_VERSION,
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
 * Self-update the control plane (npm `@openpalm/ui` → data/ui), then resolve and
 * spawn the SvelteKit Node child. Re-callable so a UI-build update can respawn
 * the child against the freshly downloaded data/ui without restarting the whole
 * `openpalm ui serve` supervisor (design §6.2).
 *
 * Non-fatal update: any network/registry error leaves the existing build in
 * place. Resolution happens AFTER the update so a strictly-newer data/ui wins.
 */
async function spawnUiChild(
  port: number,
  homeDir: string,
  state: ReturnType<typeof ensureValidState>,
): Promise<Bun.Subprocess> {
  // Self-update the control plane BEFORE spawning, matching the Electron harness
  // (main.ts: checkAndUpdateUiBuild before resolveUiBuildDir). `openpalm ui serve`
  // is a long-lived supervisor too, so without this the served UI/lib (and its
  // RELEASE_MIGRATIONS) would only ever update via the `openpalm update` command.
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
      ?? readSecret(state.stackDir, 'op_ui_login_password')?.trimEnd()
      ?? '';

  console.log('Starting UI server...');
  return Bun.spawn(
    ['node', join(uiBuildDir, 'index.js')],
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
        // (design §6.2). The admin "install UI version" route signals SIGHUP to
        // its parent (this process) after seeding a newer data/ui.
        OP_UI_SUPERVISOR:       'cli',
      },
      stdout: 'inherit',
      stderr: 'inherit',
    }
  );
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

  let uiProc = await spawnUiChild(port, homeDir, state);

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

  // Supervisor restart: the UI child (admin "install UI version" route) sends
  // SIGHUP to this parent after seeding a newer data/ui. Kill the current child
  // and respawn it against the freshly downloaded build — the new @openpalm/lib
  // (and its RELEASE_MIGRATIONS) only takes effect once the Node child restarts.
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
      uiProc = await spawnUiChild(port, homeDir, state);
      if (!await waitForReady(port)) {
        console.error('UI server did not become ready after restart.');
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
  process.on('SIGHUP',  () => { void restartUiServer(); });

  // Keep the process alive
  await new Promise<never>(() => {});
}
