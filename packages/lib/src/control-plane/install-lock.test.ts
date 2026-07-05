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

  it('does NOT declare a live-holder lock stale just because it is old', () => {
    // A genuinely-running deploy can exceed the staleness window (large image
    // pulls, slow hosts). A live holder PID must NEVER be declared stale on age
    // alone — only a dead PID (or an unparseable file) makes a lock reclaimable.
    // Dead-PID detection + `openpalm unlock` cover every genuine stuck-lock case.
    const old = Date.now() - INSTALL_LOCK_STALE_AFTER_MS - 60_000;
    // Use our own (live) PID with an old timestamp — the holder is alive.
    writeFileSync(lockPath, `${process.pid}\n${old}\n`);

    const status = inspectInstallLock(dataDir);
    expect(status.present).toBe(true);
    if (status.present) expect(status.stale).toBe(false);

    // unlock must refuse to remove a live-holder lock, no matter how old.
    const result = unlockInstallLock(dataDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('live');
    expect(existsSync(lockPath)).toBe(true);
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

  it('grants a reentrant handle when the SAME process already holds the lock', () => {
    const outer = acquireInstallLock(dataDir);
    expect(outer).not.toBeNull();
    expect(outer?.reentrant).toBeFalsy();

    // Nested acquire from this same process (wrapper → migration helper) must not
    // deadlock: it returns a reentrant no-op handle.
    const inner = acquireInstallLock(dataDir);
    expect(inner).not.toBeNull();
    expect(inner?.reentrant).toBe(true);

    // Releasing the reentrant handle leaves the outer lock in place...
    releaseInstallLock(inner);
    expect(existsSync(lockPath)).toBe(true);
    // ...and only the outermost release removes the file.
    releaseInstallLock(outer);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses (null) when the lock is held by a FOREIGN live PID', () => {
    // PID 1 (init) is always alive but is not this process → genuine contention.
    writeFileSync(lockPath, `1\n${Date.now()}\n`);
    const handle = acquireInstallLock(dataDir);
    expect(handle).toBeNull();
    // The foreign holder's lock file is untouched (still owned by PID 1).
    expect(readFileSync(lockPath, 'utf-8').split('\n')[0]).toBe('1');
  });
});
