import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyOwnershipDecision,
  hostIdentityMatches,
  readHostIdentity,
  writeHostIdentity,
  type HostIdentity,
} from './host-identity.js';

let tempDir = '';

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('host identity matching', () => {
  test('matches identical identity tuples', () => {
    expect(hostIdentityMatches(
      { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 },
      { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 },
    )).toBe(true);
  });

  test('does not match differing tuples', () => {
    expect(hostIdentityMatches(
      { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 },
      { kind: 'darwin', host: 'host-b', uid: 501, gid: 20 },
    )).toBe(false);
  });

  test('ignores hostname-only changes when kind and ids are stable', () => {
    expect(hostIdentityMatches(
      { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 },
      { kind: 'linux', host: 'renamed-host', uid: 1000, gid: 1000 },
    )).toBe(true);
  });

  test('uses hostname when operator ids are unavailable', () => {
    expect(hostIdentityMatches(
      { kind: 'win32', host: 'host-a', uid: null, gid: null },
      { kind: 'win32', host: 'host-b', uid: null, gid: null },
    )).toBe(false);
  });

  test('does not match when only one side has concrete ids', () => {
    expect(hostIdentityMatches(
      { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 },
      { kind: 'linux', host: 'host-a', uid: null, gid: null },
    )).toBe(false);
  });
});

describe('ownership decision classification', () => {
  const current: HostIdentity = { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 };

  test('returns match when canary owner matches current operator ids', () => {
    expect(classifyOwnershipDecision({
      current,
      previous: null,
      canaryOwner: { uid: 1000, gid: 1000 },
    })).toBe('match');
  });

  test('returns drift when canary mismatches and prior host is absent', () => {
    expect(classifyOwnershipDecision({
      current,
      previous: null,
      canaryOwner: { uid: 0, gid: 0 },
    })).toBe('drift');
  });

  test('returns swap when canary mismatches and prior host differs', () => {
    expect(classifyOwnershipDecision({
      current,
      previous: { kind: 'darwin', host: 'host-b', uid: 501, gid: 20 },
      canaryOwner: { uid: 0, gid: 0 },
    })).toBe('swap');
  });
});

describe('host identity persistence', () => {
  test('round-trips host identity json', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'openpalm-host-identity-'));
    const path = join(tempDir, 'state', 'host-identity.json');
    const identity: HostIdentity = { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 };
    writeHostIdentity(path, identity);
    expect(readHostIdentity(path)).toEqual(identity);
  });

  test('rejects partially valid identity records', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'openpalm-host-identity-'));
    const path = join(tempDir, 'state', 'host-identity.json');
    writeHostIdentity(path, { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 });
    const content = '{"kind":"linux","host":"host-a","uid":1000,"gid":null}\n';
    writeFileSync(path, content);
    expect(readHostIdentity(path)).toBeNull();
  });
});
