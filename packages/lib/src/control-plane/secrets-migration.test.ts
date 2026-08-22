/**
 * Test-first coverage for the G1 migration: relocating delegated secrets
 * (guardian/portal-only — never assistant-reachable) out of
 * knowledge/secrets/ (bind-mounted into the assistant at /stash) into
 * state/secrets/ (never mounted into the assistant). Must be non-destructive
 * and idempotent against a fixture OP_HOME in every state an existing install
 * could be in: fresh, unmigrated, partially migrated, and already migrated.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateDelegatedSecretsToStateDir, DELEGATED_SECRET_NAMES } from './secrets-migration.js';
import { secretsDir, stateSecretsDir } from './home.js';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'openpalm-secrets-migration-'));
}

function writeOld(home: string, name: string, content: string): void {
  const dir = secretsDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

function writeNew(home: string, name: string, content: string): void {
  const dir = stateSecretsDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

describe('migrateDelegatedSecretsToStateDir', () => {
  it('is a no-op on a fresh install (neither location has any delegated secret)', () => {
    const home = makeHome();

    const result = migrateDelegatedSecretsToStateDir(home);

    expect(result.migrated).toEqual([]);
    expect(result.alreadyMigrated).toEqual([]);
    expect(result.skippedMismatch).toEqual([]);
    expect(result.absent.sort()).toEqual([...DELEGATED_SECRET_NAMES].sort());
    // Still creates the state secrets dir (0700) so a fresh install's later writes land somewhere hardened.
    expect(existsSync(stateSecretsDir(home))).toBe(true);
    expect(statSync(stateSecretsDir(home)).mode & 0o777).toBe(0o700);
  });

  it('copies every delegated secret from knowledge/secrets to state/secrets, verifies, then removes the original', () => {
    const home = makeHome();
    for (const name of DELEGATED_SECRET_NAMES) {
      writeOld(home, name, `value-for-${name}\n`);
    }

    const result = migrateDelegatedSecretsToStateDir(home);

    expect(result.migrated.sort()).toEqual([...DELEGATED_SECRET_NAMES].sort());
    expect(result.skippedMismatch).toEqual([]);
    for (const name of DELEGATED_SECRET_NAMES) {
      // Source removed.
      expect(existsSync(join(secretsDir(home), name))).toBe(false);
      // Destination has the exact original content, 0600.
      const destPath = join(stateSecretsDir(home), name);
      expect(existsSync(destPath)).toBe(true);
      expect(readFileSync(destPath, 'utf-8')).toBe(`value-for-${name}\n`);
      expect(statSync(destPath).mode & 0o777).toBe(0o600);
    }
  });

  it('leaves a non-delegated secret (e.g. auth.json) untouched in knowledge/secrets', () => {
    const home = makeHome();
    writeOld(home, 'auth.json', '{"anthropic":{"type":"api","key":"sk-test"}}');
    writeOld(home, 'op_guardian_admin_token', 'tok-abc\n');

    const result = migrateDelegatedSecretsToStateDir(home);

    expect(result.migrated).toEqual(['op_guardian_admin_token']);
    // auth.json is untouched: still in knowledge/secrets, never copied.
    expect(readFileSync(join(secretsDir(home), 'auth.json'), 'utf-8')).toBe('{"anthropic":{"type":"api","key":"sk-test"}}');
    expect(existsSync(join(stateSecretsDir(home), 'auth.json'))).toBe(false);
  });

  it('handles a partially-migrated home: some already moved, some still pending, one interrupted mid-migration', () => {
    const home = makeHome();
    const names = [...DELEGATED_SECRET_NAMES];
    const [alreadyDone, stillPending, interrupted, ...rest] = names;

    // Already fully migrated: present only in state/secrets.
    writeNew(home, alreadyDone, 'already-migrated-value\n');

    // Still pending: present only in knowledge/secrets (classic unmigrated install).
    writeOld(home, stillPending, 'still-pending-value\n');

    // Interrupted mid-migration: copy succeeded, source removal did not run —
    // present in BOTH locations with IDENTICAL content.
    writeOld(home, interrupted, 'interrupted-value\n');
    writeNew(home, interrupted, 'interrupted-value\n');

    // The remaining names: absent everywhere (never provisioned on this install).
    void rest;

    const result = migrateDelegatedSecretsToStateDir(home);

    expect(result.migrated.sort()).toEqual([interrupted, stillPending].sort());
    expect(result.alreadyMigrated).toEqual([alreadyDone]);
    expect(result.skippedMismatch).toEqual([]);
    expect(result.absent.sort()).toEqual(rest.sort());

    // Post-conditions: every touched name now lives ONLY in state/secrets.
    expect(existsSync(join(secretsDir(home), alreadyDone))).toBe(false);
    expect(readFileSync(join(stateSecretsDir(home), alreadyDone), 'utf-8')).toBe('already-migrated-value\n');

    expect(existsSync(join(secretsDir(home), stillPending))).toBe(false);
    expect(readFileSync(join(stateSecretsDir(home), stillPending), 'utf-8')).toBe('still-pending-value\n');

    expect(existsSync(join(secretsDir(home), interrupted))).toBe(false);
    expect(readFileSync(join(stateSecretsDir(home), interrupted), 'utf-8')).toBe('interrupted-value\n');
  });

  it('is idempotent: running twice on an unmigrated home converges and the second run is a clean no-op', () => {
    const home = makeHome();
    for (const name of DELEGATED_SECRET_NAMES) {
      writeOld(home, name, `value-for-${name}\n`);
    }

    const first = migrateDelegatedSecretsToStateDir(home);
    expect(first.migrated.sort()).toEqual([...DELEGATED_SECRET_NAMES].sort());

    const second = migrateDelegatedSecretsToStateDir(home);
    expect(second.migrated).toEqual([]);
    expect(second.skippedMismatch).toEqual([]);
    expect(second.alreadyMigrated.sort()).toEqual([...DELEGATED_SECRET_NAMES].sort());

    // Content survived both runs unchanged.
    for (const name of DELEGATED_SECRET_NAMES) {
      expect(readFileSync(join(stateSecretsDir(home), name), 'utf-8')).toBe(`value-for-${name}\n`);
    }
  });

  it('is idempotent on an already-migrated (fresh-install-style) home with nothing to move', () => {
    const home = makeHome();
    for (const name of DELEGATED_SECRET_NAMES) {
      writeNew(home, name, `value-for-${name}\n`);
    }

    const result = migrateDelegatedSecretsToStateDir(home);

    expect(result.migrated).toEqual([]);
    expect(result.alreadyMigrated.sort()).toEqual([...DELEGATED_SECRET_NAMES].sort());
    expect(result.skippedMismatch).toEqual([]);
    for (const name of DELEGATED_SECRET_NAMES) {
      expect(readFileSync(join(stateSecretsDir(home), name), 'utf-8')).toBe(`value-for-${name}\n`);
    }
  });

  it('refuses to delete the source when both locations exist with DIFFERENT content (safety net)', () => {
    const home = makeHome();
    const [name] = [...DELEGATED_SECRET_NAMES];
    writeOld(home, name, 'old-value\n');
    writeNew(home, name, 'different-new-value\n');

    const result = migrateDelegatedSecretsToStateDir(home);

    expect(result.skippedMismatch).toEqual([name]);
    expect(result.migrated).toEqual([]);
    // Both files survive untouched — never silently discard data.
    expect(readFileSync(join(secretsDir(home), name), 'utf-8')).toBe('old-value\n');
    expect(readFileSync(join(stateSecretsDir(home), name), 'utf-8')).toBe('different-new-value\n');
  });

  it('hardens the state secrets directory to 0700 even when nothing needs migrating', () => {
    const home = makeHome();
    migrateDelegatedSecretsToStateDir(home);
    expect(statSync(stateSecretsDir(home)).mode & 0o777).toBe(0o700);
  });

  it('relocates the session signing key out of the assistant-readable stash', () => {
    // The cookie-signing key was missed when the other delegated secrets moved.
    // Left under knowledge/secrets it is bind-mounted into the assistant at
    // /stash, so the agent — or anything that prompt-injects it — can read the
    // key and, with the login password the same mount exposed, forge a valid
    // host-admin session cookie. That is the exact attack mixing a server-side
    // key into the cookie HMAC exists to prevent.
    const home = makeHome();
    writeOld(home, 'op_session_signing_key', 'deadbeef\n');

    const result = migrateDelegatedSecretsToStateDir(home);

    expect(result.migrated).toContain('op_session_signing_key');
    expect(existsSync(join(secretsDir(home), 'op_session_signing_key'))).toBe(false);
    expect(readFileSync(join(stateSecretsDir(home), 'op_session_signing_key'), 'utf-8')).toBe(
      'deadbeef\n',
    );
  });
});
