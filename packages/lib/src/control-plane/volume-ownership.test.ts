import { describe, expect, it } from 'bun:test';
import {
  OWNERSHIP_REPAIR_IMAGE,
  SERVICE_NAMED_VOLUMES,
  repairManagedNamedVolumes,
  repairRootOwnedBindMounts,
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
