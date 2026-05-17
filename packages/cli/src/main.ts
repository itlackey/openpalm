#!/usr/bin/env bun
import { defineCommand, runCommand, runMain } from 'citty';
import { join } from 'node:path';
import cliPkg from '../package.json' with { type: 'json' };
import { resolveConfigDir } from '@openpalm/lib';

// Re-export public API used by tests and external consumers
export { detectHostInfo } from './lib/host-info.ts';
export type { HostInfo } from './lib/host-info.ts';

const ADMIN_URL = `http://localhost:${process.env.OP_HOST_ADMIN_PORT ?? 3880}`;

/**
 * Smart default: running `openpalm` with no subcommand detects state and
 * does the right thing automatically.
 *
 *  - Not installed → runs install flow (seeds OP_HOME, spawns setup wizard)
 *  - Installed, not running → starts the stack, then opens the UI
 *  - Installed and running → opens the UI in the browser
 */
async function autoRun(): Promise<void> {
  const stackEnv = join(resolveConfigDir(), 'stack', 'stack.env');
  const isInstalled = await Bun.file(stackEnv).exists();

  if (!isInstalled) {
    const { bootstrapInstall } = await import('./commands/install.ts');
    const { resolveDefaultInstallRef } = await import('./commands/install.ts') as any;
    // Resolve version the same way `openpalm install` does
    const version: string = typeof resolveDefaultInstallRef === 'function'
      ? await resolveDefaultInstallRef()
      : (cliPkg.version ? `v${cliPkg.version}` : 'main');
    await bootstrapInstall({ force: false, version, noStart: false, noOpen: false });
    return;
  }

  // Already installed — check if UI is reachable
  const isRunning = await fetch(ADMIN_URL, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.status < 500)
    .catch(() => false);

  if (!isRunning) {
    console.log('Starting OpenPalm...');
    const { runStartAction } = await import('./commands/start.ts');
    await runStartAction([]);
  }

  await import('./lib/browser.ts').then(({ openBrowser }) => openBrowser(ADMIN_URL));
}

export const mainCommand = defineCommand({
  meta: {
    name: 'openpalm',
    version: cliPkg.version,
    description: 'OpenPalm CLI — install and manage a self-hosted OpenPalm stack',
  },
  subCommands: {
    install: () => import('./commands/install.ts').then((m) => m.default),
    uninstall: () => import('./commands/uninstall.ts').then((m) => m.default),
    update: () => import('./commands/update.ts').then((m) => m.default),
    'self-update': () => import('./commands/self-update.ts').then((m) => m.default),
    addon: () => import('./commands/addon.ts').then((m) => m.default),
    admin: () => import('./commands/admin.ts').then((m) => m.default),
    start: () => import('./commands/start.ts').then((m) => m.default),
    stop: () => import('./commands/stop.ts').then((m) => m.default),
    restart: () => import('./commands/restart.ts').then((m) => m.default),
    logs: () => import('./commands/logs.ts').then((m) => m.default),
    status: () => import('./commands/status.ts').then((m) => m.default),
    service: () => import('./commands/service.ts').then((m) => m.default),
    validate: () => import('./commands/validate.ts').then((m) => m.default),
    scan: () => import('./commands/scan.ts').then((m) => m.default),
    rollback: () => import('./commands/rollback.ts').then((m) => m.default),
    automations: () => import('./commands/automations.ts').then((m) => m.default),
  },
});

/**
 * Programmatic entry point for tests and embedding.
 * Uses runCommand directly (not runMain) to avoid the process.exit(1) wrapper
 * and process.argv manipulation.
 *
 * No-args behaviour: autoRun() detects state and does the right thing.
 */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 0 || (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v'))) {
    if (argv[0] === '--version' || argv[0] === '-v') {
      console.log(cliPkg.version);
      return;
    }
    await autoRun();
    return;
  }
  await runCommand(mainCommand, { rawArgs: argv });
}

if (import.meta.main) {
  if (process.argv.slice(2).length === 0) {
    await autoRun();
  } else {
    await runMain(mainCommand);
  }
}
