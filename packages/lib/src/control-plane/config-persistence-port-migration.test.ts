import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyDefaultPorts } from './config-persistence.js';

function withStackEnv(content: string, run: (homeDir: string, path: string) => void): void {
  const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-port-migration-'));
  const path = join(homeDir, 'knowledge', 'env', 'stack.env');
  mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
  writeFileSync(path, content);
  try {
    run(homeDir, path);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

describe('legacy default port migration', () => {
  test('materializes the corrected defaults when an old stack env omitted both ports', () => {
    withStackEnv('OP_OWNER_NAME=Alice\n', (homeDir, path) => {
      expect(migrateLegacyDefaultPorts(homeDir)).toBe(true);
      const migrated = readFileSync(path, 'utf8');
      expect(migrated).toContain('OP_UI_PORT=3800');
      expect(migrated).toContain('OP_ASSISTANT_PORT=3810');
    });
  });

  test('swaps a persisted assistant default and the old implicit UI default', () => {
    withStackEnv('OP_ASSISTANT_PORT=3800\nOP_OWNER_NAME=Alice\n', (homeDir, path) => {
      expect(migrateLegacyDefaultPorts(homeDir)).toBe(true);
      const migrated = readFileSync(path, 'utf8');
      expect(migrated).toContain('OP_UI_PORT=3800');
      expect(migrated).toContain('OP_ASSISTANT_PORT=3810');
      expect(migrated).toContain('OP_OWNER_NAME=Alice');
      expect(migrateLegacyDefaultPorts(homeDir)).toBe(false);
    });
  });

  test('swaps the fully explicit old default pair', () => {
    withStackEnv('OP_UI_PORT=3810\nOP_ASSISTANT_PORT=3800\n', (homeDir, path) => {
      expect(migrateLegacyDefaultPorts(homeDir)).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('OP_UI_PORT=3800\nOP_ASSISTANT_PORT=3810\n');
    });
  });

  test('preserves custom port combinations', () => {
    const original = 'OP_UI_PORT=4900\nOP_ASSISTANT_PORT=4800\n';
    withStackEnv(original, (homeDir, path) => {
      expect(migrateLegacyDefaultPorts(homeDir)).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(original);
    });
  });

  test('materializes the old implicit UI port beside a custom assistant port', () => {
    withStackEnv('OP_ASSISTANT_PORT=4800\n', (homeDir, path) => {
      expect(migrateLegacyDefaultPorts(homeDir)).toBe(true);
      const migrated = readFileSync(path, 'utf8');
      expect(migrated).toContain('OP_ASSISTANT_PORT=4800');
      expect(migrated).toContain('OP_UI_PORT=3810');
    });
  });

  test('materializes the old implicit assistant port beside a custom UI port', () => {
    withStackEnv('OP_UI_PORT=4900\n', (homeDir, path) => {
      expect(migrateLegacyDefaultPorts(homeDir)).toBe(true);
      const migrated = readFileSync(path, 'utf8');
      expect(migrated).toContain('OP_UI_PORT=4900');
      expect(migrated).toContain('OP_ASSISTANT_PORT=3800');
    });
  });
});
