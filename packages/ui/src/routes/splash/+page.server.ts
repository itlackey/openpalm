import { deriveLaunchStatus, deriveLocalStackState, classifyLocalInstall, composePs, buildComposeOptions, detectRuntime } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { listRemoteStatuses } from '$lib/server/endpoints.js';

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

export async function load() {
  const state = getState();
  const installState = classifyLocalInstall(state.stackDir, state.homeDir);
  const composeResult = await composePs(buildComposeOptions(state));
  const localState = deriveLocalStackState(installState, composeResult.ok ? parseComposePsServices(composeResult.stdout) : []);
  return {
    launchStatus: deriveLaunchStatus({
      local: {
        state: localState,
        runtime: installState === 'not_installed' ? await detectRuntime() : undefined,
        detail: { installState },
      },
      remotes: await listRemoteStatuses(),
    }),
  };
}
