import { defineCommand } from 'citty';
import { classifyLocalInstall, composePs, buildComposeOptions, createState, deriveLaunchStatus, deriveLocalStackState, detectRuntime, initializeStateSecrets } from '@openpalm/lib';

function parseComposePsServices(stdout: string) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return [{
          service: String(parsed.Service ?? parsed.Name ?? ''),
          state: String(parsed.State ?? ''),
          health: String(parsed.Health ?? ''),
        }];
      } catch {
        return [];
      }
    });
}

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Show container status',
  },
  async run() {
    try {
      const state = createState();
      initializeStateSecrets(state);
      const installState = classifyLocalInstall(state.stackDir);
      const ps = await composePs(buildComposeOptions(state));
      const launchStatus = deriveLaunchStatus({
        local: {
          state: deriveLocalStackState(installState, ps.ok ? parseComposePsServices(ps.stdout) : []),
          runtime: installState === 'not_installed' ? await detectRuntime() : undefined,
          detail: { installState },
        },
        remotes: [],
      });
      console.log(JSON.stringify(launchStatus, null, 2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
