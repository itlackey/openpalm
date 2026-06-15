import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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
});
