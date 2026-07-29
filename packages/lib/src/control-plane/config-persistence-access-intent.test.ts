/**
 * Recording network-access intent explicitly in the consolidated stack.env.
 *
 * Two properties matter, and both were previously unreachable:
 *
 *  1. Exposure is PRESERVED as the pre-migration reader saw it, then written as
 *     booleans, so no later read has to infer it from bind addresses.
 *  2. The retired cascade keys are stripped from `state/stack.env`. The existing
 *     bind migration only ever rewrote the PRE-consolidation
 *     `knowledge/env/stack.env`, so nothing sanitized the consolidated file — a
 *     restored backup could keep `OP_BIND_ADDRESS` there forever, where Compose
 *     ignores it while the toggle reader honored it.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateAccessIntent } from './config-persistence.js';
import { parseEnvContent } from './env.js';
import { hasStoredAccessIntent, readAccessToggles } from './access-toggles.js';
import { stackEnvFile } from './home.js';

function withStateEnv(
  content: string,
  run: (homeDir: string, read: () => Record<string, string>) => void,
): void {
  const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-access-intent-'));
  const path = stackEnvFile(homeDir);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  try {
    run(homeDir, () => parseEnvContent(readFileSync(path, 'utf8')));
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

describe('migrateAccessIntent', () => {
  test('records intent matching the exposure the old reader saw', () => {
    withStateEnv('OP_UI_BIND_ADDRESS=0.0.0.0\nOP_ASSISTANT_BIND_ADDRESS=127.0.0.1\n', (homeDir, read) => {
      expect(migrateAccessIntent(homeDir)).toBe(true);
      const env = read();
      expect(env.OP_ACCESS_NETWORK).toBe('true');
      expect(env.OP_ACCESS_ASSISTANT_DIRECT).toBe('false');
      // The published bind is untouched — exposure must not move.
      expect(env.OP_UI_BIND_ADDRESS).toBe('0.0.0.0');
    });
  });

  test('strips a retired cascade root from the consolidated file', () => {
    withStateEnv('OP_BIND_ADDRESS=0.0.0.0\n', (homeDir, read) => {
      expect(migrateAccessIntent(homeDir)).toBe(true);
      const env = read();
      expect(env.OP_BIND_ADDRESS).toBeUndefined();
      // The cascade root meant "publish the UI, guardian and API", so the
      // explicit row it implied is materialized rather than silently dropped —
      // otherwise an upgrade closes doors the operator had open.
      expect(env.OP_ACCESS_NETWORK).toBe('true');
      expect(env.OP_UI_BIND_ADDRESS).toBe('0.0.0.0');
      expect(env.OP_ACCESS_GUARDIAN).toBe('true');
      expect(env.OP_ACCESS_ASSISTANT_DIRECT).toBe('false');
    });
  });

  test('honors the cascade precedence: an explicit per-service key beats the root', () => {
    // The exact shape that read back as networkAccess:true and then got made
    // real by the next save. Compose used the specific value, so the UI was
    // private and must stay private.
    withStateEnv('OP_BIND_ADDRESS=0.0.0.0\nOP_UI_BIND_ADDRESS=127.0.0.1\n', (homeDir, read) => {
      expect(migrateAccessIntent(homeDir)).toBe(true);
      const env = read();
      expect(env.OP_ACCESS_NETWORK).toBe('false');
      expect(env.OP_UI_BIND_ADDRESS).toBe('127.0.0.1');
    });
  });

  test('is a no-op once intent is recorded and no retired key remains', () => {
    withStateEnv(
      'OP_ACCESS_NETWORK=false\nOP_ACCESS_ASSISTANT_DIRECT=false\n'
        + 'OP_ACCESS_GUARDIAN=false\nOP_ACCESS_OPENAI_API=false\n',
      (homeDir, read) => {
        expect(migrateAccessIntent(homeDir)).toBe(false);
        expect(hasStoredAccessIntent(read())).toBe(true);
      },
    );
  });

  test('re-runs to strip a retired key an operator re-added after migrating', () => {
    withStateEnv(
      'OP_ACCESS_NETWORK=false\nOP_ACCESS_ASSISTANT_DIRECT=false\n'
        + 'OP_ACCESS_GUARDIAN=false\nOP_ACCESS_OPENAI_API=false\nOP_BIND_ADDRESS=0.0.0.0\n',
      (homeDir, read) => {
        expect(migrateAccessIntent(homeDir)).toBe(true);
        const env = read();
        expect(env.OP_BIND_ADDRESS).toBeUndefined();
        // Stored intent wins over the stray root, so exposure does NOT widen.
        expect(env.OP_ACCESS_NETWORK).toBe('false');
        expect(env.OP_UI_BIND_ADDRESS).toBe('127.0.0.1');
      },
    );
  });

  test('a fresh empty row records everything closed', () => {
    withStateEnv('OP_SETUP_COMPLETE=true\n', (homeDir, read) => {
      expect(migrateAccessIntent(homeDir)).toBe(true);
      expect(readAccessToggles(read())).toEqual({
        networkAccess: false,
        assistantDirect: false,
        guardianNetwork: false,
        guardianOpenaiApi: false,
      });
    });
  });

  test('leaves an absent file alone', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-access-intent-absent-'));
    try {
      expect(migrateAccessIntent(homeDir)).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('preserves operator comments in the file it rewrites', () => {
    withStateEnv('# my notes\nOP_UI_BIND_ADDRESS=0.0.0.0\n', (homeDir) => {
      migrateAccessIntent(homeDir);
      expect(readFileSync(stackEnvFile(homeDir), 'utf8')).toContain('# my notes');
    });
  });
});
