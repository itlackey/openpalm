/**
 * Upgrade migration for the retired compose bind cascade.
 *
 * The property under test is exposure PRESERVATION: an install written when a
 * listener could be published purely by `OP_BIND_ADDRESS` must come back up
 * reachable exactly where it was, because the flat compose lines default
 * straight to loopback and would otherwise silently close it.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyBindAddresses, migrateRetiredOpencodeAuth } from './config-persistence.js';
import { parseEnvContent } from './env.js';

function withStackEnv(
  content: string,
  run: (homeDir: string, read: () => Record<string, string>) => void,
): void {
  const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-bind-migration-'));
  const path = join(homeDir, 'knowledge', 'env', 'stack.env');
  mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
  writeFileSync(path, content);
  try {
    run(homeDir, () => parseEnvContent(readFileSync(path, 'utf8')));
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

const FLAT_ALL_CLOSED = [
  'OP_UI_BIND_ADDRESS=127.0.0.1',
  'OP_ASSISTANT_BIND_ADDRESS=127.0.0.1',
  'OP_GUARDIAN_BIND_ADDRESS=127.0.0.1',
  'OP_API_BIND_ADDRESS=127.0.0.1',
  'GUARDIAN_DIRECT_INGRESS=false',
  '',
].join('\n');

describe('legacy bind address migration', () => {
  test('materializes what the cascade published from the root variable alone', () => {
    // The shared-guardian row. Nothing here names the UI, guardian or API
    // bind: the cascade resolved all three through OP_BIND_ADDRESS, so a flat
    // deploy would bring them all back loopback-only.
    withStackEnv('OP_BIND_ADDRESS=0.0.0.0\nOP_OWNER_NAME=Alice\n', (homeDir, read) => {
      expect(migrateLegacyBindAddresses(homeDir)).toBe(true);
      expect(read()).toMatchObject({
        OP_UI_BIND_ADDRESS: '0.0.0.0',
        OP_GUARDIAN_BIND_ADDRESS: '0.0.0.0',
        OP_API_BIND_ADDRESS: '0.0.0.0',
        // Never cascaded — its compose line always defaulted to loopback.
        OP_ASSISTANT_BIND_ADDRESS: '127.0.0.1',
        OP_OWNER_NAME: 'Alice',
      });
    });
  });

  test('honors the cascade precedence: an explicit loopback beats a LAN root', () => {
    // The listener the operator deliberately kept private must STAY private.
    withStackEnv('OP_BIND_ADDRESS=0.0.0.0\nOP_UI_BIND_ADDRESS=127.0.0.1\n', (homeDir, read) => {
      expect(migrateLegacyBindAddresses(homeDir)).toBe(true);
      const migrated = read();
      expect(migrated.OP_UI_BIND_ADDRESS).toBe('127.0.0.1');
      expect(migrated.OP_GUARDIAN_BIND_ADDRESS).toBe('0.0.0.0');
    });
  });

  test('turns on the guardian ingress a published guardian port needs', () => {
    // The legacy row omitted GUARDIAN_DIRECT_INGRESS, so the guardian 404'd
    // its whole direct listener while the port sat published.
    withStackEnv('OP_GUARDIAN_BIND_ADDRESS=0.0.0.0\n', (homeDir, read) => {
      expect(migrateLegacyBindAddresses(homeDir)).toBe(true);
      expect(read().GUARDIAN_DIRECT_INGRESS).toBe('true');
    });
  });

  test('a published OpenCode is a bind, not an auth posture', () => {
    // This migration used to also write OPENCODE_AUTH=true here. OpenCode
    // authenticates in every configuration now, so the migration has one job
    // left: materialize the bind the legacy cascade implied.
    withStackEnv('OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n', (homeDir, read) => {
      expect(migrateLegacyBindAddresses(homeDir)).toBe(true);
      expect(read().OP_ASSISTANT_BIND_ADDRESS).toBe('0.0.0.0');
      expect(read()).not.toHaveProperty('OPENCODE_AUTH');
    });
  });

  test('drops the retired cascade keys once their meaning is materialized', () => {
    const legacy = [
      'OP_BIND_ADDRESS=0.0.0.0',
      'OP_CHAT_BIND_ADDRESS=0.0.0.0',
      'OP_VOICE_BIND_ADDRESS=127.0.0.1',
      '',
    ].join('\n');
    withStackEnv(legacy, (homeDir, read) => {
      expect(migrateLegacyBindAddresses(homeDir)).toBe(true);
      const migrated = read();
      expect(migrated).not.toHaveProperty('OP_BIND_ADDRESS');
      expect(migrated).not.toHaveProperty('OP_CHAT_BIND_ADDRESS');
      expect(migrated).not.toHaveProperty('OP_VOICE_BIND_ADDRESS');
    });
  });

  test('is idempotent — a migrated row is left alone on the next deploy', () => {
    withStackEnv('OP_BIND_ADDRESS=0.0.0.0\n', (homeDir, read) => {
      expect(migrateLegacyBindAddresses(homeDir)).toBe(true);
      const first = read();
      expect(migrateLegacyBindAddresses(homeDir)).toBe(false);
      expect(read()).toEqual(first);
    });
  });

  test('leaves a row the current model already wrote untouched', () => {
    withStackEnv(FLAT_ALL_CLOSED, (homeDir) => {
      expect(migrateLegacyBindAddresses(homeDir)).toBe(false);
      expect(readFileSync(join(homeDir, 'knowledge', 'env', 'stack.env'), 'utf8'))
        .toBe(FLAT_ALL_CLOSED);
    });
  });

  test('completes a partial row rather than leaving a listener undefined', () => {
    withStackEnv('OP_UI_BIND_ADDRESS=0.0.0.0\n', (homeDir, read) => {
      expect(migrateLegacyBindAddresses(homeDir)).toBe(true);
      const migrated = read();
      expect(migrated.OP_UI_BIND_ADDRESS).toBe('0.0.0.0');
      expect(migrated.OP_ASSISTANT_BIND_ADDRESS).toBe('127.0.0.1');
      expect(migrated.GUARDIAN_DIRECT_INGRESS).toBe('false');
    });
  });

  test('does nothing without a stack env to migrate', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-bind-migration-empty-'));
    try {
      expect(migrateLegacyBindAddresses(homeDir)).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

// ── schema 9: sweep the retired OPENCODE_AUTH row ────────────────────────

/**
 * Same shape as withStackEnv above, but on the CONSOLIDATED `state/stack.env`.
 * The helper above writes the pre-consolidation `knowledge/env/stack.env`,
 * which is the only file the legacy bind migration ever touched; this sweep
 * runs after that consolidation and reads the file every deploy path uses.
 */
