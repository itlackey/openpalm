import { defineCommand } from 'citty';
import {
  getAddonServiceNames,
  listAvailableAddonIds,
  listEnabledAddonIds,
  setAddonEnabled,
} from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';
import { fullComposeArgs, runComposeWithPreflight } from '../lib/cli-compose.ts';
import { runDockerCompose } from '../lib/docker.ts';

function requireKnownAddon(name: string): void {
  const available = listAvailableAddonIds();
  if (!available.includes(name)) {
    throw new Error(`Addon "${name}" is not available. Known addons: ${available.join(', ') || '(none)'}`);
  }
}

export async function runAddonListAction(): Promise<void> {
  const state = ensureValidState();
  const enabled = new Set(listEnabledAddonIds(state.homeDir));
  const available = listAvailableAddonIds();

  if (available.length === 0) {
    console.log('No registry addons are available.');
    return;
  }

  for (const name of available) {
    console.log(`${enabled.has(name) ? '[enabled]' : '[disabled]'} ${name}`);
  }
}

export async function runAddonEnableAction(name: string): Promise<void> {
  requireKnownAddon(name);
  const state = ensureValidState();
  const mutation = setAddonEnabled(state.homeDir, state.vaultDir, name, true);
  if (!mutation.ok) throw new Error(mutation.error);

  if (!mutation.changed) {
    console.log(`Addon "${name}" is already enabled.`);
    return;
  }

  console.log(`Enabled addon "${name}".`);

  if (mutation.services.length === 0) return;

  try {
    const nextState = ensureValidState();
    await runComposeWithPreflight(nextState, ['up', '-d', ...mutation.services]);
    console.log(`Started services: ${mutation.services.join(', ')}`);
  } catch (err) {
    console.warn(
      `Warning: addon "${name}" was enabled but its services were not started automatically: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function runAddonDisableAction(name: string): Promise<void> {
  requireKnownAddon(name);
  const state = ensureValidState();
  const services = getAddonServiceNames(state.homeDir, name);
  const wasEnabled = listEnabledAddonIds(state.homeDir).includes(name);

  if (wasEnabled && services.length > 0) {
    try {
      await runDockerCompose([...fullComposeArgs(state), 'stop', ...services]);
      console.log(`Stopped services: ${services.join(', ')}`);
    } catch (err) {
      console.warn(
        `Warning: failed to stop services for addon "${name}" before disabling it: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const mutation = setAddonEnabled(state.homeDir, state.vaultDir, name, false);
  if (!mutation.ok) throw new Error(mutation.error);

  if (!mutation.changed) {
    console.log(`Addon "${name}" is already disabled.`);
    return;
  }

  console.log(`Disabled addon "${name}".`);
}

const enableCmd = defineCommand({
  meta: { name: 'enable', description: 'Enable a registry addon' },
  args: {
    name: { type: 'positional', description: 'Addon name', required: true },
  },
  async run({ args }) {
    const name = String(args._?.[0] ?? '').trim();
    if (!name) throw new Error('Addon name is required.');
    await runAddonEnableAction(name);
  },
});

const disableCmd = defineCommand({
  meta: { name: 'disable', description: 'Disable a registry addon' },
  args: {
    name: { type: 'positional', description: 'Addon name', required: true },
  },
  async run({ args }) {
    const name = String(args._?.[0] ?? '').trim();
    if (!name) throw new Error('Addon name is required.');
    await runAddonDisableAction(name);
  },
});

const listCmd = defineCommand({
  meta: { name: 'list', description: 'List registry addons and whether they are enabled' },
  async run() {
    await runAddonListAction();
  },
});

export default defineCommand({
  meta: {
    name: 'addon',
    description: 'Enable, disable, or list registry addons',
  },
  subCommands: {
    list: listCmd,
    enable: enableCmd,
    disable: disableCmd,
  },
});
