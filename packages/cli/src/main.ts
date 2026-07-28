#!/usr/bin/env bun
import { defineCommand, runCommand, runMain } from 'citty';
import cliPkg from '../package.json' with { type: 'json' };
import { classifyLocalInstall, resolveStackDir, resolveOpenPalmHome } from '@openpalm/lib';
import { DEFAULT_ASSISTANT_PORT } from './lib/ports.ts';

// Re-export public API used by tests and external consumers
export { detectHostInfo } from './lib/host-info.ts';
export type { HostInfo } from './lib/host-info.ts';

interface BareRunOpts {
  port?: number;
  open?: boolean;
}

/**
 * Probe the assistant container's healthcheck to decide whether the stack
 * is already up. We hit the assistant's published host port (default 3810,
 * overridable via OP_ASSISTANT_PORT) rather than introspect Docker so this
 * works without docker socket access and respects whatever overrides are
 * active.
 *
 * The probe sends no Basic auth, so when direct Assistant access enables
 * OpenCode auth (`OPENCODE_AUTH=true`) the Assistant answers
 * `/health` with 401 — which is proof the container is up and listening, not a
 * reason to run `docker compose up -d` and needlessly recreate a healthy stack.
 * Treat a 401/403 (auth-gated but reachable) exactly like a 2xx. Only a thrown
 * connection error (refused/timeout) or a 5xx (the assistant is up but broken —
 * a restart, not a recreate, is the operator's tool) reads as "not up".
 */
export async function isAssistantHealthy(): Promise<boolean> {
  const port = process.env.OP_ASSISTANT_PORT ?? String(DEFAULT_ASSISTANT_PORT);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok || res.status === 401 || res.status === 403;
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
 * the canonical way to "run OpenPalm". `openpalm admin` serves the same
 * UI with the host admin capability enabled (loopback-only).
 */
async function autoRun(opts: BareRunOpts = {}): Promise<void> {
  const isInstalled = classifyLocalInstall(resolveStackDir(), resolveOpenPalmHome()) !== 'not_installed';

  if (!isInstalled) {
    const { bootstrapInstall, resolveDefaultInstallRef } = await import('./commands/install.ts');
    const version: string = typeof resolveDefaultInstallRef === 'function'
      ? await resolveDefaultInstallRef()
      : (cliPkg.version ?? 'main');
    await bootstrapInstall({
      force: false,
      version,
      noStart: false,
      noOpen: opts.open === false,
      assumeYes: false,
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

// Single source of truth for the registered subcommands. SUBCOMMAND_NAMES is
// derived from these keys below so adding a subcommand here can never drift
// out of sync with the bare-command routing table.
const subCommands = {
  admin: () => import('./commands/admin.ts').then((m) => m.default),
  app: () => import('./commands/app.ts').then((m) => m.default),
  install: () => import('./commands/install.ts').then((m) => m.default),
  uninstall: () => import('./commands/uninstall.ts').then((m) => m.default),
  update: () => import('./commands/update.ts').then((m) => m.default),
  'self-update': () => import('./commands/self-update.ts').then((m) => m.default),
  addon: () => import('./commands/addon.ts').then((m) => m.default),
  doctor: () => import('./commands/doctor.ts').then((m) => m.default),
  start: () => import('./commands/start.ts').then((m) => m.default),
  'repair-ownership': () => import('./commands/repair-ownership.ts').then((m) => m.default),
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
  'reset-password': () => import('./commands/reset-password.ts').then((m) => m.default),
  ui: () => import('./commands/ui.ts').then((m) => m.default),
};

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
  subCommands,
});

// Derived from the command registry (plus citty's built-in help/version
// aliases) so `main()` and the bare-command entrypoint route identically and
// never mis-route a newly added subcommand.
const SUBCOMMAND_NAMES = new Set<string>([
  ...Object.keys(subCommands),
  '--help', '-h', 'help',
]);

/** A lone `--version`/`-v` flag prints the version and does nothing else. */
function isVersionFlag(argv: string[]): boolean {
  return argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v');
}

/** True when the first arg names a registered subcommand (or help alias). */
function hasSubcommand(argv: string[]): boolean {
  const first = argv[0];
  return first !== undefined && SUBCOMMAND_NAMES.has(first);
}

/** Parse `--port`/`--no-open` from a bare-command argv. */
function parseBareArgs(argv: string[]): BareRunOpts {
  const opts: BareRunOpts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      opts.port = Number(argv[++i]);
    } else if (argv[i]?.startsWith('--port=')) {
      opts.port = Number(argv[i]?.split('=')[1]);
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
  if (isVersionFlag(argv)) {
    console.log(cliPkg.version);
    return;
  }
  if (!hasSubcommand(argv)) {
    await autoRun(parseBareArgs(argv));
    return;
  }
  await runCommand(mainCommand, { rawArgs: argv });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  // Same routing decision as main(), but subcommands go through citty's
  // runMain so its error formatting + exit handling surface command failures
  // (main() uses runCommand so tests can drive it programmatically).
  if (isVersionFlag(argv)) {
    console.log(cliPkg.version);
  } else if (!hasSubcommand(argv)) {
    await autoRun(parseBareArgs(argv));
  } else {
    await runMain(mainCommand);
  }
}
