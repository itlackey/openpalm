/**
 * 0.4 (X15 urgent half, verification "most-dangerous #4"): `--force` install
 * calls `pruneBackupDirs(homeDir, 3)` right after taking a fresh backup
 * (install.ts:201). Older backups beyond the retention window may be the
 * ONLY recovery copy of data destructively lost elsewhere (secret-strip 0.1,
 * moderation.md clobber 1.2) — a pre-rollback or pre-update safety snapshot
 * must never be silently deleted just because it fell outside the last-N
 * window. Protect those by name so pruning never touches them, regardless of
 * age or the `keep` count passed in.
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
  it('never deletes *-pre-rollback or *-pre-update directories, even when older than the retention window', () => {
    // Oldest to newest plain (unprotected) backups.
    makeBackup('2020-01-01T00-00-00-000Z');
    makeBackup('2020-01-02T00-00-00-000Z');
    makeBackup('2020-01-03T00-00-00-000Z');
    makeBackup('2020-01-04T00-00-00-000Z');
    // Protected safety snapshots — oldest of all, would be first evicted by a
    // naive keep-N-by-recency prune.
    makeBackup('2019-01-01T00-00-00-000Z-pre-rollback');
    makeBackup('2019-01-01T00-00-00-000Z-pre-update');

    const deleted = pruneBackupDirs(homeDir, 2);

    expect(deleted.some((p) => p.includes('pre-rollback'))).toBe(false);
    expect(deleted.some((p) => p.includes('pre-update'))).toBe(false);
    expect(existsSync(join(backupsDir, '2019-01-01T00-00-00-000Z-pre-rollback'))).toBe(true);
    expect(existsSync(join(backupsDir, '2019-01-01T00-00-00-000Z-pre-update'))).toBe(true);

    // The plain backups still obey keep=2 (the two newest survive).
    const remaining = readdirSync(backupsDir).sort();
    expect(remaining).toContain('2020-01-03T00-00-00-000Z');
    expect(remaining).toContain('2020-01-04T00-00-00-000Z');
    expect(remaining).not.toContain('2020-01-01T00-00-00-000Z');
    expect(remaining).not.toContain('2020-01-02T00-00-00-000Z');
  });
});
