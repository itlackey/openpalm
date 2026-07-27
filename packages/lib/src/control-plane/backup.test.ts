/**
 * S5 — backup lifecycle defects (placement/atomicity/prune).
 *
 * backup.ts already correctly EXCLUDES data/ from the safety snapshot (not
 * covered here — see backup-space.test.ts). These tests cover what remains:
 *   - pruneBackupDirs/listBackupDirs order by mtime, not lexicographically,
 *     and treat plain-timestamp / ui-* / skeleton-* as separate namespaces
 *     so each is retained (and pruned) independently.
 *   - backupOpenPalmHome writes atomically (staging dir + completion marker +
 *     rename) so a mid-copy failure never leaves a torn final dir.
 *   - the free-space guard actually runs before any mutation, measures the
 *     DESTINATION filesystem, and fails closed when unmeasurable.
 *   - the backup destination is configurable (OP_BACKUP_DIR) and defaults to
 *     data/backups when unset.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKUP_COMPLETE_MARKER,
  backupOpenPalmHome,
  checkBackupFreeSpace,
  listBackupDirs,
  pruneBackupDirs,
} from './backup.js';

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-backup-lifecycle-'));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  delete process.env.OP_BACKUP_DIR;
});

function makeBackupDir(backupsDir: string, name: string, mtimeMsAgo: number): string {
  const dir = join(backupsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'marker.txt'), name);
  const t = new Date(Date.now() - mtimeMsAgo);
  utimesSync(dir, t, t);
  return dir;
}

describe('listBackupDirs orders by mtime, not name', () => {
  it('returns newest-first by mtime even when directory names sort the other way', () => {
    const backupsDir = join(homeDir, 'data', 'backups');
    mkdirSync(backupsDir, { recursive: true });
    // 'z-older' alphabetically outranks 'a-newer', but is in fact OLDER.
    const older = makeBackupDir(backupsDir, 'z-older', 10_000);
    const newer = makeBackupDir(backupsDir, 'a-newer', 0);

    expect(listBackupDirs(homeDir)).toEqual([newer, older]);
  });
});

describe('pruneBackupDirs keeps the N newest by mtime, per namespace', () => {
  it('separates plain-timestamp, ui-*, and skeleton-* namespaces so each is retained independently', () => {
    const backupsDir = join(homeDir, 'data', 'backups');
    mkdirSync(backupsDir, { recursive: true });

    // Names deliberately sort the OPPOSITE way from their mtime, so a
    // lexicographic prune (the pre-fix behavior) would keep the wrong two.
    const t1 = makeBackupDir(backupsDir, 't-1', 0); // newest
    const t2 = makeBackupDir(backupsDir, 't-2', 1_000);
    const t3 = makeBackupDir(backupsDir, 't-3', 2_000);
    const t4 = makeBackupDir(backupsDir, 't-4', 3_000); // oldest

    const ui1 = makeBackupDir(backupsDir, 'ui-1', 0); // newest ui-*
    const ui2 = makeBackupDir(backupsDir, 'ui-2', 1_000);
    const ui3 = makeBackupDir(backupsDir, 'ui-3', 2_000); // oldest ui-*

    const skel1 = makeBackupDir(backupsDir, 'skeleton-1', 0);
    const skel2 = makeBackupDir(backupsDir, 'skeleton-2', 1_000);

    const deleted = pruneBackupDirs(homeDir, 2);

    // Plain timestamp namespace: 2 newest survive, 2 oldest pruned.
    expect(existsSync(t1)).toBe(true);
    expect(existsSync(t2)).toBe(true);
    expect(existsSync(t3)).toBe(false);
    expect(existsSync(t4)).toBe(false);

    // ui-* is its OWN namespace — pruned down to 2 newest, not left unpruned
    // and not merged into the timestamp cutoff.
    expect(existsSync(ui1)).toBe(true);
    expect(existsSync(ui2)).toBe(true);
    expect(existsSync(ui3)).toBe(false);

    // skeleton-* namespace only has 2 entries — keep=2 prunes nothing.
    expect(existsSync(skel1)).toBe(true);
    expect(existsSync(skel2)).toBe(true);

    expect(deleted.sort()).toEqual([t3, t4, ui3].sort());
  });
});

describe('backupOpenPalmHome atomicity', () => {
  it('writes a completion marker and leaves no staging dir on success', () => {
    mkdirSync(join(homeDir, 'config'), { recursive: true });
    writeFileSync(join(homeDir, 'config', 'a.txt'), 'hello');

    const backupDir = backupOpenPalmHome(homeDir);
    expect(backupDir).not.toBeNull();
    expect(existsSync(join(backupDir as string, BACKUP_COMPLETE_MARKER))).toBe(true);

    const backupsDir = join(homeDir, 'data', 'backups');
    const siblings = readdirSync(backupsDir);
    expect(siblings.some((n) => n.startsWith('.staging-'))).toBe(false);
  });

  it('leaves no torn final dir (and no leftover staging dir) when a copy fails partway through', () => {
    mkdirSync(join(homeDir, 'config'), { recursive: true });
    writeFileSync(join(homeDir, 'config', 'a.txt'), 'hello');
    mkdirSync(join(homeDir, 'system'), { recursive: true });
    writeFileSync(join(homeDir, 'system', 'b.txt'), 'world');

    let calls = 0;
    const throwingCopy = (source: string, target: string) => {
      calls += 1;
      if (calls === 2) throw new Error('simulated disk failure mid-copy');
      cpSync(source, target, { recursive: true });
    };

    expect(() => backupOpenPalmHome(homeDir, { copyEntry: throwingCopy })).toThrow(
      'simulated disk failure mid-copy',
    );

    const backupsDir = join(homeDir, 'data', 'backups');
    const remaining = existsSync(backupsDir) ? readdirSync(backupsDir) : [];
    expect(remaining).toEqual([]);
  });
});

describe('backupOpenPalmHome space guard', () => {
  it('refuses to back up (fails closed) when the destination has insufficient free space', () => {
    writeFileSync(join(homeDir, 'big.bin'), 'x'.repeat(10_000));

    expect(() => backupOpenPalmHome(homeDir, { threshold: 0 })).toThrow(/space/i);
    // Nothing was written — the guard runs before any mutation.
    expect(existsSync(join(homeDir, 'data', 'backups'))).toBe(false);
  });
});

describe('checkBackupFreeSpace destination measurement', () => {
  it('fails closed when the destination cannot be measured', () => {
    const missingDest = join(homeDir, 'nowhere', 'nested');
    const check = checkBackupFreeSpace(homeDir, 0.8, missingDest);
    expect(check.measurementFailed).toBe(true);
    expect(check.insufficient).toBe(true);
  });

  it('measures a real destination independently of homeDir', () => {
    const dest = mkdtempSync(join(tmpdir(), 'openpalm-backup-dest-'));
    try {
      const check = checkBackupFreeSpace(homeDir, 0.8, dest);
      expect(check.measurementFailed).toBe(false);
      expect(Number.isFinite(check.freeBytes)).toBe(true);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});

describe('configurable backup destination', () => {
  it('defaults to <home>/data/backups when OP_BACKUP_DIR is unset', () => {
    delete process.env.OP_BACKUP_DIR;
    mkdirSync(join(homeDir, 'config'), { recursive: true });
    writeFileSync(join(homeDir, 'config', 'a.txt'), 'hi');

    const backupDir = backupOpenPalmHome(homeDir);
    expect(backupDir).not.toBeNull();
    expect((backupDir as string).startsWith(join(homeDir, 'data', 'backups'))).toBe(true);
  });

  it('honors OP_BACKUP_DIR, placing backups outside OP_HOME entirely', () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'openpalm-external-backup-'));
    process.env.OP_BACKUP_DIR = externalDir;
    try {
      mkdirSync(join(homeDir, 'config'), { recursive: true });
      writeFileSync(join(homeDir, 'config', 'a.txt'), 'hi');

      const backupDir = backupOpenPalmHome(homeDir);
      expect(backupDir).not.toBeNull();
      expect((backupDir as string).startsWith(externalDir)).toBe(true);
      // The default location was never created.
      expect(existsSync(join(homeDir, 'data', 'backups'))).toBe(false);

      expect(listBackupDirs(homeDir)).toEqual([backupDir]);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });
});
