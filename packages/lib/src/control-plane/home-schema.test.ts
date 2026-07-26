/**
 * The schema gate exists so a legacy migration stops running once it has run.
 * These call the real functions against a real temp home and check the file
 * contents that result — the point is observable behavior, not that a symbol
 * is mentioned somewhere.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOME_SCHEMA_VERSION,
  ensureHomeDirs,
  homeSchemaVersionFile,
  legacyStackEnvFile,
  readHomeSchemaVersion,
} from './home.js';
import { runHomeMigrations } from './home-schema.js';

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-schema-'));
});
afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

/** A home as it looked before the port correction: assistant 3800 / UI 3810. */
function seedLegacyHome(): void {
  mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
  writeFileSync(legacyStackEnvFile(homeDir), 'OP_ASSISTANT_PORT=3800\nOP_UI_PORT=3810\n');
}

describe('a fresh home runs no legacy migrations', () => {
  test('ensureHomeDirs stamps a brand-new home as current', () => {
    ensureHomeDirs(homeDir);
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });

  test('runHomeMigrations does not touch stack.env on a fresh home', () => {
    ensureHomeDirs(homeDir);
    writeFileSync(legacyStackEnvFile(homeDir), 'OP_ASSISTANT_PORT=3810\nOP_UI_PORT=3800\n');
    const before = readFileSync(legacyStackEnvFile(homeDir), 'utf-8');

    expect(runHomeMigrations(homeDir)).toBe(false);
    expect(readFileSync(legacyStackEnvFile(homeDir), 'utf-8')).toBe(before);
  });
});

describe('an existing home migrates exactly once', () => {
  test('an unstamped legacy home is migrated, then recorded as current', () => {
    seedLegacyHome();
    // No stamp: ensureHomeDirs would have declined to write one because
    // stack.env already existed.
    ensureHomeDirs(homeDir);
    expect(existsSync(homeSchemaVersionFile(homeDir))).toBe(false);

    expect(runHomeMigrations(homeDir)).toBe(true);

    const migrated = readFileSync(legacyStackEnvFile(homeDir), 'utf-8');
    expect(migrated).toContain('OP_ASSISTANT_PORT=3810');
    expect(migrated).toContain('OP_UI_PORT=3800');
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });

  test('a second run is a no-op and leaves the file byte-identical', () => {
    seedLegacyHome();
    ensureHomeDirs(homeDir);
    runHomeMigrations(homeDir);
    const afterFirst = readFileSync(legacyStackEnvFile(homeDir), 'utf-8');

    expect(runHomeMigrations(homeDir)).toBe(false);
    expect(readFileSync(legacyStackEnvFile(homeDir), 'utf-8')).toBe(afterFirst);
  });

  test('an unreadable version record is treated as pre-record, not as current', () => {
    seedLegacyHome();
    ensureHomeDirs(homeDir);
    writeFileSync(homeSchemaVersionFile(homeDir), 'not-a-number\n');

    expect(readHomeSchemaVersion(homeDir)).toBe(0);
    expect(runHomeMigrations(homeDir)).toBe(true);
  });
});
