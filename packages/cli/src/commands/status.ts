import { defineCommand } from 'citty';
import { classifyLocalInstall, composePs, buildComposeOptions, deriveLaunchStatus, deriveLocalStackState, detectRuntime } from '@openpalm/lib';
import { defineAction } from '../lib/action.ts';
import { resolveServeState } from '../lib/cli-state.ts';

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
  run: defineAction(async () => {
    // resolveServeState migrates the home layout (best-effort) before the
    // reads below — a bare createState() on a pre-consolidation home would
    // resolve Compose with no env at all (no profiles, default project name).
    const state = resolveServeState();
    const installState = classifyLocalInstall(state.stackDir, state.homeDir);
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
  }),
});
