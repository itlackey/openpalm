/**
 * Tests for the in-house log redactor introduced in #391 (replacing varlock).
 *
 * The contract:
 *   - keys matching the word-bounded pattern
 *     `(^|_)(TOKEN|SECRET|KEY|PASSWORD|HMAC)(_|$)` (case-insensitive)
 *     have their value replaced with `'***REDACTED***'`.
 *   - substring false positives (e.g. `MONKEY`, `PACKET_SIZE`) are NOT redacted.
 *   - non-string sensitive values (numbers, booleans) are still redacted.
 *   - non-secret keys are passed through unchanged.
 *   - nested objects and arrays are walked recursively.
 *   - createLogger() applies the same masking before writing to stdout/stderr
 *     at every log level (debug/info/warn/error).
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
    expect(redactValue('OP_ASSISTANT_PORT', '3800')).toBe('3800');
  });
});

describe('isSensitiveEnvKey', () => {
  test('returns true for token/secret/key/password/hmac suffix keys', () => {
    expect(isSensitiveEnvKey('FOO_TOKEN')).toBe(true);
    expect(isSensitiveEnvKey('FOO_SECRET')).toBe(true);
    expect(isSensitiveEnvKey('FOO_KEY')).toBe(true);
    expect(isSensitiveEnvKey('FOO_PASSWORD')).toBe(true);
    expect(isSensitiveEnvKey('CHANNEL_FOO_HMAC')).toBe(true);
    expect(isSensitiveEnvKey('OP_UI_TOKEN')).toBe(true);
    expect(isSensitiveEnvKey('CHANNEL_API_KEY')).toBe(true);
  });

  test('returns true for bare or prefix forms', () => {
    expect(isSensitiveEnvKey('TOKEN')).toBe(true);
    expect(isSensitiveEnvKey('SECRET')).toBe(true);
    expect(isSensitiveEnvKey('KEY')).toBe(true);
    expect(isSensitiveEnvKey('HMAC_KEY')).toBe(true);
    expect(isSensitiveEnvKey('PASSWORD_HASH')).toBe(true);
  });

  test('returns false for substring false positives', () => {
    // MONKEY contains the substring KEY but no underscore boundary.
    expect(isSensitiveEnvKey('MONKEY')).toBe(false);
    // PACKET_SIZE: KET is not one of the words; ET_SIZE is unrelated.
    expect(isSensitiveEnvKey('PACKET_SIZE')).toBe(false);
    // MARKETING_KEYWORD: KEYWORD does not have a trailing underscore or EOL.
    expect(isSensitiveEnvKey('MARKETING_KEYWORD')).toBe(false);
    // KEYBOARD: starts with KEY but not followed by underscore or EOL.
    expect(isSensitiveEnvKey('KEYBOARD')).toBe(false);
  });

  test('returns false for ordinary keys', () => {
    expect(isSensitiveEnvKey('OWNER_NAME')).toBe(false);
    expect(isSensitiveEnvKey('OP_HOME')).toBe(false);
    expect(isSensitiveEnvKey('OP_ASSISTANT_PORT')).toBe(false);
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

  test('redacts non-string sensitive values (numbers, booleans)', () => {
    const result = redactExtra({
      OP_UI_TOKEN: 12345,
      OPENAI_API_KEY: true,
      OWNER_NAME: 'alice',
    });
    expect(result).toEqual({
      OP_UI_TOKEN: '***REDACTED***',
      OPENAI_API_KEY: '***REDACTED***',
      OWNER_NAME: 'alice',
    });
  });

  test('does not redact substring false positives', () => {
    const result = redactExtra({
      MONKEY: 'banana',
      PACKET_SIZE: 1500,
      MARKETING_KEYWORD: 'free',
      OPENAI_API_KEY: 'sk-leak',
    });
    expect(result).toEqual({
      MONKEY: 'banana',
      PACKET_SIZE: 1500,
      MARKETING_KEYWORD: 'free',
      OPENAI_API_KEY: '***REDACTED***',
    });
  });

  test('redacts CHANNEL_FOO_HMAC values', () => {
    const result = redactExtra({ CHANNEL_DISCORD_HMAC: 'hmac-bytes' });
    expect(result).toEqual({ CHANNEL_DISCORD_HMAC: '***REDACTED***' });
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
    logger.error('boom', { OP_UI_TOKEN: 'tok-leak' });
    expect(logged[0]).toContain('"OP_UI_TOKEN":"***REDACTED***"');
    expect(logged[0]).not.toContain('tok-leak');
  });

  test('warn level applies redaction', () => {
    const logger = createLogger('test');
    logger.warn('caution', { CHANNEL_API_KEY: 'warn-leak' });
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain('"CHANNEL_API_KEY":"***REDACTED***"');
    expect(logged[0]).not.toContain('warn-leak');
  });

  test('debug level applies redaction', () => {
    const logger = createLogger('test');
    logger.debug('detail', { CHANNEL_FOO_HMAC: 'debug-leak' });
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain('"CHANNEL_FOO_HMAC":"***REDACTED***"');
    expect(logged[0]).not.toContain('debug-leak');
  });

  test('substring false positives are not redacted at log time', () => {
    const logger = createLogger('test');
    logger.info('msg', { MONKEY: 'banana', PACKET_SIZE: 1500 });
    expect(logged[0]).toContain('"MONKEY":"banana"');
    expect(logged[0]).toContain('"PACKET_SIZE":1500');
    expect(logged[0]).not.toContain('***REDACTED***');
  });

  test('non-string sensitive values are redacted at log time', () => {
    const logger = createLogger('test');
    logger.info('msg', { OP_UI_TOKEN: 12345 });
    expect(logged[0]).toContain('"OP_UI_TOKEN":"***REDACTED***"');
    expect(logged[0]).not.toContain('12345');
  });
});
