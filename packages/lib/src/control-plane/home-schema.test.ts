import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ensureHomeDirs,
  HOME_SCHEMA_VERSION,
  homeSchemaVersionFile,
  legacyKnowledgeStackEnvFile,
  legacyStateEnvFile,
  privateSecretsDir,
  readHomeSchemaVersion,
  secretsDir,
  stackEnvFile,
  writeHomeSchemaVersion,
} from './home.js';
import { runHomeMigrations } from './home-schema.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const CURRENT_DAILY_BRIEFING_PATH = join(
  REPO_ROOT,
  'packages',
  'skeleton',
  'knowledge',
  'tasks',
  'assistant-daily-briefing.yml',
);
const RELEASED_DAILY_BRIEFING = `${[
  "schedule: '0 8 * * *'",
  'enabled: false',
  'description: Ask the assistant for a daily system health summary',
  'tags:',
  '  - openpalm',
  '  - assistant',
  'timeoutMs: 120000',
  'prompt: >-',
  '  Good morning. Give me a brief summary of system health, any recent',
  '  errors in the audit log, and open tasks.',
].join('\n')}\n`;
const VERSIONED_DAILY_BRIEFING = `version: 2\n${RELEASED_DAILY_BRIEFING}`;
const HISTORICAL_DAILY_BRIEFINGS = [
  ['released default', RELEASED_DAILY_BRIEFING],
  ['versioned pre-fix default', VERSIONED_DAILY_BRIEFING],
  ['CRLF released default', RELEASED_DAILY_BRIEFING.replaceAll('\n', '\r\n')],
  ['CRLF versioned default', VERSIONED_DAILY_BRIEFING.replaceAll('\n', '\r\n')],
] as const;

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-schema-'));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

function seedLegacyHome(): void {
  mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
  writeFileSync(legacyKnowledgeStackEnvFile(homeDir), 'OP_ASSISTANT_PORT=3800\nOP_UI_PORT=3810\n');
}

function dailyBriefingPath(): string {
  return join(homeDir, 'knowledge', 'tasks', 'assistant-daily-briefing.yml');
}

function seedSchemaFiveHome(taskContent?: string): void {
  mkdirSync(join(homeDir, 'state'), { recursive: true });
  writeFileSync(stackEnvFile(homeDir), 'OP_SETUP_COMPLETE=true\n');
  writeHomeSchemaVersion(homeDir, 5);
  if (taskContent !== undefined) {
    mkdirSync(join(homeDir, 'knowledge', 'tasks'), { recursive: true });
    writeFileSync(dailyBriefingPath(), taskContent);
  }
}

