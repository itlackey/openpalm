import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';
import { createServer } from 'node:net';
import { migrateLegacyDefaultPorts, migrateConsolidatedDefaultPorts } from './config-persistence.js';

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

  // ── issue #658: DEFAULT port writes are probed, never an explicit value ──

  test("an operator's explicit consolidated port is carried through untouched — never probed or moved", async () => {
    // The legacy file has neither port; the CONSOLIDATED file already carries
    // the operator's own explicit choice. migrateLegacyDefaultPorts must copy
    // it verbatim, not probe or renumber it, even if that exact port happens
    // to be occupied right now.
    let server: Server | undefined;
    await withStackEnv('OP_OWNER_NAME=Alice\n', async (homeDir) => {
      server = createServer();
      await new Promise<void>((resolve) => server?.listen(3812, '127.0.0.1', resolve));
      mkdirSync(join(homeDir, 'state'), { recursive: true });
      writeFileSync(join(homeDir, 'state', 'stack.env'), 'OP_ASSISTANT_PORT=3812\nOP_UI_PORT=3802\n');

      expect(await migrateLegacyDefaultPorts(homeDir)).toBe(true);
      const migrated = readFileSync(join(homeDir, 'knowledge', 'env', 'stack.env'), 'utf8');
      expect(migrated).toContain('OP_ASSISTANT_PORT=3812');
      expect(migrated).toContain('OP_UI_PORT=3802');
    });
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });
});

describe('legacy default port migration — port probing (#658)', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  test('a fresh legacy home lands on the next free port when the default is occupied', async () => {
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(3810, '127.0.0.1', resolve));

    await withStackEnv('OP_OWNER_NAME=Alice\n', async (homeDir, path) => {
      expect(await migrateLegacyDefaultPorts(homeDir)).toBe(true);
      const migrated = readFileSync(path, 'utf8');
      // The UI default (3800) is free and stays put; the assistant default
      // (3810) is occupied, so the migration takes the next free port.
      expect(migrated).toContain('OP_UI_PORT=3800');
      expect(migrated).toContain('OP_ASSISTANT_PORT=3811');
    });
  });

  test('never picks the same free port for both defaults', async () => {
    // Occupy 3800 (the UI default) — the assistant default (3810) is free.
    // The UI port must move to the next free port (3801), and the assistant
    // port must not be pulled onto it.
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(3800, '127.0.0.1', resolve));

    await withStackEnv('OP_OWNER_NAME=Alice\n', async (homeDir, path) => {
      expect(await migrateLegacyDefaultPorts(homeDir)).toBe(true);
      const migrated = readFileSync(path, 'utf8');
      expect(migrated).toContain('OP_UI_PORT=3801');
      expect(migrated).toContain('OP_ASSISTANT_PORT=3810');
    });
  });
});

describe('consolidated default port migration — port probing (#658)', () => {
  let homeDir: string;
  let server: Server | undefined;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-consolidated-port-migration-'));
    mkdirSync(join(homeDir, 'state'), { recursive: true });
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    rmSync(homeDir, { recursive: true, force: true });
  });

  function stackEnvPath(): string {
    return join(homeDir, 'state', 'stack.env');
  }

  test('the retired pair swaps to the corrected defaults when both are free', async () => {
    writeFileSync(stackEnvPath(), 'OP_ASSISTANT_PORT=3800\nOP_UI_PORT=3810\n');
    expect(await migrateConsolidatedDefaultPorts(homeDir)).toBe(true);
    const migrated = readFileSync(stackEnvPath(), 'utf8');
    expect(migrated).toContain('OP_ASSISTANT_PORT=3810');
    expect(migrated).toContain('OP_UI_PORT=3800');
  });

  test('lands on the next free port when the corrected default is occupied', async () => {
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(3810, '127.0.0.1', resolve));
    writeFileSync(stackEnvPath(), 'OP_ASSISTANT_PORT=3800\nOP_UI_PORT=3810\n');

    expect(await migrateConsolidatedDefaultPorts(homeDir)).toBe(true);
    const migrated = readFileSync(stackEnvPath(), 'utf8');
    expect(migrated).toContain('OP_UI_PORT=3800');
    expect(migrated).toContain('OP_ASSISTANT_PORT=3811');
  });

  test('a non-retired pair is left alone — no probing happens at all', async () => {
    const original = 'OP_ASSISTANT_PORT=4800\nOP_UI_PORT=4900\n';
    writeFileSync(stackEnvPath(), original);
    expect(await migrateConsolidatedDefaultPorts(homeDir)).toBe(false);
    expect(readFileSync(stackEnvPath(), 'utf8')).toBe(original);
  });
});
