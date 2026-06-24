/**
 * Shared on-disk migration detection for the launch flow.
 *
 * A cheap `ensureMigrated` DRY RUN (no lock, no backup, writes nothing) reports
 * whether the home needs migrating before the user can safely continue, and
 * surfaces the fail-loud UnrecognizedLayoutError/MigrationError as an attention
 * state. Used by BOTH the splash page load (to render the migration card) and the
 * launch-routing guard (to force the user onto /splash even when the stack is
 * otherwise healthy) — one source of truth, no duplicated logic.
 */
import { ensureMigrated, isSkeletonStale, MigrationError } from '@openpalm/lib';

export type MigrationStatus =
  | { status: 'none' }
  | { status: 'pending'; from: number; to: number; applied: string[]; releaseApplied: string[]; notes: string[] }
  | { status: 'error'; message: string; guidance: string };

export function detectMigration(homeDir: string): MigrationStatus {
  try {
    const report = ensureMigrated({ homeDir, dryRun: true });
    // "Pending" means real reconcile work would run. Two triggers, both healed by
    // the one "apply" button (applyHomeReconcile): a layout/release migration, OR
    // the home was seeded by a different platform version than the one now running
    // (binary updated, assets/secrets not yet applied — the case the per-request
    // self-heal used to silently paper over).
    const pending = report.applied.length > 0 || report.releaseApplied.length > 0 || isSkeletonStale(homeDir);
    if (!pending) return { status: 'none' };
    return {
      status: 'pending',
      from: report.from,
      to: report.to,
      applied: report.applied,
      releaseApplied: report.releaseApplied,
      notes: report.notes,
    };
  } catch (e) {
    if (e instanceof MigrationError) {
      return { status: 'error', message: e.message, guidance: e.guidance };
    }
    throw e;
  }
}

/**
 * True when a migration is pending OR the home can't be read — both are states
 * that must land the user on /splash before they can use the assistant, even if
 * the stack is running or a healthy remote is configured.
 */
export function isMigrationBlocking(homeDir: string): boolean {
  const s = detectMigration(homeDir);
  return s.status === 'pending' || s.status === 'error';
}
