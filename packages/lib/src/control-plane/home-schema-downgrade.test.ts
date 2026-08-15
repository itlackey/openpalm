/**
 * The guard that makes a version-skewed install unrepresentable.
 *
 * The schema record only ratchets forward, and every reader treats
 * "recorded >= mine" as "nothing to do" — correct for the same release, and
 * silently wrong for an older binary run against a newer OP_HOME. Without this
 * guard that invocation skips migrations it has never heard of, rewrites the
 * managed image tags down to its own platform version, stamps the managed
 * markers so the downgrade is never advanced back, and recreates the stack on
 * images that do not match the home.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HOME_SCHEMA_VERSION, writeHomeSchemaVersion } from './home.js';
import { checkHomeSchemaSupported, assertHomeSchemaSupported } from './home-schema.js';

let home = '';

/** A home with a stack env, so it reads as a real install rather than absent. */
function seedHome(recorded?: number): void {
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
  if (recorded !== undefined) writeHomeSchemaVersion(home, recorded);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'op-schema-guard-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('checkHomeSchemaSupported', () => {
  test('accepts a home at this binary’s own version', () => {
    seedHome(HOME_SCHEMA_VERSION);
    expect(checkHomeSchemaSupported(home, {}).ok).toBe(true);
  });

  test('accepts an older home — that is what migrations are for', () => {
    seedHome(1);
    expect(checkHomeSchemaSupported(home, {}).ok).toBe(true);
  });

  test('accepts an unstamped home — version 0, the safe direction', () => {
    seedHome();
    expect(checkHomeSchemaSupported(home, {}).ok).toBe(true);
  });

  test('refuses a home a newer release wrote', () => {
    seedHome(HOME_SCHEMA_VERSION + 1);
    const result = checkHomeSchemaSupported(home, {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.recorded).toBe(HOME_SCHEMA_VERSION + 1);
    expect(result.supported).toBe(HOME_SCHEMA_VERSION);
  });

  test('names both versions and the way out, not just "incompatible"', () => {
    seedHome(HOME_SCHEMA_VERSION + 3);
    const result = checkHomeSchemaSupported(home, {});
    if (result.ok) throw new Error('expected a refusal');
    expect(result.message).toContain(String(HOME_SCHEMA_VERSION + 3));
    expect(result.message).toContain(String(HOME_SCHEMA_VERSION));
    expect(result.message).toContain(home);
    expect(result.message).toContain('OP_ALLOW_HOME_DOWNGRADE=1');
  });

  test('OP_ALLOW_HOME_DOWNGRADE=1 is the explicit escape hatch', () => {
    seedHome(HOME_SCHEMA_VERSION + 1);
    expect(checkHomeSchemaSupported(home, { OP_ALLOW_HOME_DOWNGRADE: '1' }).ok).toBe(true);
  });

  test('only "1" opts in — a truthy-looking value must not', () => {
    seedHome(HOME_SCHEMA_VERSION + 1);
    for (const value of ['true', 'yes', '0', '']) {
      expect(checkHomeSchemaSupported(home, { OP_ALLOW_HOME_DOWNGRADE: value }).ok, value).toBe(
        false,
      );
    }
  });
});

describe('assertHomeSchemaSupported', () => {
  test('throws the same message the check returns', () => {
    seedHome(HOME_SCHEMA_VERSION + 1);
    const result = checkHomeSchemaSupported(home, {});
    if (result.ok) throw new Error('expected a refusal');
    expect(() => assertHomeSchemaSupported(home)).toThrow(result.message);
  });

  test('is silent for a supported home', () => {
    seedHome(HOME_SCHEMA_VERSION);
    expect(() => assertHomeSchemaSupported(home)).not.toThrow();
  });
});
