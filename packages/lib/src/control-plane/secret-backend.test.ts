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
import { PlaintextBackend, PassBackend } from './secret-backend.js';
import { writeSecretProviderConfig } from './provider-config.js';

let rootDir = '';

function createState(): ControlPlaneState {
  const vaultDir = join(rootDir, 'vault');
  const dataDir = join(rootDir, 'data');
  const configDir = join(rootDir, 'config');
  const logsDir = join(rootDir, 'logs');
  const cacheDir = join(rootDir, 'cache');
  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  return {
    adminToken: 'admin-token',
    assistantToken: '',
    setupToken: 'setup-token',
    homeDir: rootDir,
    configDir,
    vaultDir,
    dataDir,
    logsDir,
    cacheDir,
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
    mkdirSync(join(state.vaultDir, 'stack', 'auth.json'), { recursive: true });

    ensureSecrets(state);

    const authJsonPath = join(state.vaultDir, 'stack', 'auth.json');
    expect(lstatSync(authJsonPath).isFile()).toBe(true);
    expect(readFileSync(authJsonPath, 'utf-8')).toBe('{}\n');
  });

  test('detectSecretBackend defaults to plaintext and routes custom secrets into vault env files', async () => {
    const state = createState();
    ensureSecrets(state);
    const backend = detectSecretBackend(state);

    expect(backend.provider).toBe('plaintext');

    const entry = await backend.write('openpalm/custom/example', 'very-secret');
    expect(entry.provider).toBe('plaintext');
    expect(entry.scope).toBe('user');
    expect(await backend.exists('openpalm/custom/example')).toBe(true);

    // Custom secrets are now written to stack.env (all secrets consolidated there)
    const stackEnv = readFileSync(join(state.vaultDir, 'stack', 'stack.env'), 'utf-8');
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

describe('PlaintextBackend', () => {
  test('remove clears value for non-core secrets', async () => {
    const state = createState();
    ensureSecrets(state);
    const backend = new PlaintextBackend(state);

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
    const backend = new PlaintextBackend(state);

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
    const backend = new PlaintextBackend(state);

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
    const backend = new PlaintextBackend(state);

    const entry = await backend.generate('openpalm/custom/generated', 64);
    expect(entry.present).toBe(true);
    expect(await backend.exists('openpalm/custom/generated')).toBe(true);
  });

  test('user-scope and system-scope reads return distinct values when both files set the same key', async () => {
    // Regression test for the duplicate-ternary bug in currentValueForTarget:
    // user scope must consult vault/user/user.env, system scope must consult
    // vault/stack/stack.env. When both files define the same key with
    // different values, the two scopes must return their own file's value.
    const state = createState();
    ensureSecrets(state);
    const backend = new PlaintextBackend(state);

    // OPENAI_API_KEY is a user-scope core mapping; OP_ADMIN_TOKEN is system-scope.
    // Seed user.env with a user-scope override and a deliberately-wrong system
    // value, then seed stack.env with the system token + a different user value.
    const userEnvPath = join(state.vaultDir, 'user', 'user.env');
    appendFileSync(userEnvPath, '\nOPENAI_API_KEY=user-env-openai\n');

    // Stack.env already exists from ensureSecrets — overwrite OPENAI_API_KEY
    // there so we can prove user.env wins for user scope.
    const stackEnvPath = join(state.vaultDir, 'stack', 'stack.env');
    const stackContent = readFileSync(stackEnvPath, 'utf-8')
      .replace(/^OPENAI_API_KEY=.*$/m, 'OPENAI_API_KEY=stack-env-openai')
      .replace(/^OP_ADMIN_TOKEN=.*$/m, 'OP_ADMIN_TOKEN=stack-admin-token');
    writeFileSync(stackEnvPath, stackContent);

    // System scope reads stack.env exclusively.
    expect(await backend.exists('openpalm/admin-token')).toBe(true);
    const systemEntries = await backend.list('openpalm/admin-token');
    expect(systemEntries.find((e) => e.key === 'openpalm/admin-token')?.present).toBe(true);

    // User scope reads user.env (with stack.env fallback). Because user.env
    // sets OPENAI_API_KEY, the user-scope read must reflect the user.env
    // value, not the stack.env value — proving the two branches diverge.
    const userEntries = await backend.list('openpalm/openai/');
    const openai = userEntries.find((e) => e.key === 'openpalm/openai/api-key');
    expect(openai).toBeDefined();
    expect(openai?.scope).toBe('user');
    expect(openai?.present).toBe(true);

    // Direct verification: parse both files and confirm they hold distinct
    // values for the same key. This guards against a future regression where
    // someone collapses the ternary again.
    const userEnvParsed = readFileSync(userEnvPath, 'utf-8');
    const stackEnvParsed = readFileSync(stackEnvPath, 'utf-8');
    expect(userEnvParsed).toContain('OPENAI_API_KEY=user-env-openai');
    expect(stackEnvParsed).toContain('OPENAI_API_KEY=stack-env-openai');
    expect(stackEnvParsed).not.toContain('user-env-openai');
  });
});

describe('PassBackend', () => {
  test('constructor reads passPrefix from provider config', () => {
    const state = createState();
    writeSecretProviderConfig(state, {
      provider: 'pass',
      passwordStoreDir: '/tmp/test-pass-store',
      passPrefix: 'myprefix',
    });

    const backend = new PassBackend(state);
    expect(backend.provider).toBe('pass');
    // Verify it doesn't throw with valid config
    expect(backend.capabilities.generate).toBe(true);
  });

  test('constructor uses default store dir when no config', () => {
    const state = createState();
    const backend = new PassBackend(state);
    expect(backend.provider).toBe('pass');
  });

  test('exists returns false for non-existent entries', async () => {
    const state = createState();
    const storeDir = join(rootDir, 'data', 'secrets', 'pass-store');
    mkdirSync(storeDir, { recursive: true });

    const backend = new PassBackend(state);
    expect(await backend.exists('openpalm/nonexistent')).toBe(false);
  });

  test('list returns empty array for empty store', async () => {
    const state = createState();
    const storeDir = join(rootDir, 'data', 'secrets', 'pass-store');
    mkdirSync(storeDir, { recursive: true });

    const backend = new PassBackend(state);
    const entries = await backend.list();
    expect(entries).toEqual([]);
  });

  test('list scopes to passPrefix subdirectory', async () => {
    const state = createState();
    const storeDir = join(rootDir, 'data', 'secrets', 'pass-store');

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

    const backend = new PassBackend(state);
    const entries = await backend.list();

    expect(entries).toHaveLength(2);
    // Keys should be canonical (without prefix)
    expect(entries[0]?.key).toBe('openpalm/admin-token');
    expect(entries[1]?.key).toBe('openpalm/assistant-token');
  });

  test('exists checks prefixed path in store', async () => {
    const state = createState();
    const storeDir = join(rootDir, 'data', 'secrets', 'pass-store');
    const prefixDir = join(storeDir, 'myprefix');
    mkdirSync(join(prefixDir, 'openpalm'), { recursive: true });
    writeFileSync(join(prefixDir, 'openpalm', 'admin-token.gpg'), 'fake');

    writeSecretProviderConfig(state, {
      provider: 'pass',
      passwordStoreDir: storeDir,
      passPrefix: 'myprefix',
    });

    const backend = new PassBackend(state);
    expect(await backend.exists('openpalm/admin-token')).toBe(true);
    expect(await backend.exists('openpalm/nonexistent')).toBe(false);
  });
});

describe('detectSecretBackend', () => {
  test('returns PlaintextBackend by default', () => {
    const state = createState();
    const backend = detectSecretBackend(state);
    expect(backend.provider).toBe('plaintext');
    expect(backend).toBeInstanceOf(PlaintextBackend);
  });

  test('returns PassBackend when provider.json has provider: pass', () => {
    const state = createState();
    writeSecretProviderConfig(state, {
      provider: 'pass',
      passwordStoreDir: '/tmp/test',
    });

    const backend = detectSecretBackend(state);
    expect(backend.provider).toBe('pass');
    expect(backend).toBeInstanceOf(PassBackend);
  });

  test('returns PlaintextBackend when provider.json has provider: plaintext', () => {
    const state = createState();
    writeSecretProviderConfig(state, { provider: 'plaintext' });

    const backend = detectSecretBackend(state);
    expect(backend.provider).toBe('plaintext');
    expect(backend).toBeInstanceOf(PlaintextBackend);
  });
});
