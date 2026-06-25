/**
 * Tests for the C4 sensitivity split:
 *   - assertNoSecretLikeStackEnvKeys hygiene guard
 *   - patchSecretsEnvFile routing: non-sensitive → stack.env, sensitive → secret files
 *   - readStackEnv excludes secret-like keys that somehow ended up in stack.env
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertNoSecretLikeStackEnvKeys,
  patchSecretsEnvFile,
  readStackEnv,
  readStackSecretEnv,
} from './secrets.js';
import { readSecret } from './secrets-files.js';

// Each test gets a fresh temp dir shaped like an OP_HOME config/stack directory.
// The secrets functions take the OP_HOME root directly (knowledge/secrets is derived from it).
let home: string;
let stackDir: string;

function makeHome(): { home: string; stackDir: string } {
  const h = mkdtempSync(join(tmpdir(), 'openpalm-secrets-'));
  const sd = join(h, 'config', 'stack');
  mkdirSync(sd, { recursive: true });
  mkdirSync(join(h, 'knowledge', 'env'), { recursive: true });
  mkdirSync(join(h, 'knowledge', 'secrets'), { recursive: true });
  return { home: h, stackDir: sd };
}

beforeEach(() => {
  ({ home, stackDir } = makeHome());
});

afterEach(() => {
  // Cleanup happens via OS temp dir rotation; no rmSync needed here.
});

describe('assertNoSecretLikeStackEnvKeys hygiene guard', () => {
  it('allows non-sensitive keys', () => {
    expect(() => assertNoSecretLikeStackEnvKeys({ DISCORD_ALLOWED_GUILDS: '123' })).not.toThrow();
    expect(() => assertNoSecretLikeStackEnvKeys({ OP_VOICE_WHISPER_MODEL: 'base.en' })).not.toThrow();
    expect(() => assertNoSecretLikeStackEnvKeys({ DISCORD_REGISTER_COMMANDS: 'true' })).not.toThrow();
    expect(() => assertNoSecretLikeStackEnvKeys({ SLACK_ALLOWED_CHANNELS: 'C123' })).not.toThrow();
    expect(() => assertNoSecretLikeStackEnvKeys({ OP_VOICE_KOKORO_VOICE: 'bf_isabella' })).not.toThrow();
    expect(() => assertNoSecretLikeStackEnvKeys({ DISCORD_APPLICATION_ID: '999' })).not.toThrow();
  });

  it('blocks sensitive keys', () => {
    expect(() => assertNoSecretLikeStackEnvKeys({ DISCORD_BOT_TOKEN: 'tok' })).toThrow(/DISCORD_BOT_TOKEN/);
    expect(() => assertNoSecretLikeStackEnvKeys({ SLACK_BOT_TOKEN: 'xoxb' })).toThrow(/SLACK_BOT_TOKEN/);
    expect(() => assertNoSecretLikeStackEnvKeys({ OPENAI_API_KEY: 'sk-test' })).toThrow(/OPENAI_API_KEY/);
    expect(() => assertNoSecretLikeStackEnvKeys({ SLACK_APP_TOKEN: 'xapp' })).toThrow(/SLACK_APP_TOKEN/);
  });
});

describe('patchSecretsEnvFile sensitivity routing', () => {
  it('writes non-sensitive keys to stack.env', () => {
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'), '# config\n');

    patchSecretsEnvFile(home, { DISCORD_ALLOWED_GUILDS: '12345' });

    const content = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');
    expect(content).toContain('DISCORD_ALLOWED_GUILDS=12345');
  });

  it('routes sensitive keys to secret files, not stack.env', () => {
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'), '# config\n');

    // patchSecretsEnvFile splits by SECRET_ENV_KEY_RE (token/secret/password/api_key)
    patchSecretsEnvFile(home, { OP_UI_LOGIN_PASSWORD: 'hunter2' });

    const stackContent = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');
    expect(stackContent).not.toContain('hunter2');
    expect(stackContent).not.toContain('OP_UI_LOGIN_PASSWORD');

    const secretValue = readSecret(home, 'op_ui_login_password');
    expect(secretValue?.trim()).toBe('hunter2');
  });

  it('merges multiple non-sensitive keys into stack.env without duplicating', () => {
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'),
      'DISCORD_ALLOWED_GUILDS=old\n');

    patchSecretsEnvFile(home, {
      DISCORD_ALLOWED_GUILDS: 'new',
      OP_VOICE_WHISPER_MODEL: 'large',
    });

    const content = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');
    expect(content).toContain('DISCORD_ALLOWED_GUILDS=new');
    expect(content).toContain('OP_VOICE_WHISPER_MODEL=large');
    const count = (content.match(/^DISCORD_ALLOWED_GUILDS=/mg) ?? []).length;
    expect(count).toBe(1);
  });
});

describe('readStackEnv excludes secret-like keys', () => {
  it('returns non-sensitive keys from stack.env', () => {
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'),
      'DISCORD_ALLOWED_GUILDS=123\nOP_SETUP_COMPLETE=true\n');

    const env = readStackEnv(home);
    expect(env.DISCORD_ALLOWED_GUILDS).toBe('123');
    expect(env.OP_SETUP_COMPLETE).toBe('true');
  });

  it('strips secret-like keys even if they somehow appear in stack.env', () => {
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'),
      'DISCORD_BOT_TOKEN=secret-leak\nDISCORD_ALLOWED_GUILDS=ok\n');

    const env = readStackEnv(home);
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(env.DISCORD_ALLOWED_GUILDS).toBe('ok');
  });
});

describe('readStackSecretEnv reads from secret files', () => {
  it('reads back a written secret', () => {
    writeFileSync(join(home, 'knowledge', 'secrets', 'discord_bot_token'), 'tok-abc\n');

    const env = readStackSecretEnv(home);
    expect(env.DISCORD_BOT_TOKEN).toBe('tok-abc');
  });

  it('does not include files with dots in their name (filtered by listSecretNames)', () => {
    // listSecretNames uses SECRET_NAME_RE = /^[a-z0-9][a-z0-9_]{0,80}$/ which
    // excludes dots/dashes — so auth.json is never returned as a secret name.
    writeFileSync(join(home, 'knowledge', 'secrets', 'auth.json'), '{}');
    const env = readStackSecretEnv(home);
    // auth.json should not appear as AUTH.JSON or any key
    expect(Object.keys(env).some((k) => k.includes('.'))).toBe(false);
    expect(env['AUTH.JSON']).toBeUndefined();
  });
});
