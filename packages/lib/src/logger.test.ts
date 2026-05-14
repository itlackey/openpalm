/**
 * Tests for the in-house log redactor introduced in #391 (replacing varlock).
 *
 * The contract:
 *   - keys matching `_TOKEN | _SECRET | _KEY | _PASSWORD` (case-insensitive)
 *     have their string value replaced with `'***REDACTED***'`.
 *   - non-secret keys are passed through unchanged.
 *   - nested objects and arrays are walked recursively.
 *   - createLogger() applies the same masking before writing to stdout/stderr.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createLogger,
  isSensitiveEnvKey,
  redactValue,
  redactExtra,
} from './logger.js';

describe('redactValue', () => {
  test('masks values for sensitive key suffixes', () => {
    expect(redactValue('OPENAI_API_KEY', 'sk-abc')).toBe('***REDACTED***');
    expect(redactValue('SLACK_BOT_TOKEN', 'xoxb-123')).toBe('***REDACTED***');
    expect(redactValue('CHANNEL_DISCORD_SECRET', 'hmac-bytes')).toBe('***REDACTED***');
    expect(redactValue('OP_OPENCODE_PASSWORD', 'hunter2')).toBe('***REDACTED***');
  });

  test('matches case-insensitively', () => {
    expect(redactValue('openai_api_key', 'sk-xyz')).toBe('***REDACTED***');
    expect(redactValue('My_Token', 'abc')).toBe('***REDACTED***');
  });

  test('leaves non-secret values alone', () => {
    expect(redactValue('OWNER_NAME', 'alice')).toBe('alice');
    expect(redactValue('OP_HOME', '/openpalm')).toBe('/openpalm');
    expect(redactValue('OP_CAP_LLM_PROVIDER', 'openai')).toBe('openai');
  });
});

describe('isSensitiveEnvKey', () => {
  test('returns true for token/secret/key/password suffix keys', () => {
    expect(isSensitiveEnvKey('FOO_TOKEN')).toBe(true);
    expect(isSensitiveEnvKey('FOO_SECRET')).toBe(true);
    expect(isSensitiveEnvKey('FOO_KEY')).toBe(true);
    expect(isSensitiveEnvKey('FOO_PASSWORD')).toBe(true);
  });

  test('returns false for ordinary keys', () => {
    expect(isSensitiveEnvKey('OWNER_NAME')).toBe(false);
    expect(isSensitiveEnvKey('OP_HOME')).toBe(false);
  });
});

describe('redactExtra', () => {
  test('masks top-level secret string values', () => {
    const result = redactExtra({
      OPENAI_API_KEY: 'sk-abc',
      OWNER_NAME: 'alice',
    });
    expect(result).toEqual({
      OPENAI_API_KEY: '***REDACTED***',
      OWNER_NAME: 'alice',
    });
  });

  test('walks nested objects', () => {
    const result = redactExtra({
      env: {
        OPENAI_API_KEY: 'sk-abc',
        OWNER_NAME: 'alice',
      },
    });
    expect(result).toEqual({
      env: {
        OPENAI_API_KEY: '***REDACTED***',
        OWNER_NAME: 'alice',
      },
    });
  });

  test('handles arrays of objects', () => {
    const result = redactExtra({
      items: [
        { OPENAI_API_KEY: 'sk-1' },
        { OWNER_NAME: 'bob' },
      ],
    });
    expect(result).toEqual({
      items: [
        { OPENAI_API_KEY: '***REDACTED***' },
        { OWNER_NAME: 'bob' },
      ],
    });
  });

  test('returns primitive inputs unchanged', () => {
    expect(redactExtra('plain')).toBe('plain');
    expect(redactExtra(42)).toBe(42);
    expect(redactExtra(null)).toBe(null);
  });
});

describe('createLogger', () => {
  const origLog = console.log;
  const origErr = console.error;
  let logged: string[] = [];

  beforeEach(() => {
    logged = [];
    console.log = (...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(' '));
    };
    console.error = (...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(' '));
    };
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
  });

  test('redacts sensitive keys in the extra payload before writing the log line', () => {
    const logger = createLogger('test');
    logger.info('msg', { OPENAI_API_KEY: 'sk-leak', OWNER_NAME: 'alice' });
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain('"OPENAI_API_KEY":"***REDACTED***"');
    expect(logged[0]).toContain('"OWNER_NAME":"alice"');
    expect(logged[0]).not.toContain('sk-leak');
  });

  test('error level still goes through redaction', () => {
    const logger = createLogger('test');
    logger.error('boom', { OP_ADMIN_TOKEN: 'tok-leak' });
    expect(logged[0]).toContain('"OP_ADMIN_TOKEN":"***REDACTED***"');
    expect(logged[0]).not.toContain('tok-leak');
  });
});
