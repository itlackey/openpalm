import { defineCommand } from 'citty';
import { existsSync } from 'node:fs';
import { classifyLocalInstall, composePs, buildComposeOptions, createState, deriveLaunchStatus, deriveLocalStackState, detectRuntime, initializeStateSecrets, parseEnvFile, resolveDefaultMigrateTarget, isComparableSemver, compareComparableVersions, formatForDisplay } from '@openpalm/lib';

/**
 * Best-effort "an update is available" advisory for `openpalm status`.
 *
 * Channel-correct: routes through resolveDefaultMigrateTarget, which applies the
 * same #494 stable-stays-stable policy the upgrade path uses (a stable install
 * never sees an rc as "available"). Written to STDERR so the stdout JSON stays
 * clean for scripts. Fully non-fatal — any failure (offline, not installed) is
 * swallowed so a status read never errors on the advisory.
 */
async function emitUpdateAdvisory(state: ReturnType<typeof createState>): Promise<void> {
  try {
    const stackEnvPath = `${state.stashDir}/env/stack.env`;
    if (!existsSync(stackEnvPath)) return;
    const currentTag = parseEnvFile(stackEnvPath).OP_IMAGE_TAG?.trim();
    if (!isComparableSemver(currentTag)) return;
    const latest = await resolveDefaultMigrateTarget(state);
    if (!isComparableSemver(latest)) return;
    if (compareComparableVersions(latest, currentTag!) > 0) {
      console.error(
        `An update is available: OpenPalm ${formatForDisplay(latest)} (you're on ${formatForDisplay(currentTag)}). Run \`openpalm update\`.`,
      );
    }
  } catch {
    // Advisory only — never let it affect the status read.
  }
}

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
      await emitUpdateAdvisory(state);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