describe('home schema progression', () => {
  test('a fresh home is stamped current without running legacy migrations', () => {
    ensureHomeDirs(homeDir);
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);

    writeFileSync(legacyKnowledgeStackEnvFile(homeDir), 'OP_ASSISTANT_PORT=3800\n');
    const before = readFileSync(legacyKnowledgeStackEnvFile(homeDir));
    expect(runHomeMigrations(homeDir)).toBe(false);
    expect(readFileSync(legacyKnowledgeStackEnvFile(homeDir))).toEqual(before);
  });

  test('an absent install is neither materialized nor stamped', () => {
    expect(runHomeMigrations(homeDir)).toBe(false);
    expect(existsSync(homeSchemaVersionFile(homeDir))).toBe(false);
    expect(existsSync(stackEnvFile(homeDir))).toBe(false);
  });

  test('an unstamped legacy home migrates once and retains the legacy input', () => {
    seedLegacyHome();
    ensureHomeDirs(homeDir);

    expect(runHomeMigrations(homeDir)).toBe(true);
    const migrated = readFileSync(stackEnvFile(homeDir), 'utf8');
    expect(migrated).toContain('OP_ASSISTANT_PORT=3810');
    expect(migrated).toContain('OP_UI_PORT=3800');
    expect(existsSync(legacyKnowledgeStackEnvFile(homeDir))).toBe(true);
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);

    const afterFirst = readFileSync(stackEnvFile(homeDir));
    expect(runHomeMigrations(homeDir)).toBe(false);
    expect(readFileSync(stackEnvFile(homeDir))).toEqual(afterFirst);
  });

  test('merges legacy precedence and comments, then preserves both inputs in place', () => {
    mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    const knowledge = '# operator notes\nOP_OWNER_NAME=alice\nOP_UI_PORT=3800\n';
    const state = 'OP_UI_PORT=9999\nOP_ENABLED_ADDONS=slack\n';
    writeFileSync(legacyKnowledgeStackEnvFile(homeDir), knowledge);
    writeFileSync(legacyStateEnvFile(homeDir), state);
    writeHomeSchemaVersion(homeDir, 1);

    expect(runHomeMigrations(homeDir)).toBe(true);

    const merged = readFileSync(stackEnvFile(homeDir), 'utf8');
    expect(merged).toContain('# operator notes');
    expect(merged).toContain('OP_OWNER_NAME=alice');
    expect(merged).toContain('OP_UI_PORT=9999');
    expect(merged).not.toContain('OP_UI_PORT=3800');
    expect(readFileSync(legacyKnowledgeStackEnvFile(homeDir), 'utf8')).toBe(knowledge);
    expect(readFileSync(legacyStateEnvFile(homeDir), 'utf8')).toBe(state);
  });

  test('drops release records from knowledge but retains real state pins', () => {
    mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(
      legacyKnowledgeStackEnvFile(homeDir),
      'OP_ASSISTANT_VERSION=0.12.33\nOP_GUARDIAN_VERSION=0.12.33\n',
    );
    writeFileSync(legacyStateEnvFile(homeDir), 'OP_GUARDIAN_VERSION=0.13.0\n');
    writeHomeSchemaVersion(homeDir, 1);

    runHomeMigrations(homeDir);

    const merged = readFileSync(stackEnvFile(homeDir), 'utf8');
    expect(merged).not.toContain('OP_ASSISTANT_VERSION=0.12.33');
    expect(merged).toContain('OP_GUARDIAN_VERSION=0.13.0');
  });

  test('merges a bootstrap target without overriding legacy values', () => {
    mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(legacyKnowledgeStackEnvFile(homeDir), 'OP_OWNER_NAME=alice\n');
    writeFileSync(legacyStateEnvFile(homeDir), 'OP_SETUP_COMPLETE=true\nOP_ENABLED_ADDONS=slack\n');
    writeFileSync(stackEnvFile(homeDir), 'OP_SETUP_COMPLETE=false\nOP_STUB_ONLY=keep\n');
    writeHomeSchemaVersion(homeDir, 1);

    expect(runHomeMigrations(homeDir)).toBe(true);
    const merged = readFileSync(stackEnvFile(homeDir), 'utf8');
    expect(merged).toContain('OP_SETUP_COMPLETE=true');
    expect(merged).toContain('OP_ENABLED_ADDONS=slack');
    expect(merged).toContain('OP_OWNER_NAME=alice');
    expect(merged).toContain('OP_STUB_ONLY=keep');
    expect(merged).not.toContain('OP_SETUP_COMPLETE=false');
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });

  test('retries after canonical publication when the schema 2 stamp fails', () => {
    mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(legacyKnowledgeStackEnvFile(homeDir), 'OP_OWNER_NAME=legacy\n');
    writeHomeSchemaVersion(homeDir, 1);
    const originalRename = fs.renameSync;
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
      if (String(to) === homeSchemaVersionFile(homeDir)) throw new Error('schema stamp failed');
      return originalRename(from, to);
    }) as typeof fs.renameSync);
    try {
      expect(() => runHomeMigrations(homeDir)).toThrow('schema stamp failed');
    } finally {
      renameSpy.mockRestore();
    }

    const canonical = readFileSync(stackEnvFile(homeDir));
    expect(readHomeSchemaVersion(homeDir)).toBe(1);
    expect(runHomeMigrations(homeDir)).toBe(true);
    const retried = readFileSync(stackEnvFile(homeDir), 'utf8');
    expect(canonical.toString()).toContain('OP_OWNER_NAME=legacy');
    expect(retried.match(/OP_OWNER_NAME=legacy/g)).toHaveLength(1);
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });

  test('continues after delegated-secret conflicts without reverting consolidated config', () => {
    mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(legacyKnowledgeStackEnvFile(homeDir), 'OP_OWNER_NAME=legacy\n');
    writeFileSync(legacyStateEnvFile(homeDir), 'OP_SETUP_COMPLETE=true\n');
    writeHomeSchemaVersion(homeDir, 1);

    const secretName = 'op_guardian_admin_token';
    mkdirSync(secretsDir(homeDir), { recursive: true });
    mkdirSync(privateSecretsDir(homeDir), { recursive: true });
    writeFileSync(join(secretsDir(homeDir), secretName), 'source-secret\n');
    writeFileSync(join(privateSecretsDir(homeDir), secretName), 'different-secret\n');

    expect(runHomeMigrations(homeDir)).toBe(true);
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
    expect(readFileSync(legacyKnowledgeStackEnvFile(homeDir), 'utf8')).toBe(
      'OP_OWNER_NAME=legacy\n',
    );
    expect(readFileSync(stackEnvFile(homeDir), 'utf8')).toContain('OP_OWNER_NAME=legacy');
    expect(readFileSync(join(secretsDir(homeDir), secretName), 'utf8')).toBe('source-secret\n');
    expect(readFileSync(join(privateSecretsDir(homeDir), secretName), 'utf8')).toBe(
      'different-secret\n',
    );
  });

  test('a corrupt schema stamp fails before replaying retained legacy inputs', () => {
    mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(legacyKnowledgeStackEnvFile(homeDir), 'OP_OWNER_NAME=legacy\n');
    writeFileSync(stackEnvFile(homeDir), 'OP_OWNER_NAME=canonical-edit\n');
    writeFileSync(homeSchemaVersionFile(homeDir), 'corrupt\n');

    expect(() => runHomeMigrations(homeDir)).toThrow('Home schema version is invalid');
    expect(readFileSync(stackEnvFile(homeDir), 'utf8')).toBe('OP_OWNER_NAME=canonical-edit\n');
    expect(readFileSync(legacyKnowledgeStackEnvFile(homeDir), 'utf8')).toBe(
      'OP_OWNER_NAME=legacy\n',
    );
  });

  test('a delegated-secret mismatch preserves both files without blocking startup', () => {
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(stackEnvFile(homeDir), 'OP_SETUP_COMPLETE=true\n');
    writeHomeSchemaVersion(homeDir, 2);
    mkdirSync(secretsDir(homeDir), { recursive: true });
    mkdirSync(privateSecretsDir(homeDir), { recursive: true });
    const name = 'op_guardian_admin_token';
    writeFileSync(join(secretsDir(homeDir), name), 'knowledge-copy\n');
    writeFileSync(join(privateSecretsDir(homeDir), name), 'private-copy\n');

    expect(runHomeMigrations(homeDir)).toBe(true);
    expect(readFileSync(join(secretsDir(homeDir), name), 'utf8')).toBe('knowledge-copy\n');
    expect(readFileSync(join(privateSecretsDir(homeDir), name), 'utf8')).toBe('private-copy\n');
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });

  for (const version of [0, 1, 2, 3, 4, 5]) {
    test(`preserves canonical content while upgrading a schema ${version} home`, () => {
      mkdirSync(join(homeDir, 'state'), { recursive: true });
      writeFileSync(stackEnvFile(homeDir), 'OP_CUSTOM_VALUE=keep\n');
      if (version > 0) writeHomeSchemaVersion(homeDir, version);

      runHomeMigrations(homeDir);

      expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
      expect(readFileSync(stackEnvFile(homeDir), 'utf8')).toContain('OP_CUSTOM_VALUE=keep');
    });
  }
});

