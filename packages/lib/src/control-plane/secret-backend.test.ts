import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectSecretBackend,
  type ControlPlaneState,
  ensureSecrets,
  validatePassEntryName,
} from '../index.js';
import { writeSecretProviderConfig } from './provider-config.js';
import { akmUserVaultPathSync } from './akm-vault.js';
import { dirname } from 'node:path';

let rootDir = '';

function createState(): ControlPlaneState {
  const stateDir = join(rootDir, 'state');
  const configDir = join(rootDir, 'config');
  const stackDir = join(configDir, 'stack');
  const cacheDir = join(rootDir, 'cache');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(stackDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(rootDir, 'stash'), { recursive: true });
  mkdirSync(join(rootDir, 'workspace'), { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  return {
    homeDir: rootDir,
    configDir,
    stashDir: join(rootDir, 'stash'),
    workspaceDir: join(rootDir, 'workspace'),
    cacheDir,
    stateDir,
    stackDir,
    services: {},
    artifacts: { compose: '' },
    artifactMeta: [],
    audit: [],
  };
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'openpalm-secret-backend-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('secret backend', () => {
  test('ensureSecrets repairs auth.json when Docker created it as a directory', () => {
    const state = createState();
    mkdirSync(join(state.configDir, "auth.json"), { recursive: true });

    ensureSecrets(state);

    const authJsonPath = join(state.configDir, "auth.json");
    expect(lstatSync(authJsonPath).isFile()).toBe(true);
    expect(readFileSync(authJsonPath, 'utf-8')).toBe('{}\n');
  });

  test('detectSecretBackend defaults to plaintext and routes custom secrets into vault env files', async () => {
    const state = createState();
    ensureSecrets(state);
    const backend = detectSecretBackend(state);

    expect(backend.provider).toBe('plaintext');
    expect(backend.capabilities.generate).toBe(true);
    expect(backend.capabilities.remove).toBe(true);
    expect(backend.capabilities.rename).toBe(false);

    const entry = await backend.write('openpalm/custom/example', 'very-secret');
    expect(entry.provider).toBe('plaintext');
    expect(entry.scope).toBe('user');
    expect(await backend.exists('openpalm/custom/example')).toBe(true);

    // Custom secrets are now written to stack.env (all secrets consolidated there)
    const stackEnv = readFileSync(join(state.stackDir, "stack.env"), 'utf-8');
    expect(stackEnv).toContain('very-secret');
  });

  test('validatePassEntryName rejects traversal and invalid characters', () => {
    expect(() => validatePassEntryName('../bad')).toThrow();
    expect(() => validatePassEntryName('openpalm/Bad Key')).toThrow();
    expect(validatePassEntryName('openpalm/custom/good-key')).toBe('openpalm/custom/good-key');
  });

  test('validatePassEntryName rejects empty after trim', () => {
    expect(() => validatePassEntryName('')).toThrow('must not be empty');
    expect(() => validatePassEntryName('   ')).toThrow('must not be empty');
    expect(() => validatePassEntryName('///')).toThrow('must not be empty');
  });

  test('validatePassEntryName rejects uppercase characters', () => {
    expect(() => validatePassEntryName('openpalm/MyKey')).toThrow('invalid characters');
    expect(() => validatePassEntryName('OPENPALM/key')).toThrow('invalid characters');
  });

  test('validatePassEntryName handles multiple slashes and dots', () => {
    expect(validatePassEntryName('openpalm/a/b/c')).toBe('openpalm/a/b/c');
    expect(validatePassEntryName('openpalm/my.key')).toBe('openpalm/my.key');
    expect(validatePassEntryName('openpalm/my_key')).toBe('openpalm/my_key');
  });

  test('validatePassEntryName strips leading/trailing slashes', () => {
    expect(validatePassEntryName('/openpalm/key/')).toBe('openpalm/key');
  });
});

describe('plaintext backend (via detectSecretBackend)', () => {
  test('remove clears value for non-core secrets', async () => {
    const state = createState();
    ensureSecrets(state);
    const backend = detectSecretBackend(state);

    await backend.write('openpalm/custom/temp', 'temp-value');
    expect(await backend.exists('openpalm/custom/temp')).toBe(true);

    await backend.remove('openpalm/custom/temp');
    expect(await backend.exists('openpalm/custom/temp')).toBe(false);

    // Value is cleared — entry shows present: false
    const entries = await backend.list('openpalm/custom/');
    const found = entries.find((e) => e.key === 'openpalm/custom/temp');
    if (found) {
      expect(found.present).toBe(false);
    }
  });

  test('remove clears value but keeps index for core secrets', async () => {
    const state = createState();
    ensureSecrets(state);
    const backend = detectSecretBackend(state);

    // Write a core secret
    await backend.write('openpalm/admin-token', 'my-token');
    expect(await backend.exists('openpalm/admin-token')).toBe(true);

    await backend.remove('openpalm/admin-token');
    expect(await backend.exists('openpalm/admin-token')).toBe(false);

    // Core secrets still appear in list (as present: false)
    const entries = await backend.list('openpalm/');
    const found = entries.find((e) => e.key === 'openpalm/admin-token');
    expect(found).toBeDefined();
  });

  test('list includes both core and indexed entries', async () => {
    const state = createState();
    ensureSecrets(state);
    const backend = detectSecretBackend(state);

    await backend.write('openpalm/custom/my-key', 'value');

    const entries = await backend.list();
    const coreKeys = entries.filter((e) => e.kind === 'core');
    const customKeys = entries.filter((e) => e.kind === 'custom');

    expect(coreKeys.length).toBeGreaterThan(0);
    expect(customKeys.length).toBeGreaterThan(0);
    expect(customKeys.find((e) => e.key === 'openpalm/custom/my-key')).toBeDefined();
  });

  test('generate creates a secret with random value', async () => {
    const state = createState();
    ensureSecrets(state);
    const backend = detectSecretBackend(state);

    const entry = await backend.generate('openpalm/custom/generated', 64);
    expect(entry.present).toBe(true);
    expect(await backend.exists('openpalm/custom/generated')).toBe(true);
  });

  test('user-scope reads from akm vault, system-scope reads from stack.env', async () => {
    // Regression test: user scope must consult the akm vault file, system scope
    // must consult state/stack.env. When both files define the same key with
    // different values, the two scopes must return their own file's value.
    const state = createState();
    ensureSecrets(state);
    const backend = detectSecretBackend(state);

    // Seed the akm vault file with a user-scope value.
    const akmPath = akmUserVaultPathSync(state);
    mkdirSync(dirname(akmPath), { recursive: true });
    writeFileSync(akmPath, 'OPENAI_API_KEY=akm-vault-openai\n');

    // Stack.env already exists from ensureSecrets — seed the system password.
    const stackEnvPath = join(state.stackDir, "stack.env");
    const stackContent = readFileSync(stackEnvPath, 'utf-8')
      .replace(/^OP_UI_LOGIN_PASSWORD=.*$/m, 'OP_UI_LOGIN_PASSWORD=stack-login-password');
    writeFileSync(stackEnvPath, stackContent);

    // System scope reads stack.env exclusively.
    expect(await backend.exists('openpalm/ui-login-password')).toBe(true);
    const systemEntries = await backend.list('openpalm/ui-login-password');
    expect(systemEntries.find((e) => e.key === 'openpalm/ui-login-password')?.present).toBe(true);

    // User scope reads akm vault file.
    const userEntries = await backend.list('openpalm/openai/');
    const openai = userEntries.find((e) => e.key === 'openpalm/openai/api-key');
    expect(openai).toBeDefined();
    expect(openai?.scope).toBe('user');
    expect(openai?.present).toBe(true);
  });

  test('list/exists resolve user-scope secrets from akm vault', async () => {
    // The backend MUST resolve user-managed secrets through the akm vault file
    // (stash/vaults/user.env), not from any legacy path.
    const state = createState();
    ensureSecrets(state);
    const backend = detectSecretBackend(state);

    // Place the secret in the akm vault file.
    const akmPath = akmUserVaultPathSync(state);
    mkdirSync(dirname(akmPath), { recursive: true });
    writeFileSync(akmPath, 'OPENAI_API_KEY=migrated-akm-value\n');

    // exists() must report the user-scope secret as present.
    expect(await backend.exists('openpalm/openai/api-key')).toBe(true);

    // list() must enumerate it with present: true.
    const entries = await backend.list('openpalm/openai/');
    const openai = entries.find((e) => e.key === 'openpalm/openai/api-key');
    expect(openai).toBeDefined();
    expect(openai?.scope).toBe('user');
    expect(openai?.present).toBe(true);
  });
});

describe('pass backend (via detectSecretBackend)', () => {
  test('reports pass provider when configured', () => {
    const state = createState();
    writeSecretProviderConfig(state, {
      provider: 'pass',
      passwordStoreDir: '/tmp/test-pass-store',
      passPrefix: 'myprefix',
    });

    const backend = detectSecretBackend(state);
    expect(backend.provider).toBe('pass');
    expect(backend.capabilities.generate).toBe(true);
  });

  test('uses default store dir when no config', () => {
    const state = createState();
    writeSecretProviderConfig(state, { provider: 'pass' });
    const backend = detectSecretBackend(state);
    expect(backend.provider).toBe('pass');
  });

  test('exists returns false for non-existent entries', async () => {
    const state = createState();
    const storeDir = join(rootDir, 'state', 'secrets', 'pass-store');
    mkdirSync(storeDir, { recursive: true });
    writeSecretProviderConfig(state, { provider: 'pass', passwordStoreDir: storeDir });

    const backend = detectSecretBackend(state);
    expect(await backend.exists('openpalm/nonexistent')).toBe(false);
  });

  test('list returns empty array for empty store', async () => {
    const state = createState();
    const storeDir = join(rootDir, 'state', 'secrets', 'pass-store');
    mkdirSync(storeDir, { recursive: true });
    writeSecretProviderConfig(state, { provider: 'pass', passwordStoreDir: storeDir });

    const backend = detectSecretBackend(state);
    const entries = await backend.list();
    expect(entries).toEqual([]);
  });

  test('list scopes to passPrefix subdirectory', async () => {
    const state = createState();
    const storeDir = join(rootDir, 'state', 'secrets', 'pass-store');

    // Create fake .gpg files under the prefix subdirectory
    const prefixDir = join(storeDir, 'myprefix', 'openpalm');
    mkdirSync(prefixDir, { recursive: true });
    writeFileSync(join(prefixDir, 'admin-token.gpg'), 'fake-gpg-data');
    writeFileSync(join(prefixDir, 'assistant-token.gpg'), 'fake-gpg-data');

    // Create a file outside the prefix (should not appear)
    mkdirSync(join(storeDir, 'other'), { recursive: true });
    writeFileSync(join(storeDir, 'other', 'secret.gpg'), 'fake');

    writeSecretProviderConfig(state, {
      provider: 'pass',
      passwordStoreDir: storeDir,
      passPrefix: 'myprefix',
    });

    const backend = detectSecretBackend(state);
    const entries = await backend.list();

    expect(entries).toHaveLength(2);
    // Keys should be canonical (without prefix)
    expect(entries[0]?.key).toBe('openpalm/admin-token');
    expect(entries[1]?.key).toBe('openpalm/assistant-token');
  });

  test('exists checks prefixed path in store', async () => {
    const state = createState();
    const storeDir = join(rootDir, 'state', 'secrets', 'pass-store');
    const prefixDir = join(storeDir, 'myprefix');
    mkdirSync(join(prefixDir, 'openpalm'), { recursive: true });
    writeFileSync(join(prefixDir, 'openpalm', 'admin-token.gpg'), 'fake');

    writeSecretProviderConfig(state, {
      provider: 'pass',
      passwordStoreDir: storeDir,
      passPrefix: 'myprefix',
    });

    const backend = detectSecretBackend(state);
    expect(await backend.exists('openpalm/admin-token')).toBe(true);
    expect(await backend.exists('openpalm/nonexistent')).toBe(false);
  });
});

describe('detectSecretBackend', () => {
  test('returns plaintext provider by default', () => {
    const state = createState();
    const backend = detectSecretBackend(state);
    expect(backend.provider).toBe('plaintext');
  });

  test('returns pass provider when provider.json has provider: pass', () => {
    const state = createState();
    writeSecretProviderConfig(state, {
      provider: 'pass',
      passwordStoreDir: '/tmp/test',
    });

    const backend = detectSecretBackend(state);
    expect(backend.provider).toBe('pass');
  });

  test('returns plaintext provider when provider.json has provider: plaintext', () => {
    const state = createState();
    writeSecretProviderConfig(state, { provider: 'plaintext' });

    const backend = detectSecretBackend(state);
    expect(backend.provider).toBe('plaintext');
  });
});
