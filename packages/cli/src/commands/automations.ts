import { defineCommand } from 'citty';
import {
  getAutomationRegistrationStatus,
  type AutomationRegistrationStatus,
  type ControlPlaneState,
} from '@openpalm/lib';
import { defineAction } from '../lib/action.ts';
import { ensureValidState } from '../lib/cli-state.ts';

type AutomationsCheckDeps = {
  getState: () => ControlPlaneState;
  inspect: (state: ControlPlaneState) => Promise<AutomationRegistrationStatus>;
};

const defaultDeps: AutomationsCheckDeps = {
  getState: ensureValidState,
  inspect: getAutomationRegistrationStatus,
};

export async function automationsCheck(deps: AutomationsCheckDeps = defaultDeps): Promise<void> {
  const status = await deps.inspect(deps.getState());
  if (!status.ok) {
    throw new Error(`Unable to inspect the Assistant scheduler: ${status.error}`);
  }
  if (status.configured.length === 0) {
    console.log('No automation tasks installed.');
    return;
  }

  console.log(`Found ${status.configured.length} automation task(s):`);
  for (const id of status.configured) {
    console.log(`  - ${id}`);
  }

  console.log(`Registered in Assistant scheduler: ${status.registered.length}/${status.configured.length}`);
  if (status.missing.length > 0) {
    console.log(`Not registered: ${status.missing.join(', ')}`);
  }
}

export default defineCommand({
  meta: {
    name: 'automations',
    description: 'Manage automation tasks',
  },
  subCommands: {
    check: defineCommand({
      meta: {
        name: 'check',
        description: 'Report automation task registration status',
      },
      run: defineAction(async () => {
        await automationsCheck();
      }),
    }),
  },
});
