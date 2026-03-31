import { defineCommand } from 'citty';
import { listEnabledAddonIds } from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';
import { runAddonDisableAction, runAddonEnableAction } from './addon.ts';

async function runAdminStatusAction(): Promise<void> {
  const state = ensureValidState();
  const enabled = listEnabledAddonIds(state.homeDir).includes('admin');
  console.log(enabled ? 'Admin addon is enabled.' : 'Admin addon is disabled.');
}

const enableCmd = defineCommand({
  meta: { name: 'enable', description: 'Enable the admin addon' },
  async run() {
    await runAddonEnableAction('admin');
  },
});

const disableCmd = defineCommand({
  meta: { name: 'disable', description: 'Disable the admin addon' },
  async run() {
    await runAddonDisableAction('admin');
  },
});

const statusCmd = defineCommand({
  meta: { name: 'status', description: 'Show whether the admin addon is enabled' },
  async run() {
    await runAdminStatusAction();
  },
});

export default defineCommand({
  meta: {
    name: 'admin',
    description: 'Enable, disable, or inspect the admin addon',
  },
  subCommands: {
    enable: enableCmd,
    disable: disableCmd,
    status: statusCmd,
  },
});
