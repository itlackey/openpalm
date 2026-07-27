import { describe, expect, it } from 'bun:test';
import {
  checkDiskHeadroom,
  describeDiskHeadroom,
  shouldBlockOnDiskHeadroom,
  DEFAULT_LOW_THRESHOLD_BYTES,
} from './disk-headroom.js';

// bsize kept at 1 throughout so bavail/blocks are directly bytes — makes the
// threshold-boundary tests exact rather than fiddly multiples of a block size.
function fakeStatfs(bavailBytes: number, totalBytes: number) {
  return () => ({ bavail: bavailBytes, bsize: 1, blocks: totalBytes });
}

describe('checkDiskHeadroom (S6 — disk-headroom preflight)', () => {
  it('reports "ok" when free space is well above the low threshold', () => {
    const result = checkDiskHeadroom('/fake/path', {
      statFn: fakeStatfs(DEFAULT_LOW_THRESHOLD_BYTES * 10, DEFAULT_LOW_THRESHOLD_BYTES * 100),
    });
    expect(result.status).toBe('ok');
    expect(result.measurementFailed).toBe(false);
    expect(describeDiskHeadroom(result)).toBeNull();
  });

  it('reports "low" once free space drops below the low threshold', () => {
    const result = checkDiskHeadroom('/fake/path', {
      lowThresholdBytes: 1000,
      criticalThresholdBytes: 100,
      statFn: fakeStatfs(500, 10_000),
    });
    expect(result.status).toBe('low');
    expect(describeDiskHeadroom(result)).toContain('Low disk space');
  });

  it('reports "critical" once free space drops below the critical threshold', () => {
    const result = checkDiskHeadroom('/fake/path', {
      lowThresholdBytes: 1000,
      criticalThresholdBytes: 100,
      statFn: fakeStatfs(50, 10_000),
    });
    expect(result.status).toBe('critical');
    expect(describeDiskHeadroom(result)).toContain('Critically low disk space');
  });

  it('fails to "low" (not silently "ok") when the filesystem cannot be measured at all', () => {
    const result = checkDiskHeadroom('/fake/path', {
      statFn: () => {
        throw new Error('ENOENT');
      },
    });
    expect(result.status).toBe('low');
    expect(result.measurementFailed).toBe(true);
    expect(result.freeBytes).toBe(Number.POSITIVE_INFINITY);
    expect(describeDiskHeadroom(result)).toContain('could not be measured');
  });

  it('honors OP_DISK_LOW_THRESHOLD_BYTES / OP_DISK_CRITICAL_THRESHOLD_BYTES env overrides', () => {
    const originalLow = process.env.OP_DISK_LOW_THRESHOLD_BYTES;
    const originalCritical = process.env.OP_DISK_CRITICAL_THRESHOLD_BYTES;
    try {
      process.env.OP_DISK_LOW_THRESHOLD_BYTES = '10000';
      process.env.OP_DISK_CRITICAL_THRESHOLD_BYTES = '1000';
      const result = checkDiskHeadroom('/fake/path', { statFn: fakeStatfs(5000, 100_000) });
      expect(result.status).toBe('low');
      expect(result.lowThresholdBytes).toBe(10_000);
      expect(result.criticalThresholdBytes).toBe(1_000);
    } finally {
      if (originalLow === undefined) delete process.env.OP_DISK_LOW_THRESHOLD_BYTES;
      else process.env.OP_DISK_LOW_THRESHOLD_BYTES = originalLow;
      if (originalCritical === undefined) delete process.env.OP_DISK_CRITICAL_THRESHOLD_BYTES;
      else process.env.OP_DISK_CRITICAL_THRESHOLD_BYTES = originalCritical;
    }
  });
});

describe('shouldBlockOnDiskHeadroom (S6 — non-fatal by default)', () => {
  it('never blocks when hard-block is disabled (the default), even on a critical reading', () => {
    const critical = checkDiskHeadroom('/fake/path', { criticalThresholdBytes: 1000, statFn: fakeStatfs(1, 100_000) });
    expect(shouldBlockOnDiskHeadroom(critical, false)).toBe(false);
  });

  it('blocks only on a critical reading when hard-block is explicitly enabled', () => {
    const critical = checkDiskHeadroom('/fake/path', { criticalThresholdBytes: 1000, statFn: fakeStatfs(1, 100_000) });
    const low = checkDiskHeadroom('/fake/path', {
      lowThresholdBytes: 5000,
      criticalThresholdBytes: 1000,
      statFn: fakeStatfs(2000, 100_000),
    });
    expect(shouldBlockOnDiskHeadroom(critical, true)).toBe(true);
    expect(shouldBlockOnDiskHeadroom(low, true)).toBe(false);
  });

  it('reads OP_DISK_HARD_BLOCK=1 as the default enable flag when no explicit arg is passed', () => {
    const originalFlag = process.env.OP_DISK_HARD_BLOCK;
    try {
      process.env.OP_DISK_HARD_BLOCK = '1';
      const critical = checkDiskHeadroom('/fake/path', { criticalThresholdBytes: 1000, statFn: fakeStatfs(1, 100_000) });
      expect(shouldBlockOnDiskHeadroom(critical)).toBe(true);
    } finally {
      if (originalFlag === undefined) delete process.env.OP_DISK_HARD_BLOCK;
      else process.env.OP_DISK_HARD_BLOCK = originalFlag;
    }
  });
});
