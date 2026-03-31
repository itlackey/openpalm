#!/usr/bin/env bun
import { defineCommand, runCommand, runMain } from 'citty';
import cliPkg from '../package.json' with { type: 'json' };

// Re-export public API used by tests and external consumers
export { detectHostInfo } from './lib/host-info.ts';
export type { HostInfo } from './lib/host-info.ts';
export { upsertEnvValue, resolveRequestedImageTag, reconcileStackEnvImageTag } from './lib/env.ts';
export { bootstrapInstall } from './commands/install.ts';

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
    upgrade: () => import('./commands/upgrade.ts').then((m) => m.default),
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
  },
});

/**
 * Programmatic entry point for tests and embedding.
 * Uses runCommand directly (not runMain) to avoid the process.exit(1) wrapper
 * and process.argv manipulation.
 */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  await runCommand(mainCommand, { rawArgs: argv });
}

if (import.meta.main) {
  await runMain(mainCommand);
}
