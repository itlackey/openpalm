/**
 * issue #643: `migrateConsolidatedDefaultPorts` used to swap the retired
 * 3800/3810 pair by value alone, with no regard for whether the target port
 * (the corrected default, 3810) was actually free on the host. On a host
 * running several OpenPalm instances, an operator who set OP_ASSISTANT_PORT
 * to 3800 specifically to dodge a sibling instance already on 3810 had that
 * explicit, working choice silently reverted on the next update — landing
 * them right back on the port they were avoiding.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateConsolidatedDefaultPorts } from './config-persistence.js';

async function withStackEnv(
  content: string,
  run: (homeDir: string, path: string) => void | Promise<void>,
): Promise<void> {
  const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-consolidated-port-migration-'));
  const path = join(homeDir, 'state', 'stack.env');
  mkdirSync(join(homeDir, 'state'), { recursive: true });
  writeFileSync(path, content);
  try {
    await run(homeDir, path);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

describe('consolidated default port migration', () => {
  test('swaps the retired pair when the corrected default is free', async () => {
    await withStackEnv('OP_ASSISTANT_PORT=3800\nOP_SETUP_COMPLETE=true\n', async (homeDir, path) => {
      expect(await migrateConsolidatedDefaultPorts(homeDir)).toBe(true);
      const migrated = readFileSync(path, 'utf8');
      expect(migrated).toContain('OP_ASSISTANT_PORT=3810');
      expect(migrated).toContain('OP_UI_PORT=3800');
    });
  });

  test('leaves a custom pair alone', async () => {
    const original = 'OP_ASSISTANT_PORT=4800\nOP_UI_PORT=4900\nOP_SETUP_COMPLETE=true\n';
    await withStackEnv(original, async (homeDir, path) => {
      expect(await migrateConsolidatedDefaultPorts(homeDir)).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(original);
    });
  });

  // The regression test: reproduces the reported bug (before the fix, this
  // FAILS — the swap runs regardless of what a real listener already holds)
  // and proves the fix (the operator's explicit 3800 survives).
  test('does not revert an explicit assistant port that equals the retired default when a real listener already holds the corrected target', async () => {
    const server = Bun.serve({ port: 3810, hostname: '127.0.0.1', fetch: () => new Response('x') });
    try {
      await withStackEnv('OP_ASSISTANT_PORT=3800\nOP_SETUP_COMPLETE=true\n', async (homeDir, path) => {
        expect(await migrateConsolidatedDefaultPorts(homeDir)).toBe(false);
        const after = readFileSync(path, 'utf8');
        expect(after).toContain('OP_ASSISTANT_PORT=3800');
        expect(after).not.toContain('OP_ASSISTANT_PORT=3810');
      });
    } finally {
      server.stop(true);
    }
  });

  test('a second run is a no-op once the target is free', async () => {
    await withStackEnv('OP_ASSISTANT_PORT=3800\nOP_SETUP_COMPLETE=true\n', async (homeDir) => {
      expect(await migrateConsolidatedDefaultPorts(homeDir)).toBe(true);
      expect(await migrateConsolidatedDefaultPorts(homeDir)).toBe(false);
    });
  });
});
