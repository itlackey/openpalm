import { defineCommand } from 'citty';
import {
  resolveDataDir,
  inspectInstallLock,
  unlockInstallLock,
  INSTALL_LOCK_STALE_AFTER_MS,
} from '@openpalm/lib';

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return 'unknown age';
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return 'less than a minute old';
  if (minutes === 1) return '1 minute old';
  return `${minutes} minutes old`;
}

export default defineCommand({
  meta: {
    name: 'unlock',
    description:
      'Clear a STALE install/upgrade lock if an operation crashed or was interrupted. Never removes a lock that a live install is still holding (use --force to override).',
  },
  args: {
    force: {
      type: 'boolean',
      description:
        'Clear the lock even if a process with the recorded PID is still alive. Use only when the PID was reused by an unrelated process, leaving a lock that can never clear itself.',
    },
  },
  async run({ args }) {
    const dataDir = resolveDataDir();
    const before = inspectInstallLock(dataDir);

    if (!before.present) {
      console.log('No install lock is set — nothing to clear.');
      return;
    }

    if (!before.stale && !args.force) {
      const staleMinutes = Math.round(INSTALL_LOCK_STALE_AFTER_MS / 60000);
      console.error(
        `An install or upgrade still appears to be running (lock at ${before.path}, ${formatAge(before.ageMs)}` +
          (before.pid ? `, process ${before.pid}` : '') +
          `). The lock will clear itself automatically once that process exits or after ${staleMinutes} minutes. ` +
          'Nothing was changed. If you are certain no install is running (e.g. the recorded PID was reused by an unrelated process), re-run with --force.',
      );
      process.exit(1);
    }

    const result = unlockInstallLock(dataDir, { force: args.force });
    if (result.ok && result.removed) {
      const forced = !before.stale && args.force;
      console.log(
        forced
          ? `Force-cleared the install lock (it was ${formatAge(before.ageMs)}` +
              (before.pid ? `, recorded PID ${before.pid}` : '') +
              `). You can run \`openpalm install\` or \`openpalm update\` again.`
          : `Cleared a stale install lock (it was ${formatAge(before.ageMs)}` +
              (before.pid ? ` and held by process ${before.pid}, which is no longer running` : '') +
              `). You can run \`openpalm install\` or \`openpalm update\` again.`,
      );
      return;
    }
    // unlockInstallLock re-checked and found it live (race) — treat like the live case.
    console.error('The lock became active again — an install/upgrade is running. Nothing was changed.');
    process.exit(1);
  },
});
