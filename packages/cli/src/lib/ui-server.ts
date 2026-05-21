/**
 * UI host server — the SvelteKit adapter-node build that serves the
 * OpenPalm web UI + admin API. Runs as a host process (not a container)
 * starting in v0.11.0.
 *
 * The build artifact lives at packages/ui/build/ relative to the repo root
 * and is resolved at compile time.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { resolveOpenPalmHome, resolveConfigDir, resolveStateDir, createLogger } from '@openpalm/lib';
import { ensureValidState } from './cli-state.ts';
import { startOpenCodeSubprocess, type OpenCodeSubprocess } from './opencode-subprocess.ts';
import { openBrowser } from './browser.ts';

/**
 * Resolve the UI build directory.
 *
 * Priority:
 *   1. OP_HOME/state/ui/ — installed by `openpalm install` / `openpalm update`
 *      This is the canonical path for both production binaries and local installs.
 *   2. Dev fallback — packages/ui/build/ relative to source or binary location.
 *      Used when running from the source repo before state/ui/ is populated.
 */
function resolveUiBuildDir(): string {
  const stateBuild = join(resolveStateDir(), 'ui');
  if (existsSync(join(stateBuild, 'index.js'))) return stateBuild;

  // Dev fallback: navigate from source file (not bunfs-safe, but that's fine
  // here because if state/ui/ doesn't exist we're already in dev mode).
  const metaPath = fileURLToPath(import.meta.url);
  if (!metaPath.startsWith('/$bunfs/')) {
    return join(dirname(metaPath), '..', '..', '..', '..', 'packages', 'ui', 'build');
  }
  // Compiled binary, no state/ui/ yet: fall back to relative-to-binary path.
  return join(dirname(realpathSync(process.execPath)), '..', '..', '..', 'packages', 'ui', 'build');
}

const UI_BUILD_DIR = resolveUiBuildDir();

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
 * Start the UI host server. Blocks until shutdown (SIGINT/SIGTERM).
 * Exits the process on error.
 */
export async function startUIServer(opts: UIServerOptions = {}): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT;
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${port}`);
    process.exit(1);
  }

  const homeDir   = resolveOpenPalmHome();
  const configDir = resolveConfigDir();
  const stateDir  = `${homeDir}/state`;

  if (!existsSync(join(UI_BUILD_DIR, 'index.js'))) {
    console.error(`UI build not found at ${UI_BUILD_DIR}`);
    console.error('Run: bun run ui:build');
    process.exit(1);
  }

  const state = ensureValidState();
  const { adminToken } = state;
  // OP_UI_TOKEN is unset during first-run install — the SvelteKit hooks
  // detect that and redirect /* to /setup, where the wizard generates
  // the token. Don't short-circuit here, or the install wizard can
  // never come up.

  // Start OpenCode subprocess (non-fatal — UI still works without it)
  let openCodeSub: OpenCodeSubprocess | null = null;
  let openCodeBaseUrl: string | undefined;
  try {
    console.log('Starting OpenCode subprocess...');
    openCodeSub = await startOpenCodeSubprocess({ homeDir, configDir, stateDir });
    const ready = await openCodeSub.waitForReady();
    if (ready) {
      openCodeBaseUrl = openCodeSub.baseUrl;
      console.log(`OpenCode subprocess ready at ${openCodeBaseUrl}`);
    } else {
      console.warn('OpenCode subprocess did not become ready. /proxy/assistant will return 503.');
      await openCodeSub.stop();
      openCodeSub = null;
    }
  } catch (err) {
    console.warn(`OpenCode subprocess failed to start: ${err instanceof Error ? err.message : String(err)}`);
    openCodeSub = null;
  }

  console.log('Starting UI server...');
  const uiProc = Bun.spawn(
    ['node', join(UI_BUILD_DIR, 'index.js')],
    {
      cwd: UI_BUILD_DIR,
      env: {
        ...process.env,
        // Pass resolved absolute OP_HOME so the child doesn't re-resolve a
        // relative value (e.g. `.dev` from a repo-root .env) against its
        // own cwd (packages/ui/build/).
        OP_HOME:     homeDir,
        HOST:        '127.0.0.1',
        PORT:        String(port),
        ORIGIN:      `http://127.0.0.1:${port}`,
        OP_UI_TOKEN: adminToken,
        ...(openCodeBaseUrl ? { OP_OPENCODE_URL: openCodeBaseUrl } : {}),
      },
      stdout: 'inherit',
      stderr: 'inherit',
    }
  );

  if (!await waitForReady(port)) {
    uiProc.kill('SIGTERM');
    if (openCodeSub) await openCodeSub.stop().catch(() => {});
    console.error('UI server did not become ready in time.');
    process.exit(1);
  }

  const uiUrl = `http://localhost:${port}`;
  console.log(`UI server running at ${uiUrl}`);
  if (opts.open !== false) await openBrowser(uiUrl);

  async function shutdown(signal: string): Promise<void> {
    console.log(`\nReceived ${signal}. Shutting down...`);
    try {
      uiProc.kill('SIGTERM');
      await Promise.race([
        uiProc.exited,
        new Promise(r => setTimeout(r, STOP_TIMEOUT_MS)),
      ]);
      if (!uiProc.killed) uiProc.kill('SIGKILL');
      if (openCodeSub) await openCodeSub.stop().catch(() => {});
      console.log('Shutdown complete.');
    } catch (err) {
      logger.error('Error during shutdown', { error: String(err) });
    }
    process.exit(0);
  }

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep the process alive
  await new Promise<never>(() => {});
}
