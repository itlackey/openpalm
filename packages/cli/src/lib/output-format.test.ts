import { describe, expect, it } from 'bun:test';
import { parseOutputFormat } from './output-format.ts';

describe('parseOutputFormat', () => {
  it('defaults to json when unset', () => {
    expect(parseOutputFormat(undefined)).toBe('json');
    expect(parseOutputFormat(null)).toBe('json');
  });

  it('accepts json and human', () => {
    expect(parseOutputFormat('json')).toBe('json');
    expect(parseOutputFormat('human')).toBe('human');
  });

  it('is case-insensitive', () => {
    expect(parseOutputFormat('JSON')).toBe('json');
    expect(parseOutputFormat('Human')).toBe('human');
  });

  it('returns null for unrecognized values', () => {
    expect(parseOutputFormat('yaml')).toBeNull();
    expect(parseOutputFormat('')).toBeNull();
    expect(parseOutputFormat('json ')).toBeNull();
  });
});
