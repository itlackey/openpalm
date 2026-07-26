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
  legacyKnowledgeStackEnvFile,
  legacyStateEnvFile,
  readHomeSchemaVersion,
  stackEnvFile,
  writeHomeSchemaVersion,
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
  writeFileSync(legacyKnowledgeStackEnvFile(homeDir), 'OP_ASSISTANT_PORT=3800\nOP_UI_PORT=3810\n');
}

describe('a fresh home runs no legacy migrations', () => {
  test('ensureHomeDirs stamps a brand-new home as current', () => {
    ensureHomeDirs(homeDir);
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });

  test('runHomeMigrations does not touch stack.env on a fresh home', () => {
    ensureHomeDirs(homeDir);
    writeFileSync(legacyKnowledgeStackEnvFile(homeDir), 'OP_ASSISTANT_PORT=3810\nOP_UI_PORT=3800\n');
    const before = readFileSync(legacyKnowledgeStackEnvFile(homeDir), 'utf-8');

    expect(runHomeMigrations(homeDir)).toBe(false);
    expect(readFileSync(legacyKnowledgeStackEnvFile(homeDir), 'utf-8')).toBe(before);
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

    // The port fix landed, and the file it landed in is the consolidated one.
    const migrated = readFileSync(stackEnvFile(homeDir), 'utf-8');
    expect(migrated).toContain('OP_ASSISTANT_PORT=3810');
    expect(migrated).toContain('OP_UI_PORT=3800');
    expect(existsSync(legacyKnowledgeStackEnvFile(homeDir))).toBe(false);
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });

  test('a second run is a no-op and leaves the file byte-identical', () => {
    seedLegacyHome();
    ensureHomeDirs(homeDir);
    runHomeMigrations(homeDir);
    const afterFirst = readFileSync(stackEnvFile(homeDir), 'utf-8');

    expect(runHomeMigrations(homeDir)).toBe(false);
    expect(readFileSync(stackEnvFile(homeDir), 'utf-8')).toBe(afterFirst);
  });

  test('the two stack env files are merged into one, and the originals removed', () => {
    mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(legacyKnowledgeStackEnvFile(homeDir), '# operator notes\nOP_OWNER_NAME=alice\nOP_UI_PORT=3800\n');
    writeFileSync(legacyStateEnvFile(homeDir), 'OP_UI_PORT=9999\nOP_ENABLED_ADDONS=slack\n');
    writeHomeSchemaVersion(homeDir, 1);

    expect(runHomeMigrations(homeDir)).toBe(true);

    const merged = readFileSync(stackEnvFile(homeDir), 'utf-8');
    expect(merged).toContain('OP_OWNER_NAME=alice');
    expect(merged).toContain('OP_ENABLED_ADDONS=slack');
    expect(merged).toContain('# operator notes'); // operator comments survive
    expect(merged).toContain('OP_UI_PORT=9999'); // state won, as Compose applied it
    expect(merged).not.toContain('OP_UI_PORT=3800');

    expect(existsSync(legacyKnowledgeStackEnvFile(homeDir))).toBe(false);
    expect(existsSync(legacyStateEnvFile(homeDir))).toBe(false);
  });

  test('a version in the knowledge file is dropped, because it recorded the last applied release rather than a pin', () => {
    mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(
      legacyKnowledgeStackEnvFile(homeDir),
      'OP_ASSISTANT_VERSION=0.12.33\nOP_GUARDIAN_VERSION=0.12.33\n',
    );
    writeFileSync(legacyStateEnvFile(homeDir), 'OP_GUARDIAN_VERSION=0.13.0\n');
    writeHomeSchemaVersion(homeDir, 1);

    runHomeMigrations(homeDir);

    const merged = readFileSync(stackEnvFile(homeDir), 'utf-8');
    // Promoting this would have frozen the install at its current image.
    expect(merged).not.toContain('OP_ASSISTANT_VERSION=0.12.33');
    // A real pin, recorded in the app-owned file, survives.
    expect(merged).toContain('OP_GUARDIAN_VERSION=0.13.0');
  });

  test('an unreadable version record is treated as pre-record, not as current', () => {
    seedLegacyHome();
    ensureHomeDirs(homeDir);
    writeFileSync(homeSchemaVersionFile(homeDir), 'not-a-number\n');

    expect(readHomeSchemaVersion(homeDir)).toBe(0);
    expect(runHomeMigrations(homeDir)).toBe(true);
  });
});
