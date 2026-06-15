import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireInstallLock,
  releaseInstallLock,
  inspectInstallLock,
  unlockInstallLock,
  INSTALL_LOCK_STALE_AFTER_MS,
} from './install-lock.js';

let dataDir: string;
let lockPath: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'openpalm-lock-'));
  lockPath = join(dataDir, '.install.lock');
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('#500 install lock recovery', () => {
  it('inspect reports absent when no lock exists', () => {
    const status = inspectInstallLock(dataDir);
    expect(status.present).toBe(false);
    expect(status.path).toBe(lockPath);
  });

  it('inspect reports a live lock as not stale', () => {
    const handle = acquireInstallLock(dataDir);
    expect(handle).not.toBeNull();
    try {
      const status = inspectInstallLock(dataDir);
      expect(status.present).toBe(true);
      if (status.present) {
        expect(status.pid).toBe(process.pid);
        expect(status.stale).toBe(false);
      }
    } finally {
      releaseInstallLock(handle);
    }
  });

  it('unlock refuses to remove a live lock', () => {
    const handle = acquireInstallLock(dataDir);
    try {
      const result = unlockInstallLock(dataDir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('live');
      // Lock must still be present — never blind-removed.
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      releaseInstallLock(handle);
    }
  });

  it('unlock removes a lock held by a dead PID', () => {
    // PID 999999 is overwhelmingly unlikely to be alive.
    writeFileSync(lockPath, `999999\n${Date.now()}\n`);
    const before = inspectInstallLock(dataDir);
    expect(before.present).toBe(true);
    if (before.present) expect(before.stale).toBe(true);

    const result = unlockInstallLock(dataDir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.removed).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('unlock removes a lock older than the staleness window', () => {
    const old = Date.now() - INSTALL_LOCK_STALE_AFTER_MS - 60_000;
    // Use our own (live) PID but an old timestamp — timestamp-staleness wins.
    writeFileSync(lockPath, `${process.pid}\n${old}\n`);
    const result = unlockInstallLock(dataDir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.removed).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('unlock is idempotent when no lock exists', () => {
    const result = unlockInstallLock(dataDir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.removed).toBe(false);
  });

  it('lock file content survives an inspect (read-only)', () => {
    writeFileSync(lockPath, `999999\n${Date.now()}\n`);
    inspectInstallLock(dataDir);
    expect(readFileSync(lockPath, 'utf-8')).toContain('999999');
  });
});