describe('schema 6 daily briefing migration', () => {
  for (const [name, legacyContent] of HISTORICAL_DAILY_BRIEFINGS) {
    test(`replaces the exact ${name} bytes with the current skeleton asset`, () => {
      seedSchemaFiveHome(legacyContent);

      expect(runHomeMigrations(homeDir)).toBe(true);
      expect(readFileSync(dailyBriefingPath())).toEqual(readFileSync(CURRENT_DAILY_BRIEFING_PATH));
      expect(readHomeSchemaVersion(homeDir)).toBe(6);
    });
  }

  for (const [name, content] of [
    ['one-byte edit', VERSIONED_DAILY_BRIEFING.replace('system health', 'System health')],
    ['mixed line endings', VERSIONED_DAILY_BRIEFING.replace('\n', '\r\n')],
    ['enabled task', VERSIONED_DAILY_BRIEFING.replace('enabled: false', 'enabled: true')],
    ['rescheduled task', VERSIONED_DAILY_BRIEFING.replace("'0 8 * * *'", "'30 8 * * *'")],
  ] as const) {
    test(`preserves ${name} byte-for-byte`, () => {
      seedSchemaFiveHome(content);

      expect(runHomeMigrations(homeDir)).toBe(false);
      expect(readFileSync(dailyBriefingPath())).toEqual(Buffer.from(content));
      expect(readHomeSchemaVersion(homeDir)).toBe(6);
    });
  }

  test('leaves an absent task and task directory absent', () => {
    seedSchemaFiveHome();

    expect(runHomeMigrations(homeDir)).toBe(false);
    expect(existsSync(dailyBriefingPath())).toBe(false);
    expect(existsSync(join(homeDir, 'knowledge', 'tasks'))).toBe(false);
    expect(readHomeSchemaVersion(homeDir)).toBe(6);
  });

  test('does not stamp schema 6 when staging the eligible replacement fails', () => {
    seedSchemaFiveHome(VERSIONED_DAILY_BRIEFING);
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    try {
      expect(() => runHomeMigrations(homeDir)).toThrow('disk full');
    } finally {
      fsyncSpy.mockRestore();
    }

    expect(readFileSync(dailyBriefingPath())).toEqual(Buffer.from(VERSIONED_DAILY_BRIEFING));
    expect(readHomeSchemaVersion(homeDir)).toBe(5);
  });

  test('retries cleanly when directory fsync failed after atomic publication', () => {
    if (process.platform !== 'linux') return;
    seedSchemaFiveHome(VERSIONED_DAILY_BRIEFING);
    const originalFsync = fs.fsyncSync;
    let failed = false;
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation(((descriptor) => {
      if (!failed && fs.fstatSync(descriptor).isDirectory()) {
        failed = true;
        throw Object.assign(new Error('directory sync failed'), { code: 'EIO' });
      }
      return originalFsync(descriptor);
    }) as typeof fs.fsyncSync);
    try {
      expect(() => runHomeMigrations(homeDir)).toThrow('directory sync failed');
    } finally {
      fsyncSpy.mockRestore();
    }

    expect(readFileSync(dailyBriefingPath())).toEqual(readFileSync(CURRENT_DAILY_BRIEFING_PATH));
    expect(readHomeSchemaVersion(homeDir)).toBe(5);
    expect(runHomeMigrations(homeDir)).toBe(false);
    expect(readHomeSchemaVersion(homeDir)).toBe(6);
  });
});
