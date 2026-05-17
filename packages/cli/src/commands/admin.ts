import { defineCommand } from 'citty';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { resolveOpenPalmHome, resolveConfigDir, createLogger } from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';
import { startOpenCodeSubprocess, type OpenCodeSubprocess } from '../lib/opencode-subprocess.ts';
import { openBrowser } from '../lib/browser.ts';

// The SvelteKit adapter-node build lives in packages/ui/build/ relative to the repo root.
// When the CLI is compiled to a binary, this path is resolved at build time.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const UI_BUILD_DIR = join(REPO_ROOT, 'packages', 'ui', 'build');

const logger = createLogger('cli:admin');
const HOST_ADMIN_PORT = Number(process.env.OP_HOST_ADMIN_PORT) || 3880;
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

export default defineCommand({
  meta: {
    name: 'admin',
    description: 'Start the host admin UI',
  },
  args: {
    port: {
      type: 'string',
      description: 'Port to listen on (default: 3880 or OP_HOST_ADMIN_PORT)',
    },
    open: {
      type: 'boolean',
      description: 'Open browser after start (use --no-open to skip)',
      default: true,
    },
  },
  async run({ args }) {
    const port = args.port ? Number(args.port) : HOST_ADMIN_PORT;
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${args.port}`);
      process.exit(1);
    }

    const homeDir     = resolveOpenPalmHome();
    const configDir   = resolveConfigDir();
    const stateDir    = `${homeDir}/state`;

    if (!existsSync(join(UI_BUILD_DIR, 'index.js'))) {
      console.error(`Admin UI build not found at ${UI_BUILD_DIR}`);
      console.error('Run: bun run admin:build');
      process.exit(1);
    }
    const buildDir = UI_BUILD_DIR;

    const state = ensureValidState();
    const { adminToken } = state;
    if (!adminToken) {
      console.error('Admin token not configured. Run `openpalm install` first.');
      process.exit(1);
    }

    // Start OpenCode subprocess (non-fatal — admin still works without it)
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

    // Start SvelteKit adapter-node build bound to localhost
    console.log('Starting UI server...');
    const adminProc = Bun.spawn(
      ['node', join(buildDir, 'index.js')],
      {
        cwd: buildDir,
        env: {
          ...process.env,
          HOST:           '127.0.0.1',
          PORT:           String(port),
          ORIGIN:         `http://127.0.0.1:${port}`,
          OP_ADMIN_TOKEN: adminToken,
          ...(openCodeBaseUrl ? { OP_OPENCODE_URL: openCodeBaseUrl } : {}),
        },
        stdout: 'inherit',
        stderr: 'inherit',
      }
    );

    if (!await waitForReady(port)) {
      adminProc.kill('SIGTERM');
      if (openCodeSub) await openCodeSub.stop().catch(() => {});
      console.error('UI server did not become ready in time.');
      process.exit(1);
    }

    const adminUrl = `http://localhost:${port}`;
    console.log(`UI server running at ${adminUrl}`);
    if (args.open) await openBrowser(adminUrl);

    // ── Graceful shutdown ──────────────────────────────────────────────
    async function shutdown(signal: string): Promise<void> {
      console.log(`\nReceived ${signal}. Shutting down...`);
      try {
        adminProc.kill('SIGTERM');
        await Promise.race([
          adminProc.exited,
          new Promise(r => setTimeout(r, STOP_TIMEOUT_MS)),
        ]);
        if (!adminProc.killed) adminProc.kill('SIGKILL');
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
  },
});
