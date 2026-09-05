/**
 * (#684) The CLI's existing-install gate.
 *
 * `ensureValidState` is the single entry every lifecycle command routes through
 * (start, stop, restart, logs, rollback, addon, validate, uninstall,
 * repair-ownership, reset-password), so this covers all of them: a wrong
 * OP_HOME must fail here, before Docker is invoked or the managed home is
 * written.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NotAnOpenPalmHomeError } from '@openpalm/lib';
import { ensureValidState, resolveServeState } from './cli-state.ts';

describe('ensureValidState existing-install gate', () => {
  const originalHome = process.env.OP_HOME;
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cli-state-')); process.env.OP_HOME = dir; });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = originalHome;
    rmSync(dir, { recursive: true, force: true });
  });

  function markInstalled(): void {
    mkdirSync(join(dir, 'system', 'stack'), { recursive: true });
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
  }

  it('refuses a home nothing was installed to, naming the resolved path', () => {
    let caught: unknown;
    try { ensureValidState(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NotAnOpenPalmHomeError);
    // The path matters: the old message said "not installed in this OP_HOME
    // yet — run install", which on a typo'd path invites a second install at
    // the wrong location instead of reporting the wrong location.
    expect((caught as Error).message).toContain(dir);
  });

  it('lets a completed install through', () => {
    markInstalled();
    expect(() => ensureValidState()).not.toThrow();
  });

  it('still serves a not-installed home through resolveServeState, so `openpalm admin` can reach /setup', () => {
    expect(() => resolveServeState()).not.toThrow();
  });
});
