import { describe, test, expect } from 'bun:test';
import { generateId, md5, safeJsonParse, removeCodeBlocks, parseMessages } from './index.js';

describe('generateId', () => {
  test('returns a valid UUID v4', () => {
    const id = generateId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  test('returns unique values on each call', () => {
    const a = generateId();
    const b = generateId();
    expect(a).not.toBe(b);
  });
});

describe('md5', () => {
  test('returns 32-char hex string', () => {
    const hash = md5('hello');
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  test('is deterministic', () => {
    expect(md5('test')).toBe(md5('test'));
  });

  test('differs for different inputs', () => {
    expect(md5('a')).not.toBe(md5('b'));
  });
});

describe('safeJsonParse', () => {
  test('parses valid JSON', () => {
    expect(safeJsonParse('{"key":"value"}')).toEqual({ key: 'value' });
  });

  test('returns null for invalid JSON', () => {
    expect(safeJsonParse('not json')).toBeNull();
  });

  test('strips markdown code fences', () => {
    const input = '```json\n{"key":"value"}\n```';
    expect(safeJsonParse(input)).toEqual({ key: 'value' });
  });

  test('handles empty string', () => {
    expect(safeJsonParse('')).toBeNull();
  });
});

describe('removeCodeBlocks', () => {
  test('removes json code fences', () => {
    expect(removeCodeBlocks('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test('removes plain code fences', () => {
    expect(removeCodeBlocks('```\nfoo\n```')).toBe('foo');
  });

  test('passes through text without fences', () => {
    expect(removeCodeBlocks('plain text')).toBe('plain text');
  });
});

describe('parseMessages', () => {
  test('joins messages with role prefix', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    expect(parseMessages(msgs)).toBe('user: hello\nassistant: hi');
  });

  test('returns empty string for empty array', () => {
    expect(parseMessages([])).toBe('');
  });
});
