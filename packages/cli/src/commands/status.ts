import { defineCommand } from 'citty';
import { classifyLocalInstall, composePs, buildComposeOptions, deriveLaunchStatus, deriveLocalStackState, detectRuntime, parseComposePsRows } from '@openpalm/lib';
import { defineAction } from '../lib/action.ts';
import { resolveServeState } from '../lib/cli-state.ts';

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
        // parseComposePsRows is the lib's single source of truth for this parse
        // (docker.ts) — the local reimplementation this replaces missed the
        // JSON-array `compose ps` output shape some Compose versions emit,
        // which made a genuinely running stack classify as installed_offline.
        state: deriveLocalStackState(installState, ps.ok ? parseComposePsRows(ps.stdout) : []),
        runtime: installState === 'not_installed' ? await detectRuntime() : undefined,
        detail: { installState },
      },
      remotes: [],
    });
    console.log(JSON.stringify(launchStatus, null, 2));
  }),
});
