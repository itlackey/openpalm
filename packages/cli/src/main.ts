#!/usr/bin/env bun
import { defineCommand, runCommand, runMain } from 'citty';
import cliPkg from '../package.json' with { type: 'json' };
import { classifyLocalInstall, resolveStackDir } from '@openpalm/lib';

// Re-export public API used by tests and external consumers
export { detectHostInfo } from './lib/host-info.ts';
export type { HostInfo } from './lib/host-info.ts';

const SUBCOMMAND_NAMES = new Set([
  'install', 'uninstall', 'update', 'migrate', 'self-update', 'addon',
  'start', 'stop', 'restart', 'logs', 'status', 'backups',
  'validate', 'scan', 'audit-secrets', 'rollback', 'automations', 'unlock',
  '--help', '-h', 'help',
]);

interface BareRunOpts {
  port?: number;
  open?: boolean;
}

/**
 * Probe the assistant container's healthcheck to decide whether the stack
 * is already up. We hit the assistant's published host port (default 3800,
 * overridable via OP_ASSISTANT_PORT) rather than introspect Docker so this
 * works without docker socket access and respects whatever overrides are
 * active.
 */
async function isAssistantHealthy(): Promise<boolean> {
  const port = process.env.OP_ASSISTANT_PORT ?? '3800';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Smart default: `openpalm` (no subcommand) detects state and does the
 * right thing automatically.
 *
 *  - Not installed → runs the install flow (seeds OP_HOME, spawns wizard)
 *  - Installed, stack down → starts the stack
 *  - Installed, stack up → starts the UI host server (foreground)
 *
 * The UI server runs in the foreground until SIGINT/SIGTERM. This is
 * the canonical way to "run OpenPalm" — no separate `ui`/`admin`
 * subcommand.
 */
async function autoRun(opts: BareRunOpts = {}): Promise<void> {
  const isInstalled = classifyLocalInstall(resolveStackDir()) !== 'not_installed';

  if (!isInstalled) {
    const { bootstrapInstall, resolveDefaultInstallRef } = await import('./commands/install.ts') as any;
    const version: string = typeof resolveDefaultInstallRef === 'function'
      ? await resolveDefaultInstallRef()
      : (cliPkg.version ? `v${cliPkg.version}` : 'main');
    await bootstrapInstall({
      force: false,
      version,
      noStart: false,
      noOpen: opts.open === false,
    });
    return;
  }

  // Ensure the stack is up. Skip when the assistant is already healthy —
  // calling `docker compose up -d` would otherwise recreate containers
  // (when compose config differs, e.g. dev overlays add port bindings)
  // and tear down test/dev port mappings.
  const stackAlreadyUp = await isAssistantHealthy();
  if (!stackAlreadyUp) {
    const { runStartAction } = await import('./commands/start.ts');
    await runStartAction([]).catch((err) => {
      console.warn(`Warning: failed to ensure stack is running: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Start the UI host server in the foreground (blocks until SIGINT/SIGTERM).
  const { startUIServer } = await import('./lib/ui-server.ts');
  await startUIServer({ port: opts.port, open: opts.open });
}

export const mainCommand = defineCommand({
  meta: {
    name: 'openpalm',
    version: cliPkg.version,
    description: 'OpenPalm CLI — install and manage a self-hosted OpenPalm stack',
  },
  args: {
    port: {
      type: 'string',
      description: 'UI server port (default: 3880 or OP_HOST_UI_PORT)',
    },
    open: {
      type: 'boolean',
      description: 'Open browser after start (use --no-open to skip)',
      default: true,
    },
  },
  subCommands: {
    install: () => import('./commands/install.ts').then((m) => m.default),
    uninstall: () => import('./commands/uninstall.ts').then((m) => m.default),
    update: () => import('./commands/update.ts').then((m) => m.default),
    migrate: () => import('./commands/migrate.ts').then((m) => m.default),
    'self-update': () => import('./commands/self-update.ts').then((m) => m.default),
    addon: () => import('./commands/addon.ts').then((m) => m.default),
    start: () => import('./commands/start.ts').then((m) => m.default),
    stop: () => import('./commands/stop.ts').then((m) => m.default),
    restart: () => import('./commands/restart.ts').then((m) => m.default),
    logs: () => import('./commands/logs.ts').then((m) => m.default),
    status: () => import('./commands/status.ts').then((m) => m.default),
    backups: () => import('./commands/backups.ts').then((m) => m.default),
    validate: () => import('./commands/validate.ts').then((m) => m.default),
    scan: () => import('./commands/scan.ts').then((m) => m.default),
    'audit-secrets': () => import('./commands/audit-secrets.ts').then((m) => m.default),
    rollback: () => import('./commands/rollback.ts').then((m) => m.default),
    automations: () => import('./commands/automations.ts').then((m) => m.default),
    unlock: () => import('./commands/unlock.ts').then((m) => m.default),
  },
});

/** Parse `--port`/`--no-open` from a bare-command argv. */
function parseBareArgs(argv: string[]): BareRunOpts {
  const opts: BareRunOpts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      opts.port = Number(argv[++i]);
    } else if (argv[i]?.startsWith('--port=')) {
      opts.port = Number(argv[i]!.split('=')[1]);
    } else if (argv[i] === '--no-open') {
      opts.open = false;
    }
  }
  return opts;
}

/**
 * Programmatic entry point for tests and embedding.
 *
 * No-subcommand behaviour: autoRun() detects state and does the right thing.
 * Subcommand: route through citty.
 */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    console.log(cliPkg.version);
    return;
  }

  const hasSubcommand = argv.length > 0 && SUBCOMMAND_NAMES.has(argv[0]!);
  if (!hasSubcommand) {
    await autoRun(parseBareArgs(argv));
    return;
  }

  await runCommand(mainCommand, { rawArgs: argv });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || !SUBCOMMAND_NAMES.has(argv[0]!)) {
    if (argv[0] === '--version' || argv[0] === '-v') {
      console.log(cliPkg.version);
    } else {
      await autoRun(parseBareArgs(argv));
    }
  } else {
    await runMain(mainCommand);
  }
}
