/**
 * Test-first coverage for the G1 migration: relocating delegated secrets
 * (guardian/portal-only — never assistant-reachable) out of
 * knowledge/secrets/ (bind-mounted into the assistant at /stash) into
 * private/secrets/ (never mounted into the assistant). Must be non-destructive
 * and idempotent against a fixture OP_HOME in every state an existing install
 * could be in: fresh, unmigrated, partially migrated, and already migrated.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateDelegatedSecretsToPrivateDir } from './secrets-migration.js';
import { DELEGATED_SECRET_NAMES } from './secrets-files.js';
import { secretsDir, privateSecretsDir } from './home.js';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'openpalm-secrets-migration-'));
}

function writeOld(home: string, name: string, content: string): void {
  const dir = secretsDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

function writeNew(home: string, name: string, content: string): void {
  const dir = privateSecretsDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

describe('migrateDelegatedSecretsToPrivateDir', () => {
  it('is a no-op on a fresh install (neither location has any delegated secret)', () => {
    const home = makeHome();

    const result = migrateDelegatedSecretsToPrivateDir(home);

    expect(result.migrated).toEqual([]);
    expect(result.alreadyMigrated).toEqual([]);
    expect(result.skippedMismatch).toEqual([]);
    expect(result.absent.sort()).toEqual([...DELEGATED_SECRET_NAMES].sort());
    // Still creates the private dir (0700) so a fresh install's later writes land somewhere hardened.
    expect(existsSync(privateSecretsDir(home))).toBe(true);
    expect(statSync(privateSecretsDir(home)).mode & 0o777).toBe(0o700);
  });

  it('copies every delegated secret from knowledge/secrets to private/secrets, verifies, then removes the original', () => {
    const home = makeHome();
    for (const name of DELEGATED_SECRET_NAMES) {
      writeOld(home, name, `value-for-${name}\n`);
    }

    const result = migrateDelegatedSecretsToPrivateDir(home);

    expect(result.migrated.sort()).toEqual([...DELEGATED_SECRET_NAMES].sort());
    expect(result.skippedMismatch).toEqual([]);
    for (const name of DELEGATED_SECRET_NAMES) {
      // Source removed.
      expect(existsSync(join(secretsDir(home), name))).toBe(false);
      // Destination has the exact original content, 0600.
      const destPath = join(privateSecretsDir(home), name);
      expect(existsSync(destPath)).toBe(true);
      expect(readFileSync(destPath, 'utf-8')).toBe(`value-for-${name}\n`);
      expect(statSync(destPath).mode & 0o777).toBe(0o600);
    }
  });

  it('leaves a non-delegated secret (e.g. auth.json) untouched in knowledge/secrets', () => {
    const home = makeHome();
    writeOld(home, 'auth.json', '{"anthropic":{"type":"api","key":"sk-test"}}');
    writeOld(home, 'op_guardian_admin_token', 'tok-abc\n');

    const result = migrateDelegatedSecretsToPrivateDir(home);

    expect(result.migrated).toEqual(['op_guardian_admin_token']);
    // auth.json is untouched: still in knowledge/secrets, never copied.
    expect(readFileSync(join(secretsDir(home), 'auth.json'), 'utf-8')).toBe('{"anthropic":{"type":"api","key":"sk-test"}}');
    expect(existsSync(join(privateSecretsDir(home), 'auth.json'))).toBe(false);
  });

  it('handles a partially-migrated home: some already moved, some still pending, one interrupted mid-migration', () => {
    const home = makeHome();
    const names = [...DELEGATED_SECRET_NAMES];
    const [alreadyDone, stillPending, interrupted, ...rest] = names;

    // Already fully migrated: present only in private/secrets.
    writeNew(home, alreadyDone, 'already-migrated-value\n');

    // Still pending: present only in knowledge/secrets (classic unmigrated install).
    writeOld(home, stillPending, 'still-pending-value\n');

    // Interrupted mid-migration: copy succeeded, source removal did not run —
    // present in BOTH locations with IDENTICAL content.
    writeOld(home, interrupted, 'interrupted-value\n');
    writeNew(home, interrupted, 'interrupted-value\n');

    // The remaining names: absent everywhere (never provisioned on this install).
    void rest;

    const result = migrateDelegatedSecretsToPrivateDir(home);

    expect(result.migrated.sort()).toEqual([interrupted, stillPending].sort());
    expect(result.alreadyMigrated).toEqual([alreadyDone]);
    expect(result.skippedMismatch).toEqual([]);
    expect(result.absent.sort()).toEqual(rest.sort());

    // Post-conditions: every touched name now lives ONLY in private/secrets.
    expect(existsSync(join(secretsDir(home), alreadyDone))).toBe(false);
    expect(readFileSync(join(privateSecretsDir(home), alreadyDone), 'utf-8')).toBe('already-migrated-value\n');

    expect(existsSync(join(secretsDir(home), stillPending))).toBe(false);
    expect(readFileSync(join(privateSecretsDir(home), stillPending), 'utf-8')).toBe('still-pending-value\n');

    expect(existsSync(join(secretsDir(home), interrupted))).toBe(false);
    expect(readFileSync(join(privateSecretsDir(home), interrupted), 'utf-8')).toBe('interrupted-value\n');
  });

  it('is idempotent: running twice on an unmigrated home converges and the second run is a clean no-op', () => {
    const home = makeHome();
    for (const name of DELEGATED_SECRET_NAMES) {
      writeOld(home, name, `value-for-${name}\n`);
    }

    const first = migrateDelegatedSecretsToPrivateDir(home);
    expect(first.migrated.sort()).toEqual([...DELEGATED_SECRET_NAMES].sort());

    const second = migrateDelegatedSecretsToPrivateDir(home);
    expect(second.migrated).toEqual([]);
    expect(second.skippedMismatch).toEqual([]);
    expect(second.alreadyMigrated.sort()).toEqual([...DELEGATED_SECRET_NAMES].sort());

    // Content survived both runs unchanged.
    for (const name of DELEGATED_SECRET_NAMES) {
      expect(readFileSync(join(privateSecretsDir(home), name), 'utf-8')).toBe(`value-for-${name}\n`);
    }
  });

  it('is idempotent on an already-migrated (fresh-install-style) home with nothing to move', () => {
    const home = makeHome();
    for (const name of DELEGATED_SECRET_NAMES) {
      writeNew(home, name, `value-for-${name}\n`);
    }

    const result = migrateDelegatedSecretsToPrivateDir(home);

    expect(result.migrated).toEqual([]);
    expect(result.alreadyMigrated.sort()).toEqual([...DELEGATED_SECRET_NAMES].sort());
    expect(result.skippedMismatch).toEqual([]);
    for (const name of DELEGATED_SECRET_NAMES) {
      expect(readFileSync(join(privateSecretsDir(home), name), 'utf-8')).toBe(`value-for-${name}\n`);
    }
  });

  it('refuses to delete the source when both locations exist with DIFFERENT content (safety net)', () => {
    const home = makeHome();
    const [name] = [...DELEGATED_SECRET_NAMES];
    writeOld(home, name, 'old-value\n');
    writeNew(home, name, 'different-new-value\n');

    const result = migrateDelegatedSecretsToPrivateDir(home);

    expect(result.skippedMismatch).toEqual([name]);
    expect(result.migrated).toEqual([]);
    // Both files survive untouched — never silently discard data.
    expect(readFileSync(join(secretsDir(home), name), 'utf-8')).toBe('old-value\n');
    expect(readFileSync(join(privateSecretsDir(home), name), 'utf-8')).toBe('different-new-value\n');
  });

  it('hardens the private secrets directory to 0700 even when nothing needs migrating', () => {
    const home = makeHome();
    migrateDelegatedSecretsToPrivateDir(home);
    expect(statSync(privateSecretsDir(home)).mode & 0o777).toBe(0o700);
  });
});
