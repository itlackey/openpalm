/**
 * 0.4 (X15 urgent half, verification "most-dangerous #4"): `--force` install
 * calls `pruneBackupDirs(homeDir, 3)` right after taking a fresh backup
 * (install.ts:201). Older backups beyond the retention window may be the
 * ONLY recovery copy of data destructively lost elsewhere (secret-strip 0.1,
 * moderation.md clobber 1.2) — a `-pre-update` safety snapshot must never be
 * silently deleted just because it fell outside the last-N window. Protect
 * that one by name so pruning never touches it, regardless of age or the
 * `keep` count passed in.
 *
 * `-pre-rollback` is deliberately NOT in that protected set (#657 pt.2):
 * nothing capped it before, so a stack that kept failing and retrying
 * `openpalm rollback` grew an unbounded run of them (backups.ts said "never
 * pruned by anything," which was the bug, not a guarantee). It is its own
 * per-namespace retention bucket instead — capped like `ui-*`/`skeleton-*`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneBackupDirs } from './backup.js';

let homeDir: string;
let backupsDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-backup-prune-'));
  backupsDir = join(homeDir, 'data', 'backups');
  mkdirSync(backupsDir, { recursive: true });
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

function makeBackup(name: string): void {
  const dir = join(backupsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
}

describe('pruneBackupDirs protects recovery backups', () => {
  it('never deletes a *-pre-update directory, even when older than the retention window', () => {
    // Oldest to newest plain (unprotected) backups.
    makeBackup('2020-01-01T00-00-00-000Z');
    makeBackup('2020-01-02T00-00-00-000Z');
    makeBackup('2020-01-03T00-00-00-000Z');
    makeBackup('2020-01-04T00-00-00-000Z');
    // The one permanently-protected safety snapshot — oldest of all, would be
    // first evicted by a naive keep-N-by-recency prune.
    makeBackup('2019-01-01T00-00-00-000Z-pre-update');
    // A single -pre-rollback: within its own namespace's keep=2, so this
    // alone does not prove capping — see the next test for that.
    makeBackup('2019-01-01T00-00-00-000Z-pre-rollback');

    const deleted = pruneBackupDirs(homeDir, 2);

    expect(deleted.some((p) => p.includes('pre-update'))).toBe(false);
    expect(deleted.some((p) => p.includes('pre-rollback'))).toBe(false);
    expect(existsSync(join(backupsDir, '2019-01-01T00-00-00-000Z-pre-update'))).toBe(true);
    expect(existsSync(join(backupsDir, '2019-01-01T00-00-00-000Z-pre-rollback'))).toBe(true);

    // The plain backups still obey keep=2 (the two newest survive).
    const remaining = readdirSync(backupsDir).sort();
    expect(remaining).toContain('2020-01-03T00-00-00-000Z');
    expect(remaining).toContain('2020-01-04T00-00-00-000Z');
    expect(remaining).not.toContain('2020-01-01T00-00-00-000Z');
    expect(remaining).not.toContain('2020-01-02T00-00-00-000Z');
  });

  it('#657 pt.2 — caps *-pre-rollback backups like any other namespace instead of keeping them all forever', () => {
    // Four -pre-rollback snapshots, oldest to newest — the exact shape a
    // stack that keeps failing and retrying `openpalm rollback` produces.
    // Before this fix, backups.ts's own --help text said these are "never
    // pruned by anything," and pruneBackupDirs made that literally true.
    makeBackup('2020-01-01T00-00-00-000Z-pre-rollback');
    makeBackup('2020-01-02T00-00-00-000Z-pre-rollback');
    makeBackup('2020-01-03T00-00-00-000Z-pre-rollback');
    makeBackup('2020-01-04T00-00-00-000Z-pre-rollback');
    // The permanently-protected one survives regardless.
    makeBackup('2019-01-01T00-00-00-000Z-pre-update');

    const deleted = pruneBackupDirs(homeDir, 2, 'pre-rollback');

    expect(deleted.sort()).toEqual(
      [
        join(backupsDir, '2020-01-01T00-00-00-000Z-pre-rollback'),
        join(backupsDir, '2020-01-02T00-00-00-000Z-pre-rollback'),
      ].sort(),
    );
    const remaining = readdirSync(backupsDir).sort();
    expect(remaining).toContain('2020-01-03T00-00-00-000Z-pre-rollback');
    expect(remaining).toContain('2020-01-04T00-00-00-000Z-pre-rollback');
    expect(remaining).toContain('2019-01-01T00-00-00-000Z-pre-update');
  });
});
