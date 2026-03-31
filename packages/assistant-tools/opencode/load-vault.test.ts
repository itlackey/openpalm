import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { parseEnvContent } from './tools/load_vault.ts';

describe('load_vault parseEnvContent', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Snapshot env vars we might set during tests
    for (const key of ['FOO', 'BAR', 'BAZ', 'QUOTED', 'SINGLE', 'EXPORTED', 'PREFIX_A', 'PREFIX_B', 'OTHER', 'EMPTY_VAL']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore original env state
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('loads simple key=value pairs', () => {
    const content = 'FOO=hello\nBAR=world';
    const result = parseEnvContent(content, {});
    expect(result.loaded).toEqual(['FOO', 'BAR']);
    expect(result.skipped).toEqual([]);
    expect(process.env.FOO).toBe('hello');
    expect(process.env.BAR).toBe('world');
  });

  it('skips comments and blank lines', () => {
    const content = '# comment\n\nFOO=value\n  # another comment\n';
    const result = parseEnvContent(content, {});
    expect(result.loaded).toEqual(['FOO']);
  });

  it('skips lines without = sign', () => {
    const content = 'NOEQUALS\nFOO=ok';
    const result = parseEnvContent(content, {});
    expect(result.loaded).toEqual(['FOO']);
  });

  it('strips double quotes from values', () => {
    const content = 'QUOTED="hello world"';
    const result = parseEnvContent(content, {});
    expect(result.loaded).toEqual(['QUOTED']);
    expect(process.env.QUOTED).toBe('hello world');
  });

  it('strips single quotes from values', () => {
    const content = "SINGLE='hello world'";
    const result = parseEnvContent(content, {});
    expect(result.loaded).toEqual(['SINGLE']);
    expect(process.env.SINGLE).toBe('hello world');
  });

  it('handles export prefix', () => {
    const content = 'export EXPORTED=val';
    const result = parseEnvContent(content, {});
    expect(result.loaded).toEqual(['EXPORTED']);
    expect(process.env.EXPORTED).toBe('val');
  });

  it('skips empty values', () => {
    const content = 'EMPTY_VAL=\nFOO=ok';
    const result = parseEnvContent(content, {});
    expect(result.loaded).toEqual(['FOO']);
    expect(process.env.EMPTY_VAL).toBeUndefined();
  });

  it('skips existing env vars when override is false', () => {
    process.env.FOO = 'existing';
    const content = 'FOO=new\nBAR=fresh';
    const result = parseEnvContent(content, { override: false });
    expect(result.loaded).toEqual(['BAR']);
    expect(result.skipped).toEqual(['FOO']);
    expect(process.env.FOO).toBe('existing');
  });

  it('overrides existing env vars when override is true', () => {
    process.env.FOO = 'existing';
    const content = 'FOO=new';
    const result = parseEnvContent(content, { override: true });
    expect(result.loaded).toEqual(['FOO']);
    expect(result.skipped).toEqual([]);
    expect(process.env.FOO).toBe('new');
  });

  it('treats empty-string env var as existing (skips without override)', () => {
    process.env.FOO = '';
    const content = 'FOO=new';
    const result = parseEnvContent(content, { override: false });
    expect(result.skipped).toEqual(['FOO']);
    expect(process.env.FOO).toBe('');
  });

  it('filters by prefix', () => {
    const content = 'PREFIX_A=1\nPREFIX_B=2\nOTHER=3';
    const result = parseEnvContent(content, { prefix: 'PREFIX_' });
    expect(result.loaded).toEqual(['PREFIX_A', 'PREFIX_B']);
    expect(process.env.OTHER).toBeUndefined();
  });

  it('returns empty arrays for empty content', () => {
    const result = parseEnvContent('', {});
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
