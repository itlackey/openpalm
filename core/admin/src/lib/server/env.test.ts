import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvContent, parseEnvFile, mergeEnvContent } from './env.js';

describe('parseEnvContent', () => {
  test('parses simple KEY=value lines', () => {
    const result = parseEnvContent('FOO=bar\nBAZ=qux');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  test('skips comments and blank lines', () => {
    const result = parseEnvContent('# comment\n\nFOO=bar\n\n# another\nBAZ=qux');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  test('handles double-quoted values', () => {
    const result = parseEnvContent('KEY="hello world"');
    expect(result.KEY).toBe('hello world');
  });

  test('handles single-quoted values', () => {
    const result = parseEnvContent("KEY='hello world'");
    expect(result.KEY).toBe('hello world');
  });

  test('strips inline comments from unquoted values', () => {
    const result = parseEnvContent('KEY=value # this is a comment');
    expect(result.KEY).toBe('value');
  });

  test('preserves # in quoted values', () => {
    const result = parseEnvContent('KEY="value # not a comment"');
    expect(result.KEY).toBe('value # not a comment');
  });

  test('handles = in values', () => {
    const result = parseEnvContent('URL=http://host:8080/path?a=b');
    expect(result.URL).toBe('http://host:8080/path?a=b');
  });

  test('handles empty values', () => {
    const result = parseEnvContent('KEY=');
    expect(result.KEY).toBe('');
  });

  test('handles empty input', () => {
    expect(parseEnvContent('')).toEqual({});
  });
});

describe('parseEnvFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `openpalm-env-test-${randomBytes(4).toString('hex')}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns empty object for non-existent file', () => {
    expect(parseEnvFile(join(tmpDir, 'missing.env'))).toEqual({});
  });

  test('parses an existing .env file', () => {
    writeFileSync(join(tmpDir, 'test.env'), 'FOO=bar\nBAZ=qux\n');
    const result = parseEnvFile(join(tmpDir, 'test.env'));
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });
});

describe('mergeEnvContent', () => {
  test('updates existing keys in-place', () => {
    const input = 'FOO=old\nBAR=keep\n';
    const result = mergeEnvContent(input, { FOO: 'new' });
    expect(result).toContain('FOO=new');
    expect(result).toContain('BAR=keep');
    expect(result).not.toContain('old');
  });

  test('appends missing keys', () => {
    const input = 'FOO=bar\n';
    const result = mergeEnvContent(input, { NEW_KEY: 'value' });
    expect(result).toContain('FOO=bar');
    expect(result).toContain('NEW_KEY=value');
  });

  test('preserves comments and blank lines', () => {
    const input = '# header comment\n\nFOO=old\n\n# section\nBAR=keep\n';
    const result = mergeEnvContent(input, { FOO: 'new' });
    expect(result).toContain('# header comment');
    expect(result).toContain('# section');
    expect(result).toContain('FOO=new');
    expect(result).toContain('BAR=keep');
  });

  test('uncomments commented-out keys when uncomment=true', () => {
    const input = '# FOO=old\nBAR=keep\n';
    const result = mergeEnvContent(input, { FOO: 'new' }, { uncomment: true });
    expect(result).toContain('FOO=new');
    expect(result).not.toContain('# FOO');
  });

  test('does not uncomment when uncomment=false (default)', () => {
    const input = '# FOO=old\nBAR=keep\n';
    const result = mergeEnvContent(input, { FOO: 'new' });
    expect(result).toContain('# FOO=old');
    expect(result).toContain('FOO=new');
  });

  test('adds section header when appending', () => {
    const input = 'FOO=bar\n';
    const result = mergeEnvContent(input, { NEW: 'val' }, {
      sectionHeader: '# ── New Section ──'
    });
    expect(result).toContain('# ── New Section ──');
    expect(result).toContain('NEW=val');
  });

  test('handles empty input', () => {
    const result = mergeEnvContent('', { KEY: 'value' });
    expect(result).toContain('KEY=value');
  });

  test('handles empty updates', () => {
    const input = 'FOO=bar\n';
    const result = mergeEnvContent(input, {});
    expect(result).toBe(input);
  });

  test('quotes values containing # so they round-trip through dotenv', () => {
    const result = mergeEnvContent('', { API_KEY: 'sk_live#abc' });
    const parsed = parseEnvContent(result);
    expect(parsed.API_KEY).toBe('sk_live#abc');
  });

  test('quotes values containing double quotes', () => {
    const result = mergeEnvContent('', { MSG: 'say "hello"' });
    const parsed = parseEnvContent(result);
    expect(parsed.MSG).toBe('say "hello"');
  });

  test('quotes values containing newlines via double quotes', () => {
    const result = mergeEnvContent('', { CERT: 'line1\nline2' });
    const parsed = parseEnvContent(result);
    expect(parsed.CERT).toBe('line1\nline2');
  });

  test('quotes values with leading/trailing spaces', () => {
    const result = mergeEnvContent('', { KEY: ' spaced ' });
    const parsed = parseEnvContent(result);
    expect(parsed.KEY).toBe(' spaced ');
  });

  test('does not quote simple values', () => {
    const result = mergeEnvContent('', { SIMPLE: 'hello123' });
    expect(result).toContain('SIMPLE=hello123');
    expect(result).not.toContain('"');
    expect(result).not.toContain("'");
  });

  test('round-trips complex values when updating existing keys', () => {
    const input = 'SECRET=old_value\n';
    const result = mergeEnvContent(input, { SECRET: 'new#value' });
    const parsed = parseEnvContent(result);
    expect(parsed.SECRET).toBe('new#value');
  });

  test('handles values with backslashes', () => {
    const result = mergeEnvContent('', { WINPATH: 'C:\\Users\\test' });
    const parsed = parseEnvContent(result);
    expect(parsed.WINPATH).toBe('C:\\Users\\test');
  });

  test('uses single quotes for # values (preferred, fully literal)', () => {
    const result = mergeEnvContent('', { KEY: 'val#ue' });
    expect(result).toContain("KEY='val#ue'");
  });

  test('falls back to double quotes when value contains single quotes', () => {
    const result = mergeEnvContent('', { KEY: "it's#here" });
    expect(result).toContain('KEY="it\'s#here"');
    const parsed = parseEnvContent(result);
    expect(parsed.KEY).toBe("it's#here");
  });
});
