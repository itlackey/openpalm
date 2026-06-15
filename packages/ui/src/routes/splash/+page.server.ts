import { deriveLaunchStatus, deriveLocalStackState, classifyLocalInstall, composePs, buildComposeOptions, detectRuntime, ensureMigrated, MigrationError } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { listRemoteStatuses } from '$lib/server/endpoints.js';

/**
 * Migration awareness for the landing page. A cheap dry-run (no lock, no backup,
 * writes nothing) reports whether the home needs migrating before the user can
 * safely continue — and surfaces the fail-loud UnrecognizedLayoutError/MigrationError
 * as an attention state instead of crashing the page.
 */
export type MigrationStatus =
  | { status: 'none' }
  | { status: 'pending'; from: number; to: number; applied: string[]; releaseApplied: string[]; notes: string[]; lines: string[] }
  | { status: 'error'; message: string; guidance: string };

function detectMigration(homeDir: string): MigrationStatus {
  const lines: string[] = [];
  try {
    const report = ensureMigrated({ homeDir, dryRun: true, log: (m) => lines.push(m) });
    // "Pending" means real migration work would run, not just a version stamp.
    const pending = report.applied.length > 0 || report.releaseApplied.length > 0;
    if (!pending) return { status: 'none' };
    return {
      status: 'pending',
      from: report.from,
      to: report.to,
      applied: report.applied,
      releaseApplied: report.releaseApplied,
      notes: report.notes,
      lines,
    };
  } catch (e) {
    if (e instanceof MigrationError) {
      return { status: 'error', message: e.message, guidance: e.guidance };
    }
    throw e;
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

export async function load() {
  const state = getState();
  const installState = classifyLocalInstall(state.stackDir);
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
    migration: detectMigration(state.homeDir),
  };
}
