import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectHostIdentity,
  describeHostRuntime,
  hostIdentityMatches,
  readHostIdentity,
  writeHostIdentity,
  type HostIdentity,
} from './host-identity.js';

let tempDir = '';

describe('describeHostRuntime (Docker Desktop seam)', () => {
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  });

  const setPlatform = (value: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value, configurable: true });

  test('native Linux is host-uid authoritative', () => {
    setPlatform('linux');
    const runtime = describeHostRuntime();
    expect(runtime.hostUidAuthoritative).toBe(true);
    expect(runtime.id).toBe('linux-native');
  });

  test('macOS (Docker Desktop VM) is not host-uid authoritative', () => {
    setPlatform('darwin');
    const runtime = describeHostRuntime();
    expect(runtime.hostUidAuthoritative).toBe(false);
    expect(runtime.id).toContain('darwin');
  });

  test('Windows (Docker Desktop VM) is not host-uid authoritative', () => {
    setPlatform('win32');
    const runtime = describeHostRuntime();
    expect(runtime.hostUidAuthoritative).toBe(false);
    expect(runtime.id).toContain('win32');
  });
});

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

describe('detectHostIdentity', () => {
  test('reports the LIVE session uid/gid, not the OP_HOME disk owner', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'openpalm-detect-identity-'));
    const identity = detectHostIdentity(tempDir);
    expect(identity.kind).toBe(process.platform);
    if (process.platform === 'win32') {
      expect(identity.uid).toBeNull();
      expect(identity.gid).toBeNull();
      return;
    }
    // Session identity from resolveSessionIdentity — the live process uid — so a
    // moved drive whose files are owned by a stale uid cannot mask a host swap.
    // biome-ignore lint/style/noNonNullAssertion: process.getuid is defined on POSIX (win32 returned early).
    expect(identity.uid).toBe(process.getuid!());
    // biome-ignore lint/style/noNonNullAssertion: process.getgid is defined on POSIX (win32 returned early).
    expect(identity.gid).toBe(process.getgid!());
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
