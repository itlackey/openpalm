import { describe, expect, it } from 'bun:test';
import {
  checkDiskHeadroom,
  describeDiskHeadroom,
  shouldBlockOnDiskHeadroom,
  DEFAULT_LOW_THRESHOLD_BYTES,
  checkLifecycleDiskHeadroom,
  describeLifecycleDiskHeadroom,
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

// ── #588: the preflight measured OP_HOME only ────────────────────────────────
// Image pulls write to Docker's data root, which is frequently a DIFFERENT
// filesystem (a dedicated /var/lib/docker partition, a small / with a large
// /home, Docker Desktop's VM disk). The dangerous direction is a roomy OP_HOME
// with a nearly-full Docker root: the guard passes and the pull then hits
// ENOSPC — precisely the failure this preflight exists to prevent (#581).
//
// Every case below drives the injected statFn/deviceIdFn/probe seams, so no
// real disk, no real `docker info`, and no real Docker Desktop is involved.
describe('checkLifecycleDiskHeadroom (#588 — Docker data root measured alongside OP_HOME)', () => {
  const HOME = '/home/op/.openpalm';
  const DOCKER_ROOT = '/var/lib/docker';
  const THRESHOLDS = { lowThresholdBytes: 5000, criticalThresholdBytes: 1000 };

  /** Per-path fake statfs: bytes free keyed by path. */
  function statFor(freeByPath: Record<string, number>) {
    return (path: string) => {
      const free = freeByPath[path];
      if (free === undefined) throw new Error(`ENOENT: ${path}`);
      return { bavail: free, bsize: 1, blocks: 1_000_000 };
    };
  }

  /** Per-path fake device ids — this is what separates "two disks" from "one". */
  function devFor(devByPath: Record<string, number>) {
    return (path: string) => {
      const dev = devByPath[path];
      if (dev === undefined) throw new Error(`ENOENT: ${path}`);
      return dev;
    };
  }

  it('surfaces a critical Docker root even when OP_HOME has ample space', async () => {
    const headroom = await checkLifecycleDiskHeadroom(HOME, {
      ...THRESHOLDS,
      statFn: statFor({ [HOME]: 500_000, [DOCKER_ROOT]: 10 }),
      deviceIdFn: devFor({ [HOME]: 64, [DOCKER_ROOT]: 65 }),
      probeDockerRootFn: async () => ({ path: DOCKER_ROOT, measurableOnHost: true }),
    });

    expect(headroom.home.status).toBe('ok');
    expect(headroom.dockerRoot?.status).toBe('critical');
    expect(headroom.dockerRootSkipped).toBeNull();
    // The MORE SEVERE reading is what callers act on — an "ok" OP_HOME must not
    // mask a Docker root that is about to fail the pull.
    expect(headroom.worst).toBe(headroom.dockerRoot);

    const message = describeLifecycleDiskHeadroom(headroom) ?? '';
    expect(message).toContain('Critically low disk space');
    // Actionable means DISAMBIGUATING: the bare reading already carries the
    // Docker path, so naming it proves nothing. The operator must be able to
    // tell WHICH of their two filesystems is short — so the message has to
    // name both and say they differ, which the bare reading cannot do.
    expect(message).toContain(DOCKER_ROOT);
    expect(message).toContain(HOME);
    expect(message).toMatch(/data root/i);
    expect(message).toMatch(/different filesystem/i);
  });

  it('reports exactly one result when both resolve to the same filesystem', async () => {
    const headroom = await checkLifecycleDiskHeadroom(HOME, {
      ...THRESHOLDS,
      statFn: statFor({ [HOME]: 500, [DOCKER_ROOT]: 500 }),
      deviceIdFn: devFor({ [HOME]: 64, [DOCKER_ROOT]: 64 }),
      probeDockerRootFn: async () => ({ path: DOCKER_ROOT, measurableOnHost: true }),
    });

    expect(headroom.dockerRoot).toBeNull();
    expect(headroom.dockerRootSkipped).toBe('same-filesystem');
    expect(headroom.worst).toBe(headroom.home);
    // One filesystem, one warning — not the same disk described twice.
    const message = describeLifecycleDiskHeadroom(headroom) ?? '';
    expect(message).toContain(HOME);
    expect(message).not.toContain(DOCKER_ROOT);
  });

  it('still produces the OP_HOME reading when the Docker root cannot be resolved', async () => {
    // `docker info` missing, erroring, or timing out. This guard must never
    // become a new reason an install cannot start.
    const headroom = await checkLifecycleDiskHeadroom(HOME, {
      ...THRESHOLDS,
      statFn: statFor({ [HOME]: 500 }),
      deviceIdFn: devFor({ [HOME]: 64 }),
      probeDockerRootFn: async () => ({ path: null, measurableOnHost: false }),
    });

    expect(headroom.dockerRoot).toBeNull();
    expect(headroom.dockerRootSkipped).toBe('unresolved');
    expect(headroom.home.status).toBe('critical');
    expect(headroom.worst).toBe(headroom.home);
    expect(describeLifecycleDiskHeadroom(headroom)).toContain(HOME);
  });

  it('never throws when the Docker probe itself rejects', async () => {
    const headroom = await checkLifecycleDiskHeadroom(HOME, {
      ...THRESHOLDS,
      statFn: statFor({ [HOME]: 500_000 }),
      deviceIdFn: devFor({ [HOME]: 64 }),
      probeDockerRootFn: async () => {
        throw new Error('spawn docker ENOENT');
      },
    });

    expect(headroom.dockerRootSkipped).toBe('unresolved');
    expect(headroom.home.status).toBe('ok');
    expect(describeLifecycleDiskHeadroom(headroom)).toBeNull();
  });

  it('skips the Docker root on Docker Desktop (path lives in the VM) rather than reporting a bogus number', async () => {
    // DockerRootDir points INSIDE the VM, so a host statfs on it measures the
    // wrong disk (or the host path that happens to share the name).
    const statFn = statFor({ [HOME]: 500_000, [DOCKER_ROOT]: 10 });
    const headroom = await checkLifecycleDiskHeadroom(HOME, {
      ...THRESHOLDS,
      statFn,
      deviceIdFn: devFor({ [HOME]: 64, [DOCKER_ROOT]: 65 }),
      probeDockerRootFn: async () => ({ path: DOCKER_ROOT, measurableOnHost: false }),
    });

    expect(headroom.dockerRoot).toBeNull();
    expect(headroom.dockerRootSkipped).toBe('not-host-filesystem');
    expect(headroom.worst).toBe(headroom.home);
    // A bogus in-VM reading must not become a warning at all.
    expect(describeLifecycleDiskHeadroom(headroom)).toBeNull();
  });

  it('keeps the OP_HOME reading when it is the more severe of the two', async () => {
    const headroom = await checkLifecycleDiskHeadroom(HOME, {
      ...THRESHOLDS,
      statFn: statFor({ [HOME]: 10, [DOCKER_ROOT]: 3000 }),
      deviceIdFn: devFor({ [HOME]: 64, [DOCKER_ROOT]: 65 }),
      probeDockerRootFn: async () => ({ path: DOCKER_ROOT, measurableOnHost: true }),
    });

    expect(headroom.home.status).toBe('critical');
    expect(headroom.dockerRoot?.status).toBe('low');
    expect(headroom.worst).toBe(headroom.home);
    expect(describeLifecycleDiskHeadroom(headroom)).toContain(HOME);
  });

  it('leaves blocking on the same OP_DISK_HARD_BLOCK terms as OP_HOME (warn-only by default)', async () => {
    const headroom = await checkLifecycleDiskHeadroom(HOME, {
      ...THRESHOLDS,
      statFn: statFor({ [HOME]: 500_000, [DOCKER_ROOT]: 10 }),
      deviceIdFn: devFor({ [HOME]: 64, [DOCKER_ROOT]: 65 }),
      probeDockerRootFn: async () => ({ path: DOCKER_ROOT, measurableOnHost: true }),
    });

    // Default posture: a critical Docker root WARNS, it does not strand anyone.
    expect(shouldBlockOnDiskHeadroom(headroom.worst, false)).toBe(false);
    // Same env opt-in as OP_HOME, no separate knob.
    expect(shouldBlockOnDiskHeadroom(headroom.worst, true)).toBe(true);
  });
});

describe('checkLifecycleDiskHeadroom — an unreadable Docker root is silence, not noise', () => {
  it('skips a Docker root that cannot be statted rather than warning about it', async () => {
    // checkDiskHeadroom fails an unmeasurable path to "low" on purpose, which
    // is right for OP_HOME. Applied to the secondary Docker path it would warn
    // on EVERY day-2 command about a disk we never actually read.
    const headroom = await checkLifecycleDiskHeadroom('/home/op/.openpalm', {
      lowThresholdBytes: 5000,
      criticalThresholdBytes: 1000,
      statFn: (path: string) => {
        if (path === '/home/op/.openpalm') return { bavail: 500_000, bsize: 1, blocks: 1_000_000 };
        throw new Error('EACCES');
      },
      deviceIdFn: (path: string) => (path === '/home/op/.openpalm' ? 64 : 65),
      probeDockerRootFn: async () => ({ path: '/var/lib/docker', measurableOnHost: true }),
    });

    expect(headroom.dockerRoot).toBeNull();
    expect(headroom.dockerRootSkipped).toBe('not-host-filesystem');
    expect(headroom.home.status).toBe('ok');
    expect(describeLifecycleDiskHeadroom(headroom)).toBeNull();
  });
});
