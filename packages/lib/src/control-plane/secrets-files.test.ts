import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildEnvFiles } from './config-persistence.js';
import { assertNoSecretLikeStackEnvKeys, patchSecretsEnvFile } from './secrets.js';
import { listSecretNames, readSecret, resolveSecretsDir, secretPath, writeSecret, ensureSecret, listSecretFiles, readSecretFile, writeSecretFile, removeSecretFile, assertSafeSecretFilename, DELEGATED_SECRET_NAMES } from './secrets-files.js';
import { privateSecretsDir, secretsDir } from './home.js';
import type { ControlPlaneState } from './types.js';

function tempStackDir(): string {
  return mkdtempSync(join(tmpdir(), 'openpalm-secrets-files-'));
}

describe('file-based control-plane secrets', () => {
  it('creates the secrets directory and files with private permissions', () => {
    const stackDir = tempStackDir();

    writeSecret(stackDir, 'portal_chat_secret', 'value');

    expect(resolveSecretsDir(stackDir)).toBe(join(stackDir, 'knowledge', 'secrets'));
    expect(statSync(resolveSecretsDir(stackDir)).mode & 0o777).toBe(0o700);
    expect(statSync(secretPath(stackDir, 'portal_chat_secret')).mode & 0o777).toBe(0o600);
    expect(readSecret(stackDir, 'portal_chat_secret')).toBe('value');
    expect(listSecretNames(stackDir)).toEqual(['portal_chat_secret']);
  });

  it('rejects invalid secret names', () => {
    const stackDir = tempStackDir();

    expect(() => writeSecret(stackDir, 'CHANNEL_CHAT_SECRET', 'value')).toThrow(/Invalid secret name/);
    expect(() => writeSecret(stackDir, 'channel-chat-secret', 'value')).toThrow(/Invalid secret name/);
  });

  it('rejects secret-like stack.env keys', () => {
    expect(() => assertNoSecretLikeStackEnvKeys({ OPENAI_API_KEY: 'sk-test' })).toThrow(/OPENAI_API_KEY/);
    expect(() => assertNoSecretLikeStackEnvKeys({ OP_OWNER_NAME: 'Ada' })).not.toThrow();
  });

  it('does not include file-based secrets in compose env files', () => {
    const homeDir = tempStackDir(); // a temp OP_HOME root for this test
    const stashDir = join(homeDir, 'knowledge');
    const stackEnv = join(homeDir, 'state', 'stack.env');
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(stackEnv, 'OP_HOME=/tmp/openpalm\n');
    writeSecret(homeDir, 'portal_chat_secret', 'value');
    const state = { homeDir, stackDir: join(homeDir, 'config', 'stack'), stashDir } as ControlPlaneState;

    expect(buildEnvFiles(state)).toEqual([stackEnv]); // exactly one env file
  });

  it('routes secret patches to lower-case secret files instead of stack.env', () => {
    const stackDir = tempStackDir();
    writeFileSync(join(stackDir, 'stack.env'), 'OP_SETUP_COMPLETE=false\n');

    patchSecretsEnvFile(stackDir, { OP_UI_LOGIN_PASSWORD: 'pw', OP_ASSISTANT_VERSION: 'latest' });

    expect(readSecret(stackDir, 'op_ui_login_password')).toBe('pw\n');
    expect(listSecretNames(stackDir)).toContain('op_ui_login_password');
  });

  // G1 (docs/public-seams-review.md): delegated secrets — consumed only by
  // the guardian/portals, never the assistant agent — must resolve UNDER
  // private/secrets/, never under knowledge/secrets/ (bind-mounted wholesale
  // into the assistant at /stash). This is the discriminating property the
  // relocation exists for: a round-trip-only test (write then read the same
  // name back) would stay green even if delegated routing were disabled
  // entirely, because both directories are readable/writable the same way.
  // Only asserting the PHYSICAL PATH catches that regression.
  it('routes every delegated secret name under privateSecretsDir, never secretsDir', () => {
    const homeDir = tempStackDir();

    for (const name of DELEGATED_SECRET_NAMES) {
      const path = secretPath(homeDir, name);
      expect(path).toBe(join(privateSecretsDir(homeDir), name));
      expect(path.startsWith(secretsDir(homeDir))).toBe(false);

      writeSecret(homeDir, name, `value-for-${name}`);
      expect(readSecret(homeDir, name)).toBe(`value-for-${name}`);
      // The value must actually land on disk under private/secrets/, not
      // merely resolve there in-memory.
      expect(statSync(join(privateSecretsDir(homeDir), name)).isFile()).toBe(true);
    }
  });

  it('routes a non-delegated secret name (e.g. auth.json-adjacent) under secretsDir, never privateSecretsDir', () => {
    const homeDir = tempStackDir();
    const name = 'portal_owner_secret'; // not in DELEGATED_SECRET_NAMES

    expect(DELEGATED_SECRET_NAMES.has(name)).toBe(false);
    const path = secretPath(homeDir, name);
    expect(path).toBe(join(secretsDir(homeDir), name));
    expect(path.startsWith(privateSecretsDir(homeDir))).toBe(false);

    writeSecret(homeDir, name, 'non-delegated-value');
    expect(statSync(join(secretsDir(homeDir), name)).isFile()).toBe(true);
  });

  it('treats a zero-byte (torn) secret file as missing and re-seeds it (0.1)', () => {
    const homeDir = tempStackDir();
    // Simulate a write that was interrupted mid-flight, leaving a 0-byte file.
    const path = secretPath(homeDir, 'op_guardian_admin_token');
    writeFileSync(path, '');
    expect(statSync(path).size).toBe(0);

    const value = ensureSecret(homeDir, 'op_guardian_admin_token', () => 'freshly-seeded-value');

    expect(value).toBe('freshly-seeded-value');
    expect(readSecret(homeDir, 'op_guardian_admin_token')).toBe('freshly-seeded-value');
  });
});

