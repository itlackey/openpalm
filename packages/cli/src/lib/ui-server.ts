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
import { resolveOpenPalmHome, resolveConfigDir, resolveUiBuildDir, createLogger, readSecret } from '@openpalm/lib';
import { ensureValidState } from './cli-state.ts';
import { startOpenCodeSubprocess, type OpenCodeSubprocess } from './opencode-subprocess.ts';
import { openBrowser } from './browser.ts';

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
  const dataDir  = `${homeDir}/data`;

  if (!existsSync(join(UI_BUILD_DIR, 'index.js'))) {
    console.error(`UI build not found at ${UI_BUILD_DIR}`);
    console.error('Run: bun run ui:build');
    process.exit(1);
  }

  const state = ensureValidState();
  // OP_UI_LOGIN_PASSWORD is unset during first-run install — the SvelteKit
  // hooks detect that and redirect /* to /setup, where the wizard sets
  // it. Don't short-circuit here, or the install wizard can never come up.
  const uiLoginPassword =
    process.env.OP_UI_LOGIN_PASSWORD
      ?? readSecret(state.stackDir, 'op_ui_login_password')?.trimEnd()
      ?? '';

  // Start OpenCode subprocess (non-fatal — UI still works without it)
  let openCodeSub: OpenCodeSubprocess | null = null;
  let openCodeBaseUrl: string | undefined;
  try {
    console.log('Starting OpenCode subprocess...');
    openCodeSub = await startOpenCodeSubprocess({ homeDir, configDir, dataDir });
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
        OP_HOME:                homeDir,
        HOST:                   '127.0.0.1',
        PORT:                   String(port),
        ORIGIN:                 `http://127.0.0.1:${port}`,
        OP_UI_LOGIN_PASSWORD:   uiLoginPassword,
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
