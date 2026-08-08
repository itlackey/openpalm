import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNERSHIP_REPAIR_IMAGE,
  SERVICE_NAMED_VOLUMES,
  repairManagedNamedVolumes,
  repairRootOwnedBindMounts,
  resolveRepairIdentity,
} from './volume-ownership.js';

describe('ownership repair helper image', () => {
  it('uses an immutable image digest', () => {
    expect(OWNERSHIP_REPAIR_IMAGE).toMatch(/^alpine:[^@]+@sha256:[a-f0-9]{64}$/);
  });
});

describe('SERVICE_NAMED_VOLUMES (#585 — the three /opt/openpalm volumes are retired)', () => {
  it('shrinks to only assistant-persistent — guardian-cache/assistant-artifacts/portal-cache are gone', () => {
    expect(SERVICE_NAMED_VOLUMES).toEqual({ assistant: ['assistant-persistent'] });
  });

  it('no longer lists a named volume to repair for guardian, discord, or slack', () => {
    expect(SERVICE_NAMED_VOLUMES.guardian).toBeUndefined();
    expect(SERVICE_NAMED_VOLUMES.discord).toBeUndefined();
    expect(SERVICE_NAMED_VOLUMES.slack).toBeUndefined();
  });
});

describe('ownership repair never chowns TO root', () => {
  it('skips bind-mount repair for a root session instead of chowning the operator files to root', async () => {
    if (process.platform === 'win32') return;
    const origGetuid = process.getuid;
    const origGetgid = process.getgid;
    try {
      (process as unknown as { getuid: () => number }).getuid = () => 0;
      (process as unknown as { getgid: () => number }).getgid = () => 0;
      // "/" is root-owned, so the session identity resolves to 0:0. Repairing to
      // it would `chown -R 0:0` every candidate — on `sudo openpalm start` over
      // an operator-owned OP_HOME that hands their knowledge/config/workspace to
      // root, and if stack.env pins a non-root OP_UID the containers can then no
      // longer write. Must be a no-op, and must report success (nothing failed).
      const ok = await repairRootOwnedBindMounts('/', ['/tmp']);
      expect(ok).toBe(true);
    } finally {
      (process as unknown as { getuid: typeof origGetuid }).getuid = origGetuid;
      (process as unknown as { getgid: typeof origGetgid }).getgid = origGetgid;
    }
  });

  it('skips named-volume repair for a root session', async () => {
    if (process.platform === 'win32') return;
    const origGetuid = process.getuid;
    const origGetgid = process.getgid;
    try {
      (process as unknown as { getuid: () => number }).getuid = () => 0;
      (process as unknown as { getgid: () => number }).getgid = () => 0;
      const ok = await repairManagedNamedVolumes('/', ['assistant']);
      expect(ok).toBe(true);
    } finally {
      (process as unknown as { getuid: typeof origGetuid }).getuid = origGetuid;
      (process as unknown as { getgid: typeof origGetgid }).getgid = origGetgid;
    }
  });
});

describe('resolveRepairIdentity (root session honors a hand-pinned OP_UID/OP_GID)', () => {
  function withStubbedIds(uid: number, gid: number, run: () => void): void {
    const origGetuid = process.getuid;
    const origGetgid = process.getgid;
    try {
      (process as unknown as { getuid: () => number }).getuid = () => uid;
      (process as unknown as { getgid: () => number }).getgid = () => gid;
      run();
    } finally {
      (process as unknown as { getuid: typeof origGetuid }).getuid = origGetuid;
      (process as unknown as { getgid: typeof origGetgid }).getgid = origGetgid;
    }
  }

  it('falls back to the stack.env pinned non-root ids when the session resolves root', () => {
    if (process.platform === 'win32') return;
    withStubbedIds(0, 0, () => {
      // "/" is root-owned → the session identity resolves {0,0}. The refusal
      // message told the operator to pin OP_UID/OP_GID — repair must honor it.
      expect(resolveRepairIdentity('/', { OP_UID: '4242', OP_GID: '4243' }))
        .toEqual({ uid: 4242, gid: 4243 });
    });
  });

  it('keeps resolving root for a pure root session (no pins) so callers still skip', () => {
    if (process.platform === 'win32') return;
    withStubbedIds(0, 0, () => {
      expect(resolveRepairIdentity('/', {})).toEqual({ uid: 0, gid: 0 });
    });
  });

  it('a hand-pinned ROOT id is not a repair target — still resolves root', () => {
    if (process.platform === 'win32') return;
    withStubbedIds(0, 0, () => {
      expect(resolveRepairIdentity('/', { OP_UID: '0', OP_GID: '0' })).toEqual({ uid: 0, gid: 0 });
    });
  });

  it('never lets a pin override a non-root session identity', () => {
    if (process.platform === 'win32') return;
    withStubbedIds(4242, 4243, () => {
      expect(resolveRepairIdentity('/', { OP_UID: '9999', OP_GID: '9999' }))
        .toEqual({ uid: 4242, gid: 4243 });
    });
  });
});

describe('pinned-under-sudo repair (root session + stack.env pins → chown to the pinned ids)', () => {
  // Requires a genuinely root-owned OP_HOME (mkdtemp under a non-root runner
  // cannot fabricate one), so it runs only where the suite itself is root —
  // CI containers and sudo runs, i.e. exactly the environment the fix targets.
  const savedDockerBin = process.env.OP_DOCKER_BIN;
  const dirs: string[] = [];

  afterEach(() => {
    if (savedDockerBin === undefined) delete process.env.OP_DOCKER_BIN;
    else process.env.OP_DOCKER_BIN = savedDockerBin;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('repairs bind mounts TO the pinned identity instead of skipping', async () => {
    if (process.platform === 'win32' || process.getuid?.() !== 0) return;
    const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-pinned-repair-'));
    dirs.push(homeDir);
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(join(homeDir, 'state', 'stack.env'), 'OP_UID=4242\nOP_GID=4243\n');
    const target = join(homeDir, 'data', 'guardian');
    mkdirSync(target, { recursive: true }); // owned 0:0 (this process is root)

    // Fake docker (same OP_DOCKER_BIN seam docker.test.ts uses) records argv.
    const argvLog = join(homeDir, 'docker-argv.log');
    const fakeDocker = join(homeDir, 'fake-docker.sh');
    writeFileSync(fakeDocker, `#!/bin/sh\necho "$@" >> ${argvLog}\nexit 0\n`);
    chmodSync(fakeDocker, 0o755);
    process.env.OP_DOCKER_BIN = fakeDocker;

    const ok = await repairRootOwnedBindMounts(homeDir, [target]);

    expect(ok).toBe(true);
    const logged = readFileSync(argvLog, 'utf8');
    expect(logged).toContain('chown -R 4242:4243');
  });
});
