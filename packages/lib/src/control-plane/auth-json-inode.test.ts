/**
 * auth.json is a single-file bind-mount source shared by the assistant and
 * guardian. A host write that replaces the inode leaves both containers reading
 * an unlinked file, silently.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createState } from './lifecycle.js';
import { writeAuthJsonProviderKeys } from './secrets.js';
import { authJsonPath as resolveAuthJsonPath } from './paths.js';

let homeDir: string;
let savedHome: string | undefined;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-authjson-'));
  savedHome = process.env.OP_HOME;
  process.env.OP_HOME = homeDir;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = savedHome;
  rmSync(homeDir, { recursive: true, force: true });
});

function seed(content: string) {
  const state = createState();
  const path = resolveAuthJsonPath(state);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  return { state, path };
}

describe('auth.json keeps its inode', () => {
  test('on a normal write', () => {
    const { state, path } = seed('{}\n');
    const before = statSync(path).ino;
    writeAuthJsonProviderKeys(state, { openai: 'sk-test' });
    expect(statSync(path).ino).toBe(before);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('on the corrupt-recovery path, which used to rename the live file away', () => {
    const { state, path } = seed('{ not json\n');
    const before = statSync(path).ino;
    writeAuthJsonProviderKeys(state, { openai: 'sk-test' });
    expect(statSync(path).ino).toBe(before);
  });
});
