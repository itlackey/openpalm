/**
 * S5 — backup lifecycle defects (placement/atomicity/prune).
 *
 * The wholesale data/ + cache/ exclusion is covered in backup-space.test.ts,
 * where the estimate that must mirror it lives. These tests cover what remains:
 *   - pruneBackupDirs/listBackupDirs order by mtime, not lexicographically,
 *     and treat plain-timestamp / ui-* / skeleton-* as separate namespaces
 *     so each is retained (and pruned) independently.
 *   - backupOpenPalmHome writes atomically (staging dir + completion marker +
 *     rename) so a mid-copy failure never leaves a torn final dir.
 *   - the free-space guard actually runs before any mutation, measures the
 *     DESTINATION filesystem, and fails closed when unmeasurable.
 *   - the backup destination is configurable (OP_BACKUP_DIR) and defaults to
 *     data/backups when unset.
 *   - a service's data and its credentials are one restore unit (§5, G5): the
 *     credentials of a service whose data/ tree is out of scope leave with it,
 *     and the completion marker names them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  estimateHomeBackupBytes,
  listBackupDirs,
  planBackupPrune,
  pruneBackupDirs,
} from './backup.js';

// chmod 0 only blocks a NON-root process; root bypasses DAC permission checks
// entirely, so the two #642 reproductions below need to run unprivileged to
// actually hit EACCES. Same guard style as
// config-persistence-operator-ids.test.ts, inverted: that suite needs root,
// these need to NOT be root.
function isRootProcess(): boolean {
  return process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0;
}

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

describe('planBackupPrune previews exactly what pruneBackupDirs deletes', () => {
  it('agrees with the real prune, and never lists a protected recovery snapshot', () => {
    const backupsDir = join(homeDir, 'data', 'backups');
    mkdirSync(backupsDir, { recursive: true });

    // A mix that a global `listBackupDirs().slice(keep)` preview gets wrong in
    // BOTH directions: it would list the protected snapshots for deletion, and
    // omit ui-2 (which per-namespace retention actually deletes).
    makeBackupDir(backupsDir, 't-1', 0); // newest timestamp — kept
    const t2 = makeBackupDir(backupsDir, 't-2', 1_000);
    const t3 = makeBackupDir(backupsDir, 't-3', 2_000);
    makeBackupDir(backupsDir, 'ui-1', 0); // newest ui-* — kept
    const ui2 = makeBackupDir(backupsDir, 'ui-2', 1_000);
    const guarded1 = makeBackupDir(backupsDir, 'x-pre-rollback', 5_000);
    const guarded2 = makeBackupDir(backupsDir, 'y-pre-update', 6_000);

    // keep=1 per namespace: t-1 and ui-1 survive; everything older in each
    // namespace goes; the two recovery snapshots are excluded entirely.
    const plan = planBackupPrune(homeDir, 1);
    expect(plan.toDelete.sort()).toEqual([t2, t3, ui2].sort());
    expect(plan.protected.sort()).toEqual([guarded1, guarded2].sort());

    // The preview is the contract: what it lists is exactly what gets deleted.
    const deleted = pruneBackupDirs(homeDir, 1);
    expect(deleted.sort()).toEqual(plan.toDelete.sort());
    expect(existsSync(guarded1)).toBe(true);
    expect(existsSync(guarded2)).toBe(true);
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

describe('backupOpenPalmHome tolerates unreadable files (#642)', () => {
  // #642: an operator-created root-owned file anywhere under OP_HOME (e.g. a
  // `sudo cp state/stack.env state/stack.env.bak` left behind before a hand
  // edit) previously threw EACCES on the first unreadable entry and aborted
  // `openpalm update` entirely, mid-way through applying managed files. One
  // stray backup artifact should not block the whole update.
  it('skips an unreadable non-essential file, names it in the marker, and still completes the backup', () => {
    if (isRootProcess()) return; // see isRootProcess() docblock above
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(join(homeDir, 'state', 'stack.env'), 'OP_HOME=x\n');
    const blocked = join(homeDir, 'state', 'stack.env.bak-portfix-test');
    writeFileSync(blocked, 'OP_ENABLED_ADDONS=old\n');
    chmodSync(blocked, 0o000); // unreadable, simulating a root-owned sudo artifact

    try {
      const backupDir = backupOpenPalmHome(homeDir);
      expect(backupDir).not.toBeNull();
      if (backupDir === null) return; // narrow for TS
      // The file this backup actually needs still made it in.
      expect(existsSync(join(backupDir, 'state', 'stack.env'))).toBe(true);
      // The unreadable one was skipped, not fatal.
      expect(existsSync(join(backupDir, 'state', 'stack.env.bak-portfix-test'))).toBe(false);
      const marker = readFileSync(join(backupDir, BACKUP_COMPLETE_MARKER), 'utf-8');
      expect(marker).toContain('state/stack.env.bak-portfix-test');
    } finally {
      chmodSync(blocked, 0o600); // restore so afterEach's rmSync(homeDir) can clean up
    }
  });

  it('fails loud, naming the path, when a file the restore genuinely needs is unreadable', () => {
    if (isRootProcess()) return; // see isRootProcess() docblock above
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    const stackEnv = join(homeDir, 'state', 'stack.env');
    writeFileSync(stackEnv, 'OP_HOME=x\n');
    chmodSync(stackEnv, 0o000);

    try {
      // Not just "it throws" (a raw EACCES already did, pre-fix) — the message
      // must be the actionable one naming the exact path and the reason it
      // matters, distinguishing "genuinely needed, fails loud" from the
      // tolerant skip-and-warn path the previous test exercises.
      expect(() => backupOpenPalmHome(homeDir)).toThrow(
        /Backup staging cannot read .*state\/stack\.env.*openpalm rollback/,
      );
    } finally {
      chmodSync(stackEnv, 0o600); // restore so afterEach's rmSync(homeDir) can clean up
    }
  });
});

describe('a service\'s data and credentials are one restore unit', () => {
  it('leaves out the credentials of a service whose data/ tree is out of scope, and names them in the marker', () => {
    // Paperclip: data/paperclip is skipped wholesale, so state/env/paperclip.env
    // (BETTER_AUTH_SECRET) must not be snapshotted alone — restoring it without
    // the database is the G5 trap.
    mkdirSync(join(homeDir, 'data', 'paperclip'), { recursive: true });
    writeFileSync(join(homeDir, 'data', 'paperclip', 'postgres.db'), 'rows');
    mkdirSync(join(homeDir, 'state', 'env'), { recursive: true });
    writeFileSync(join(homeDir, 'state', 'env', 'paperclip.env'), 'BETTER_AUTH_SECRET=secret\n');
    // The rest of state/ is control-plane, not service-owned: it stays.
    mkdirSync(join(homeDir, 'state', 'secrets'), { recursive: true });
    writeFileSync(join(homeDir, 'state', 'secrets', 'op_ui_login_password'), 'pw');
    writeFileSync(join(homeDir, 'state', 'stack.env'), 'OP_HOME=x\n');

    const backupDir = backupOpenPalmHome(homeDir) as string;
    expect(existsSync(join(backupDir, 'state', 'env', 'paperclip.env'))).toBe(false);
    expect(existsSync(join(backupDir, 'state', 'secrets', 'op_ui_login_password'))).toBe(true);
    expect(existsSync(join(backupDir, 'state', 'stack.env'))).toBe(true);
    expect(existsSync(join(backupDir, 'data'))).toBe(false);

    // The snapshot says what it does not contain.
    expect(readFileSync(join(backupDir, BACKUP_COMPLETE_MARKER), 'utf-8')).toContain(
      join('state', 'env', 'paperclip.env'),
    );

    // The estimator uses the same scope, so the space guard cannot count bytes
    // the copy never writes.
    expect(estimateHomeBackupBytes(homeDir)).toBe(
      'pw'.length + 'OP_HOME=x\n'.length,
    );
  });

  it('keeps a state/env file that pairs with no out-of-scope service', () => {
    mkdirSync(join(homeDir, 'state', 'env'), { recursive: true });
    writeFileSync(join(homeDir, 'state', 'env', 'orphan.env'), 'KEY=value\n');

    const backupDir = backupOpenPalmHome(homeDir) as string;
    expect(existsSync(join(backupDir, 'state', 'env', 'orphan.env'))).toBe(true);
    expect(readFileSync(join(backupDir, BACKUP_COMPLETE_MARKER), 'utf-8')).not.toContain('Skipped');
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
