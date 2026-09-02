import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionableOwnershipError, errMessage } from './errors.js';

describe('errMessage', () => {
  it('returns the message of an Error', () => {
    expect(errMessage(new Error('boom'))).toBe('boom');
  });

  it('returns a string value unchanged', () => {
    expect(errMessage('plain string')).toBe('plain string');
  });

  it('coerces a non-Error object with String()', () => {
    expect(errMessage({ code: 42 })).toBe('[object Object]');
    expect(errMessage(null)).toBe('null');
    expect(errMessage(undefined)).toBe('undefined');
    expect(errMessage(123)).toBe('123');
  });

  it('preserves subclass Error messages', () => {
    class CustomError extends Error {}
    expect(errMessage(new CustomError('custom'))).toBe('custom');
  });
});

/**
 * #653 — the #641/#642 report was a bare `EACCES: permission denied, rm
 * '…'`/`copyfile '…'` with no next step. These pin the message this maps it
 * to: independent of a real uid/permission setup (that end-to-end path is
 * covered by core-assets.test.ts / backup.test.ts, self-skipped under root
 * and exercised for real by running the suite as a non-root user).
 */
describe('actionableOwnershipError', () => {
  it('names the offending path and the remedy for an EACCES', () => {
    const err = Object.assign(new Error('EACCES: permission denied, rm \'/home/.openpalm/system/guardian\''), {
      code: 'EACCES',
      path: '/home/.openpalm/system/guardian',
    });
    const actionable = actionableOwnershipError(err);
    expect(actionable).not.toBeNull();
    expect((actionable as Error).message).toContain('/home/.openpalm/system/guardian');
    expect((actionable as Error).message).toContain('openpalm repair-ownership');
  });

  it('names the offending path and the remedy for an EPERM', () => {
    const err = Object.assign(new Error('EPERM: operation not permitted, unlink'), {
      code: 'EPERM',
      path: '/home/.openpalm/data/backups/x/state/stack.env',
    });
    const actionable = actionableOwnershipError(err);
    expect(actionable).not.toBeNull();
    expect((actionable as Error).message).toContain('/home/.openpalm/data/backups/x/state/stack.env');
    expect((actionable as Error).message).toContain('openpalm repair-ownership');
  });

  it('falls back to `dest` when `path` is absent (rename-style errors)', () => {
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES', dest: '/home/.openpalm/system' });
    const actionable = actionableOwnershipError(err);
    expect((actionable as Error).message).toContain('/home/.openpalm/system');
  });

  it('falls back to scanning scanRoot when neither `path` nor `dest` is set (cpSync-shaped errors)', () => {
    // Bun's cpSync does not set .path/.dest on its EACCES/EPERM (unlike
    // readFileSync/renameSync/rmSync) — this is the fallback that still
    // names a path in that case. A broken symlink makes accessSync throw
    // deterministically for ANY uid (unlike chmod 0o000, which root bypasses
    // entirely) — findUnreadablePath does not discriminate by error code, so
    // this exercises the exact same scan/return path a real EACCES would.
    const bareErr = Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' });
    const scanRoot = mkdtempSync(join(tmpdir(), 'errors-scanroot-'));
    try {
      mkdirSync(join(scanRoot, 'nested'), { recursive: true });
      writeFileSync(join(scanRoot, 'readable.txt'), 'ok');
      const broken = join(scanRoot, 'nested', 'broken-link.txt');
      symlinkSync('/nonexistent-target-for-this-test', broken);
      const actionable = actionableOwnershipError(bareErr, scanRoot);
      expect((actionable as Error).message).toContain(broken);
    } finally {
      rmSync(scanRoot, { recursive: true, force: true });
    }
  });

  it('still returns "(unknown path)" gracefully when the scan finds nothing (never throws)', () => {
    const bareErr = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const scanRoot = mkdtempSync(join(tmpdir(), 'errors-scanroot-clean-'));
    try {
      writeFileSync(join(scanRoot, 'fine.txt'), 'ok');
      const actionable = actionableOwnershipError(bareErr, scanRoot);
      expect((actionable as Error).message).toContain('(unknown path)');
    } finally {
      rmSync(scanRoot, { recursive: true, force: true });
    }
  });

  it('returns null (never masks the original error) for any other code', () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: '/nope' });
    expect(actionableOwnershipError(enoent)).toBeNull();

    const plain = new Error('simulated disk failure mid-copy');
    expect(actionableOwnershipError(plain)).toBeNull();

    expect(actionableOwnershipError('not even an error')).toBeNull();
    expect(actionableOwnershipError(null)).toBeNull();
  });
});
