import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOpenCodeCredential } from './opencode-auth.js';

let root = '';

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('resolveOpenCodeCredential', () => {
  test('reads the container file-backed credential when auth is enabled', () => {
    root = mkdtempSync(join(tmpdir(), 'openpalm-opencode-auth-'));
    const passwordFile = join(root, 'opencode-password');
    writeFileSync(passwordFile, 'päss 🔒 \n');

    expect(resolveOpenCodeCredential(root, {
      OPENCODE_AUTH: 'true',
      OPENCODE_SERVER_PASSWORD_FILE: passwordFile,
    }, { OPENCODE_AUTH: 'true' })).toEqual({
      username: 'opencode',
      password: 'päss 🔒 ',
    });
  });

  test('keeps the file inert while auth is disabled', () => {
    root = mkdtempSync(join(tmpdir(), 'openpalm-opencode-auth-'));
    const passwordFile = join(root, 'opencode-password');
    writeFileSync(passwordFile, 'secret\n');

    expect(resolveOpenCodeCredential(root, {
      OPENCODE_SERVER_PASSWORD_FILE: passwordFile,
    }, { OPENCODE_AUTH: 'false' })).toEqual({
      username: 'opencode',
      password: undefined,
    });
  });

  test('prefers an explicit password over the file-backed credential', () => {
    root = mkdtempSync(join(tmpdir(), 'openpalm-opencode-auth-'));
    const passwordFile = join(root, 'opencode-password');
    writeFileSync(passwordFile, 'file-value\n');
    mkdirSync(join(root, 'private', 'secrets'), { recursive: true });
    writeFileSync(join(root, 'private', 'secrets', 'op_opencode_password'), 'generated-value\n');

    expect(resolveOpenCodeCredential(root, {
      OPENCODE_AUTH: 'true',
      OPENCODE_SERVER_PASSWORD: 'explicit-value',
      OPENCODE_SERVER_PASSWORD_FILE: passwordFile,
    }, { OPENCODE_AUTH: 'true' }).password).toBe('explicit-value');
  });
});
