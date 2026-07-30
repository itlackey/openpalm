/**
 * Derivation matrix for the assistant OpenCode target.
 *
 * This module had NO direct coverage — the `/oc` suite mocks the resolver
 * entirely — and three separate high-severity defects lived here at once: an
 * upstream that silently pointed at Electron's credential-less admin child, a
 * credential gated on frozen `process.env` instead of the live stack.env, and a
 * URL chain that ignored the persisted assistant port. Every branch that
 * decides "which server, at which URL, with which credential" is pinned here.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privateSecretsDir, stackEnvFile } from '@openpalm/lib';
import { _replaceState } from '$lib/server/state.js';
import { makeTestState } from '$lib/server/test-helpers.js';
import { getAssistantOpencodeTarget, validateConnectionUrl } from './opencode-target.js';

const ENV_KEYS = [
  'OP_OPENCODE_URL',
  'OP_ASSISTANT_URL',
  'OP_ASSISTANT_PORT',
  'OPENCODE_AUTH',
  'OPENCODE_SERVER_USERNAME',
  'OPENCODE_SERVER_PASSWORD',
  'OP_OPENCODE_PASSWORD',
] as const;

let home = '';
const saved: Record<string, string | undefined> = {};

function seedStackEnv(content: string): void {
  const path = stackEnvFile(home);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function seedGeneratedKey(value: string): void {
  const dir = privateSecretsDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'op_opencode_password'), value);
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  home = mkdtempSync(join(tmpdir(), 'op-oc-target-'));
  _replaceState(makeTestState({ homeDir: home }));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(home, { recursive: true, force: true });
});

describe('getAssistantOpencodeTarget — URL derivation', () => {
  test('falls back to loopback on the default assistant port', () => {
    expect(getAssistantOpencodeTarget().url).toBe('http://127.0.0.1:3810');
  });

  test('honors a persisted OP_ASSISTANT_PORT with no env override', () => {
    // A custom port written by a headless install must be read back, or the
    // proxy targets a port nothing is published on.
    seedStackEnv('OP_ASSISTANT_PORT=4910\n');
    expect(getAssistantOpencodeTarget().url).toBe('http://127.0.0.1:4910');
  });

  test('live env beats persisted stack.env', () => {
    seedStackEnv('OP_ASSISTANT_PORT=4910\n');
    process.env.OP_ASSISTANT_PORT = '5000';
    expect(getAssistantOpencodeTarget().url).toBe('http://127.0.0.1:5000');
  });

  test('OP_OPENCODE_URL wins over OP_ASSISTANT_URL and the port fallback', () => {
    process.env.OP_ASSISTANT_PORT = '4910';
    process.env.OP_ASSISTANT_URL = 'http://assistant.example:1';
    process.env.OP_OPENCODE_URL = 'http://localhost:4096';
    expect(getAssistantOpencodeTarget().url).toBe('http://localhost:4096');
  });

  test('a wildcard bind is normalized to loopback — 0.0.0.0 is not dialable', () => {
    process.env.OP_OPENCODE_URL = 'http://0.0.0.0:3810';
    expect(getAssistantOpencodeTarget().url).toBe('http://127.0.0.1:3810');
  });

  test('userinfo in the configured URL is stripped, never forwarded as a URL credential', () => {
    process.env.OP_OPENCODE_URL = 'http://user:secret@127.0.0.1:3810';
    const target = getAssistantOpencodeTarget();
    expect(target.url).not.toContain('secret');
    expect(target.url).toBe('http://127.0.0.1:3810');
  });

  test('a trailing slash is normalized away so path concatenation stays correct', () => {
    process.env.OP_OPENCODE_URL = 'http://127.0.0.1:3810/';
    expect(getAssistantOpencodeTarget().url).toBe('http://127.0.0.1:3810');
  });
});

describe('getAssistantOpencodeTarget — credential derivation', () => {
  test('no credential when OPENCODE_AUTH is off, even though the secret exists', () => {
    // The secret file is ALWAYS materialized by ensureSecrets, so its presence
    // says nothing about whether OpenCode requires auth.
    seedGeneratedKey('generated-key\n');
    seedStackEnv('OPENCODE_AUTH=false\n');
    expect(getAssistantOpencodeTarget().password).toBeUndefined();
  });

  test('uses the generated key when OPENCODE_AUTH is on in stack.env', () => {
    seedGeneratedKey('generated-key\n');
    seedStackEnv('OPENCODE_AUTH=true\n');
    expect(getAssistantOpencodeTarget().password).toBe('generated-key');
  });

  test('reads OPENCODE_AUTH from disk on every call, so a toggle takes effect without a restart', () => {
    seedGeneratedKey('generated-key\n');
    seedStackEnv('OPENCODE_AUTH=false\n');
    expect(getAssistantOpencodeTarget().password).toBeUndefined();

    seedStackEnv('OPENCODE_AUTH=true\n');
    expect(getAssistantOpencodeTarget().password).toBe('generated-key');
  });

  test.each(['true', 'TRUE', '1', 'yes', ' true '])('treats %s as auth-enabled', (value) => {
    seedGeneratedKey('generated-key\n');
    seedStackEnv(`OPENCODE_AUTH=${value}\n`);
    expect(getAssistantOpencodeTarget().password).toBe('generated-key');
  });

  test('strips only trailing newlines from the secret, preserving surrounding spaces', () => {
    // The assistant entrypoint's `$(cat)` and the guardian strip trailing
    // newlines only; trimming spaces here would 401 a password like "pw ".
    seedGeneratedKey('pass word \n\n');
    seedStackEnv('OPENCODE_AUTH=true\n');
    expect(getAssistantOpencodeTarget().password).toBe('pass word ');
  });

  test('an explicit OPENCODE_SERVER_PASSWORD wins over the generated key', () => {
    seedGeneratedKey('generated-key\n');
    seedStackEnv('OPENCODE_AUTH=true\n');
    process.env.OPENCODE_SERVER_PASSWORD = 'explicit';
    expect(getAssistantOpencodeTarget().password).toBe('explicit');
  });

  test("defaults the username to OpenCode's own default", () => {
    expect(getAssistantOpencodeTarget().username).toBe('opencode');
  });

  test('honors an overridden OPENCODE_SERVER_USERNAME', () => {
    process.env.OPENCODE_SERVER_USERNAME = 'custom';
    expect(getAssistantOpencodeTarget().username).toBe('custom');
  });
});

describe('validateConnectionUrl', () => {
  test('accepts plain HTTP for any host — OpenPalm is LAN-first', () => {
    expect(validateConnectionUrl('http://192.168.1.50:3830')).toEqual({
      ok: true,
      url: 'http://192.168.1.50:3830',
    });
  });

  test.each([
    ['not a url', 'invalid_url'],
    ['ftp://example.com', 'invalid_scheme'],
    ['http://user:pw@example.com', 'userinfo_not_allowed'],
    ['http://example.com/?a=1', 'unexpected_query_or_fragment'],
    ['http://example.com/#frag', 'unexpected_query_or_fragment'],
  ])('rejects %s as %s', (input, reason) => {
    expect(validateConnectionUrl(input)).toEqual({ ok: false, reason });
  });
});
