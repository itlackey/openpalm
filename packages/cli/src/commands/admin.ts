import { defineCommand } from 'citty';
import { listEnabledAddonIds, resolveCacheDir, resolveOpenPalmHome, resolveConfigDir, createLogger } from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';
import { runAddonDisableAction, runAddonEnableAction } from './addon.ts';
import { ensureAdminBuild } from '../lib/admin-build.ts';
import { createHostAdminServer } from '../lib/host-admin-server.ts';
import { startOpenCodeSubprocess, type OpenCodeSubprocess } from '../lib/opencode-subprocess.ts';
import { openBrowser } from '../lib/browser.ts';

const logger = createLogger('cli:admin');
const HOST_ADMIN_PORT = Number(process.env.OP_HOST_ADMIN_PORT) || 3880;

// ── existing subcommands ─────────────────────────────────────────────────

async function runAdminStatusAction(): Promise<void> {
  const state = ensureValidState();
  const enabled = listEnabledAddonIds(state.homeDir).includes('admin');
  console.log(enabled ? 'Admin addon is enabled.' : 'Admin addon is disabled.');
}

const enableCmd = defineCommand({
  meta: { name: 'enable', description: 'Enable the admin addon' },
  async run() { await runAddonEnableAction('admin'); },
});

const disableCmd = defineCommand({
  meta: { name: 'disable', description: 'Disable the admin addon' },
  async run() { await runAddonDisableAction('admin'); },
});

const statusCmd = defineCommand({
  meta: { name: 'status', description: 'Show whether the admin addon is enabled' },
  async run() { await runAdminStatusAction(); },
});

// ── serve subcommand ─────────────────────────────────────────────────────

const serveCmd = defineCommand({
  meta: {
    name: 'serve',
    description: 'Start the host admin server',
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
    'container-admin': {
      type: 'string',
      description: 'Base URL for the container admin to proxy /proxy/admin (optional)',
    },
  },
  async run({ args }) {
    const port = args.port ? Number(args.port) : HOST_ADMIN_PORT;
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${args.port}`);
      process.exit(1);
    }

    const cacheDir = resolveCacheDir();
    const homeDir = resolveOpenPalmHome();
    const configDir = resolveConfigDir();
    const stateDir = `${homeDir}/state`;

    // Extract the admin build (idempotent)
    console.log('Preparing admin build...');
    let buildDir: string;
    try {
      buildDir = ensureAdminBuild(cacheDir);
    } catch (err) {
      console.error(`Failed to prepare admin build: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // Read admin token from stack state
    const state = ensureValidState();
    const adminToken = state.adminToken;
    if (!adminToken) {
      console.error(
        'Admin token not configured. Run `openpalm install` first.'
      );
      process.exit(1);
    }

    // Start OpenCode subprocess (non-fatal)
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

    // Start host admin server
    console.log('Starting host admin server...');
    let adminServer: Awaited<ReturnType<typeof createHostAdminServer>>;
    try {
      adminServer = await createHostAdminServer({
        port,
        buildDir,
        adminToken,
        openCodeBaseUrl,
        containerAdminBaseUrl: args['container-admin'],
      });
    } catch (err) {
      console.error(`Failed to start host admin server: ${err instanceof Error ? err.message : String(err)}`);
      if (openCodeSub) await openCodeSub.stop().catch(() => {});
      process.exit(1);
    }

    const adminUrl = `http://localhost:${port}`;
    console.log(`Host admin server running at ${adminUrl}`);

    if (args.open) await openBrowser(adminUrl);

    // ── Graceful shutdown ──────────────────────────────────────────────
    async function shutdown(signal: string): Promise<void> {
      console.log(`\nReceived ${signal}. Shutting down...`);
      try {
        await adminServer.stop();
        if (openCodeSub) await openCodeSub.stop().catch(() => {});
        console.log('Shutdown complete.');
      } catch (err) {
        logger.error('Error during shutdown', { error: String(err) });
      }
      process.exit(0);
    }

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Keep the process alive
    await new Promise<never>(() => {});
  },
});

// ── Root admin command ───────────────────────────────────────────────────

export default defineCommand({
  meta: {
    name: 'admin',
    description: 'Enable, disable, inspect, or host the admin panel',
  },
  subCommands: {
    enable: enableCmd,
    disable: disableCmd,
    status: statusCmd,
    serve: serveCmd,
  },
});
