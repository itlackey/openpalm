import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyDefaultPorts } from './config-persistence.js';

async function withStackEnv(
  content: string,
  run: (homeDir: string, path: string) => void | Promise<void>,
): Promise<void> {
  const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-port-migration-'));
  const path = join(homeDir, 'knowledge', 'env', 'stack.env');
  mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
  writeFileSync(path, content);
  try {
    await run(homeDir, path);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

describe('legacy default port migration', () => {
  test('materializes the corrected defaults when an old stack env omitted both ports', async () => {
    await withStackEnv('OP_OWNER_NAME=Alice\n', async (homeDir, path) => {
      expect(await migrateLegacyDefaultPorts(homeDir)).toBe(true);
      const migrated = readFileSync(path, 'utf8');
      expect(migrated).toContain('OP_UI_PORT=3800');
      expect(migrated).toContain('OP_ASSISTANT_PORT=3810');
    });
  });

  test('swaps a persisted assistant default and the old implicit UI default', async () => {
    await withStackEnv('OP_ASSISTANT_PORT=3800\nOP_OWNER_NAME=Alice\n', async (homeDir, path) => {
      expect(await migrateLegacyDefaultPorts(homeDir)).toBe(true);
      const migrated = readFileSync(path, 'utf8');
      expect(migrated).toContain('OP_UI_PORT=3800');
      expect(migrated).toContain('OP_ASSISTANT_PORT=3810');
      expect(migrated).toContain('OP_OWNER_NAME=Alice');
      expect(await migrateLegacyDefaultPorts(homeDir)).toBe(false);
    });
  });

  test('swaps the fully explicit old default pair', async () => {
    await withStackEnv('OP_UI_PORT=3810\nOP_ASSISTANT_PORT=3800\n', async (homeDir, path) => {
      expect(await migrateLegacyDefaultPorts(homeDir)).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('OP_UI_PORT=3800\nOP_ASSISTANT_PORT=3810\n');
    });
  });

  test('preserves custom port combinations', async () => {
    const original = 'OP_UI_PORT=4900\nOP_ASSISTANT_PORT=4800\n';
    await withStackEnv(original, async (homeDir, path) => {
      expect(await migrateLegacyDefaultPorts(homeDir)).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(original);
    });
  });

  test('materializes the old implicit UI port beside a custom assistant port', async () => {
    await withStackEnv('OP_ASSISTANT_PORT=4800\n', async (homeDir, path) => {
      expect(await migrateLegacyDefaultPorts(homeDir)).toBe(true);
      const migrated = readFileSync(path, 'utf8');
      expect(migrated).toContain('OP_ASSISTANT_PORT=4800');
      expect(migrated).toContain('OP_UI_PORT=3810');
    });
  });

  test('materializes the old implicit assistant port beside a custom UI port', async () => {
    await withStackEnv('OP_UI_PORT=4900\n', async (homeDir, path) => {
      expect(await migrateLegacyDefaultPorts(homeDir)).toBe(true);
      const migrated = readFileSync(path, 'utf8');
      expect(migrated).toContain('OP_UI_PORT=4900');
      expect(migrated).toContain('OP_ASSISTANT_PORT=3800');
    });
  });

  // Issue #643: a sibling OpenPalm instance on the same host can already hold
  // the corrected default (3810) at the moment this migration materializes it
  // for a home that never configured a port at all. Blindly writing 3810
  // handed the next `docker compose up` a guaranteed "port is already
  // allocated" failure. Occupy the port with a REAL listener (matching how
  // `checkPortAvailable` actually probes) and confirm the migration steps
  // past it instead.
  test('steps past the default assistant port when a real listener already holds it', async () => {
    const server = Bun.serve({ port: 3810, hostname: '127.0.0.1', fetch: () => new Response('x') });
    try {
      await withStackEnv('OP_OWNER_NAME=Alice\n', async (homeDir, path) => {
        expect(await migrateLegacyDefaultPorts(homeDir)).toBe(true);
        const migrated = readFileSync(path, 'utf8');
        expect(migrated).toContain('OP_UI_PORT=3800');
        expect(migrated).not.toContain('OP_ASSISTANT_PORT=3810');
        expect(migrated).toContain('OP_ASSISTANT_PORT=3811');
      });
    } finally {
      server.stop(true);
    }
  });
});
