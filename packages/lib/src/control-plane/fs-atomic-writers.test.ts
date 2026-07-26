/**
 * 0.1 — writeSystemEnv and writeVaultFile must go through the shared
 * writeFileAtomic helper (tmp file + rename) so an interrupted write can
 * never tear the target file: readers see either the fully-old content or
 * the fully-new content, never a partial write.
 *
 * We simulate "interrupted mid-write" by forcing the rename step (the last,
 * atomic step of writeFileAtomic) to throw. If the writer is truly atomic,
 * the throw happens before the target path is ever touched, so its original
 * content survives untouched. If the writer instead writes directly to the
 * target path (the pre-fix behavior), renameSync is never called at all and
 * the operation "succeeds" without going through the safe path — which this
 * test also catches, because it asserts the call throws.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as nodeFs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState } from './lifecycle.js';
import { writeSystemEnv } from './config-persistence.js';
import { patchSecretsEnvFile } from './secrets.js';

let homeDir: string;
let savedHome: string | undefined;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-fs-atomic-'));
  savedHome = process.env.OP_HOME;
  process.env.OP_HOME = homeDir;
  mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
  mkdirSync(join(homeDir, 'state'), { recursive: true });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = savedHome;
  rmSync(homeDir, { recursive: true, force: true });
});

describe('0.1 atomic writes — torn-write protection', () => {
  it('writeSystemEnv leaves stack.env fully intact when the atomic rename fails', () => {
    const state = createState();
    const path = join(homeDir, 'state', 'stack.env');
    writeFileSync(path, `OP_HOME=${homeDir}\nOP_SETUP_COMPLETE=true\nOP_LOG_LEVEL=info\n`);

    const spy = spyOn(nodeFs, 'renameSync').mockImplementation(() => {
      throw new Error('simulated crash before rename lands');
    });
    try {
      expect(() => writeSystemEnv(state)).toThrow();
    } finally {
      spy.mockRestore();
    }

    // Old content must be fully intact — never partially overwritten.
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('OP_SETUP_COMPLETE=true');
    expect(content).toContain('OP_LOG_LEVEL=info');
  });

  it('writeVaultFile (via patchSecretsEnvFile) leaves stack.env fully intact when the atomic rename fails', () => {
    const path = join(homeDir, 'state', 'stack.env');
    writeFileSync(path, 'OP_SETUP_COMPLETE=false\nOP_LOG_LEVEL=debug\n');

    const spy = spyOn(nodeFs, 'renameSync').mockImplementation(() => {
      throw new Error('simulated crash before rename lands');
    });
    try {
      expect(() => patchSecretsEnvFile(homeDir, { OP_ASSISTANT_VERSION: 'latest' })).toThrow();
    } finally {
      spy.mockRestore();
    }

    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('OP_SETUP_COMPLETE=false');
    expect(content).toContain('OP_LOG_LEVEL=debug');
  });
});