describe('secrets-dir file browser API (admin Secrets tab)', () => {
  it('lists ALL files incl. dotted names like auth.json, with sizes', () => {
    const stackDir = tempStackDir();
    writeSecret(stackDir, 'portal_api_secret', 'abc');           // regex-valid secret
    writeFileSync(join(resolveSecretsDir(stackDir), 'auth.json'), '{"k":1}'); // dotted file
    const files = listSecretFiles(stackDir);
    const names = files.map((f) => f.name);
    expect(names).toContain('auth.json');           // included (strict listSecretNames would exclude it)
    expect(names).toContain('portal_api_secret');
    expect(files.find((f) => f.name === 'auth.json')?.size).toBe('{"k":1}'.length);
    // strict API still excludes the dotted file
    expect(listSecretNames(stackDir)).not.toContain('auth.json');
  });

  it('reads, writes (0600), and removes a dotted file by basename', () => {
    const stackDir = tempStackDir();
    writeSecretFile(stackDir, 'auth.json', '{"token":"x"}');
    expect(statSync(join(resolveSecretsDir(stackDir), 'auth.json')).mode & 0o777).toBe(0o600);
    expect(readSecretFile(stackDir, 'auth.json')).toBe('{"token":"x"}');
    removeSecretFile(stackDir, 'auth.json');
    expect(readSecretFile(stackDir, 'auth.json')).toBeNull();
  });

  it('rejects path traversal and unsafe names', () => {
    expect(() => assertSafeSecretFilename('../escape')).toThrow();
    expect(() => assertSafeSecretFilename('a/b')).toThrow();
    expect(() => assertSafeSecretFilename('..')).toThrow();
    expect(() => assertSafeSecretFilename('')).toThrow();
    // valid names
    expect(() => assertSafeSecretFilename('auth.json')).not.toThrow();
    expect(() => assertSafeSecretFilename('op_ui_login_password')).not.toThrow();
    expect(() => assertSafeSecretFilename('discord_bot_token')).not.toThrow();
  });

  it('readSecretFile returns null for a missing file', () => {
    expect(readSecretFile(tempStackDir(), 'nope.txt')).toBeNull();
  });
});