function withStateStackEnv(
  content: string,
  run: (homeDir: string, read: () => Record<string, string>) => void,
): void {
  const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-opencode-auth-migration-'));
  const path = join(homeDir, 'state', 'stack.env');
  mkdirSync(join(homeDir, 'state'), { recursive: true });
  writeFileSync(path, content);
  try {
    run(homeDir, () => parseEnvContent(readFileSync(path, 'utf8')));
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

describe('migrateRetiredOpencodeAuth', () => {
  test('removes the row and nothing else', () => {
    withStateStackEnv(
      'OP_UI_BIND_ADDRESS=0.0.0.0\nOPENCODE_AUTH=true\nOP_WORKSPACE_PORT=3820\n',
      (homeDir, read) => {
        expect(migrateRetiredOpencodeAuth(homeDir)).toBe(true);
        const migrated = read();
        expect(migrated).not.toHaveProperty('OPENCODE_AUTH');
        // Every neighbouring row survives — this is a single-key sweep, not a
        // regeneration of the file.
        expect(migrated.OP_UI_BIND_ADDRESS).toBe('0.0.0.0');
        expect(migrated.OP_WORKSPACE_PORT).toBe('3820');
      },
    );
  });

  test('sweeps the false spelling too — both are equally stale', () => {
    withStateStackEnv('OPENCODE_AUTH=false\n', (homeDir, read) => {
      expect(migrateRetiredOpencodeAuth(homeDir)).toBe(true);
      expect(read()).not.toHaveProperty('OPENCODE_AUTH');
    });
  });

  test('is idempotent — a second run reports no change', () => {
    withStateStackEnv('OPENCODE_AUTH=true\n', (homeDir) => {
      expect(migrateRetiredOpencodeAuth(homeDir)).toBe(true);
      expect(migrateRetiredOpencodeAuth(homeDir)).toBe(false);
    });
  });

  test('does nothing on a home that never had the key', () => {
    withStateStackEnv('OP_UI_BIND_ADDRESS=0.0.0.0\n', (homeDir) => {
      expect(migrateRetiredOpencodeAuth(homeDir)).toBe(false);
    });
  });

  test('does nothing without a stack env to migrate', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-opencode-auth-migration-empty-'));
    try {
      expect(migrateRetiredOpencodeAuth(homeDir)).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
