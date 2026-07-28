import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backupOpenPalmHome,
  estimateHomeBackupBytes,
  checkBackupFreeSpace,
  describeBackupSpaceShortfall,
} from './backup.js';

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-backup-space-'));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe('#499 pre-backup free-space check', () => {
  it('estimates the home size excluding the backups directory', () => {
    mkdirSync(join(homeDir, 'config'), { recursive: true });
    writeFileSync(join(homeDir, 'config', 'a.txt'), 'x'.repeat(1000));
    mkdirSync(join(homeDir, 'data', 'backups', 'old'), { recursive: true });
    writeFileSync(join(homeDir, 'data', 'backups', 'old', 'big.bin'), 'y'.repeat(50_000));

    const bytes = estimateHomeBackupBytes(homeDir);
    // counts config/a.txt (1000) but NOT the 50k under data/backups
    expect(bytes).toBeGreaterThanOrEqual(1000);
    expect(bytes).toBeLessThan(50_000);
  });

  it('flags insufficient when the estimate exceeds the threshold of free space', () => {
    writeFileSync(join(homeDir, 'big.bin'), 'z'.repeat(10_000));
    // threshold of 0 means any nonzero estimate exceeds 0% of free space
    const check = checkBackupFreeSpace(homeDir, 0);
    expect(check.insufficient).toBe(true);
    expect(check.estimatedBytes).toBeGreaterThan(0);
    expect(describeBackupSpaceShortfall(check)).toContain('Nothing was changed or deleted');
  });

  it('does not flag when free space is ample (default threshold)', () => {
    writeFileSync(join(homeDir, 'small.txt'), 'hello');
    const check = checkBackupFreeSpace(homeDir);
    expect(check.insufficient).toBe(false);
  });

  it('excludes the entire data/ tree, not just data/backups, from the estimate', () => {
    // A large file under data/assistant (regenerable runtime state, e.g. node_modules
    // caches / opencode SQLite) that backupOpenPalmHome never copies (it skips the
    // whole top-level "data" entry). The estimate must mirror that exclusion, or the
    // space guard will refuse tiny legitimate backups whenever data/ happens to be large.
    mkdirSync(join(homeDir, 'data', 'assistant'), { recursive: true });
    writeFileSync(join(homeDir, 'data', 'assistant', 'huge.bin'), 'a'.repeat(200_000));

    mkdirSync(join(homeDir, 'config'), { recursive: true });
    writeFileSync(join(homeDir, 'config', 'small.txt'), 'b'.repeat(500));

    const bytes = estimateHomeBackupBytes(homeDir);
    expect(bytes).toBeGreaterThanOrEqual(500);
    expect(bytes).toBeLessThan(200_000);
  });

  it('excludes the S1 cache/ tree from both the estimate and the copy', () => {
    // cache/ is regenerable by definition (bun/npm/opencode caches relocated
    // out of durable data/). If a backup copied it, safety snapshots would
    // reacquire exactly the multi-GB bloat #581 AC4 removed.
    mkdirSync(join(homeDir, 'cache', 'assistant'), { recursive: true });
    writeFileSync(join(homeDir, 'cache', 'assistant', 'huge.bin'), 'a'.repeat(200_000));

    mkdirSync(join(homeDir, 'config'), { recursive: true });
    writeFileSync(join(homeDir, 'config', 'small.txt'), 'b'.repeat(500));

    expect(estimateHomeBackupBytes(homeDir)).toBeLessThan(200_000);

    const backupDir = backupOpenPalmHome(homeDir);
    expect(backupDir).not.toBeNull();
    expect(existsSync(join(backupDir as string, 'config', 'small.txt'))).toBe(true);
    expect(existsSync(join(backupDir as string, 'cache'))).toBe(false);
  });

  it('does not refuse a real backup under disk pressure when only data/ is large', () => {
    mkdirSync(join(homeDir, 'data', 'assistant'), { recursive: true });
    writeFileSync(join(homeDir, 'data', 'assistant', 'huge.bin'), 'a'.repeat(200_000));

    mkdirSync(join(homeDir, 'config'), { recursive: true });
    writeFileSync(join(homeDir, 'config', 'small.txt'), 'b'.repeat(500));

    // Simulate disk pressure by measuring against the small config/ copy alone
    // (what actually gets written), not against the huge never-copied data/ tree:
    // a threshold tight enough that including data/'s bytes would flip this to
    // insufficient, but excluding them (as backupOpenPalmHome's copy scope does)
    // must not.
    const check = checkBackupFreeSpace(homeDir, 0.8);
    expect(check.estimatedBytes).toBeLessThan(200_000);
    expect(check.insufficient).toBe(false);

    const backupDir = backupOpenPalmHome(homeDir);
    expect(backupDir).not.toBeNull();
    // The huge data/ file must not have been copied into the backup.
    expect(existsSync(join(backupDir as string, 'data'))).toBe(false);
  });
});
