import { defineCommand } from 'citty';
import { join } from 'node:path';
import {
  performUpgrade,
  classifyLocalInstall,
  createState,
  type ControlPlaneState,
} from '@openpalm/lib';
import { defineAction } from '../lib/action.ts';

export default defineCommand({
  meta: {
    name: 'update',
    description: 'Refresh stack assets and safely reapply running containers',
  },
  run: defineAction(
    async () => {
      await runUpgradeAction();
    },
    (message) => {
      console.error(message);
      console.error('If something went wrong, your previous state was backed up before this update — run `openpalm rollback` to restore it.');
    },
  ),
});

export async function runUpgradeAction(): Promise<void> {
  const state = resolveUpgradeState();

  console.log('Updating stack...');
  await performUpgrade(state);

  // The UI build ships INSIDE this binary now (see embedded-assets.ts) — the
  // running `openpalm`/`openpalm admin` supervisor materializes it into
  // data/ui on its next spawn. Updating the CLI itself means replacing the
  // binary (see the install docs), not downloading a separate UI release.
  console.log('Update complete. To update the CLI itself, install a newer openpalm binary.');
}

export function resolveUpgradeState(): ControlPlaneState {
  const state = createState();
  const currentInstall = classifyLocalInstall(state.stackDir, state.homeDir);
  const legacyStackDir = join(state.homeDir, 'config', 'stack');
  const legacyInstall = classifyLocalInstall(legacyStackDir, state.homeDir);
  if (currentInstall === 'not_installed' && legacyInstall === 'not_installed') {
    throw new Error('OpenPalm is not installed in this OP_HOME yet. Run `openpalm install` first.');
  }
  return state;
}
