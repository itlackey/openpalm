import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectSecretBackend,
  type ControlPlaneState,
  ensureSecrets,
  validatePassEntryName,
  PlaintextBackend,
  PassBackend,
  generateRedactSchema,
  getCoreSecretMappings,
} from '../index.js';
import {
  deriveComponentSecretRegistrations,
  registerComponentSensitiveFields,
  deregisterComponentSensitiveFields,
} from './component-secrets.js';
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

    const userEnv = readFileSync(join(state.vaultDir, 'user', 'user.env'), 'utf-8');
    expect(userEnv).toContain('very-secret');
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

  test('returns PassBackend when schema contains @varlock/pass-plugin', () => {
    const state = createState();
    mkdirSync(join(state.vaultDir, 'user'), { recursive: true });
    writeFileSync(
      join(state.vaultDir, 'user', 'user.env.schema'),
      '# @plugin(@varlock/pass-plugin)\nOPENAI_API_KEY=pass("openpalm/openai/api-key")\n',
    );

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

describe('generateRedactSchema', () => {
  test('output includes all mapped env keys', () => {
    const systemEnv: Record<string, string> = {};
    const schema = generateRedactSchema(systemEnv);

    // All static core mappings should be present
    expect(schema).toContain('OP_ADMIN_TOKEN=');
    expect(schema).toContain('ASSISTANT_TOKEN=');
    expect(schema).toContain('MEMORY_AUTH_TOKEN=');
    expect(schema).toContain('OPENAI_API_KEY=');
    expect(schema).toContain('ANTHROPIC_API_KEY=');
    expect(schema).toContain('GROQ_API_KEY=');
    expect(schema).toContain('MISTRAL_API_KEY=');
    expect(schema).toContain('GOOGLE_API_KEY=');
    expect(schema).toContain('MCP_API_KEY=');
    expect(schema).toContain('EMBEDDING_API_KEY=');
  });

  test('includes legacy aliases', () => {
    const schema = generateRedactSchema({});
    expect(schema).toContain('ADMIN_TOKEN=');
    expect(schema).toContain('OPENCODE_SERVER_PASSWORD=');
  });

  test('includes dynamic channel secrets', () => {
    const systemEnv = {
      CHANNEL_DISCORD_SECRET: 'abc123',
      CHANNEL_SLACK_SECRET: 'def456',
    };
    const schema = generateRedactSchema(systemEnv);
    expect(schema).toContain('CHANNEL_DISCORD_SECRET=');
    expect(schema).toContain('CHANNEL_SLACK_SECRET=');
  });

  test('has correct header format', () => {
    const schema = generateRedactSchema({});
    expect(schema).toContain('@defaultSensitive=true');
    expect(schema).toContain('@defaultRequired=false');
  });

  test('entries are sorted', () => {
    const schema = generateRedactSchema({});
    const lines = schema
      .split('\n')
      .filter((l) => l.match(/^[A-Z]/))
      .map((l) => l.replace(/=.*$/, ''));

    const sorted = [...lines].sort();
    expect(lines).toEqual(sorted);
  });
});

describe('component secret registration', () => {
  test('registers and deregisters sensitive fields from env schema', () => {
    const schemaPath = join(rootDir, '.env.schema');
    writeFileSync(schemaPath, [
      '# @sensitive',
      'DISCORD_BOT_TOKEN=',
      '# @sensitive=false',
      'CHANNEL_NAME=general',
      '# @sensitive',
      'SLACK_APP_TOKEN=',
      '',
    ].join('\n'));

    const derived = deriveComponentSecretRegistrations('discord-main', schemaPath);
    expect(derived).toHaveLength(2);
    expect(derived[0]?.secretKey).toBe('openpalm/component/discord-main/discord-bot-token');

    const registered = registerComponentSensitiveFields(rootDir, 'discord-main', schemaPath);
    expect(registered).toHaveLength(2);

    const removed = deregisterComponentSensitiveFields(rootDir, 'discord-main');
    expect(removed).toHaveLength(2);
  });
});
