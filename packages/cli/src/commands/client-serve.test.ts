import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { runClientServeCommand } from './client-serve.ts';

// D4: `openpalm client-serve` run directly (no supervisor) must default PORT
// to the platform's stable client port BEFORE importing serve.mjs — otherwise
// serve.mjs's own fallback (4180) wins, diverging from every other path to
// the client app (the supervisor, Electron, the docs all agree on 3890).
describe('runClientServeCommand (D4)', () => {
  const ENV_KEYS = ['PORT', 'OP_HOST_CLIENT_PORT', 'OP_CLIENT_PORT', 'OP_CLIENT_DIR'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults PORT to the platform client port (3890) before importing serve.mjs', async () => {
    let importedPath: string | undefined;
    await runClientServeCommand({
      existsSync: () => true,
      resolveBuildDir: () => '/op-home/data/client/build',
      importServeScript: async (p) => { importedPath = p; },
    });
    expect(process.env.PORT).toBe('3890');
    expect(importedPath).toContain('serve.mjs');
  });

  it('honors OP_HOST_CLIENT_PORT when set', async () => {
    process.env.OP_HOST_CLIENT_PORT = '4011';
    await runClientServeCommand({
      existsSync: () => true,
      resolveBuildDir: () => '/op-home/data/client/build',
      importServeScript: async () => {},
    });
    expect(process.env.PORT).toBe('4011');
  });

  it('ignores OP_CLIENT_PORT (that key belongs to the assistant-container artifact listener, not the host client app)', async () => {
    process.env.OP_CLIENT_PORT = '4810';
    await runClientServeCommand({
      existsSync: () => true,
      resolveBuildDir: () => '/op-home/data/client/build',
      importServeScript: async () => {},
    });
    expect(process.env.PORT).toBe('3890');
  });

  it('does not override an already-set PORT (e.g. supervisor-spawned)', async () => {
    process.env.PORT = '5000';
    await runClientServeCommand({
      existsSync: () => true,
      resolveBuildDir: () => '/op-home/data/client/build',
      importServeScript: async () => {},
    });
    expect(process.env.PORT).toBe('5000');
  });

  it('exits(1) and never imports the script when it is missing', async () => {
    let imported = false;
    const exits: number[] = [];
    const errs: unknown[][] = [];
    await runClientServeCommand({
      existsSync: () => false,
      resolveBuildDir: () => '/op-home/data/client/build',
      importServeScript: async () => { imported = true; },
      exit: (c) => exits.push(c),
      logError: (...a) => errs.push(a),
    });
    expect(imported).toBe(false);
    expect(exits).toEqual([1]);
    expect(errs.flat().join(' ')).toMatch(/not found/i);
  });
});
