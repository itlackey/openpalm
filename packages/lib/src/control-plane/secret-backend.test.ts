import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectSecretBackend,
  type ControlPlaneState,
  ensureSecrets,
  validatePassEntryName,
} from '../index.js';
import {
  deriveComponentSecretRegistrations,
  registerComponentSensitiveFields,
  deregisterComponentSensitiveFields,
} from './component-secrets.js';

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
    artifacts: { compose: '', caddyfile: '' },
    artifactMeta: [],
    audit: [],
    channelSecrets: {},
  };
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'openpalm-secret-backend-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('secret backend', () => {
  test('detectSecretBackend defaults to plaintext and routes custom secrets into vault env files', async () => {
    const state = createState();
    ensureSecrets(state);
    const backend = detectSecretBackend(state);

    expect(backend.provider).toBe('plaintext');

    const entry = await backend.write('openpalm/custom/example', 'very-secret');
    expect(entry.provider).toBe('plaintext');
    expect(entry.scope).toBe('user');
    expect(await backend.exists('openpalm/custom/example')).toBe(true);

    const userEnv = readFileSync(join(state.vaultDir, 'user.env'), 'utf-8');
    expect(userEnv).toContain('very-secret');
  });

  test('validatePassEntryName rejects traversal and invalid characters', () => {
    expect(() => validatePassEntryName('../bad')).toThrow();
    expect(() => validatePassEntryName('openpalm/Bad Key')).toThrow();
    expect(validatePassEntryName('openpalm/custom/good-key')).toBe('openpalm/custom/good-key');
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
