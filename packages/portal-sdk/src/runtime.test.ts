/**
 * Characterization tests for the shared runtime helpers extracted into the SDK:
 * `parseIdList` and `splitMessage`. These pin the exact splitting/parsing
 * behavior the two portals relied on before the extraction. (ConversationQueue
 * and OcClient are covered by session.test.ts and opencode.test.ts.)
 */
import { describe, expect, it } from 'bun:test';
import { parseIdList, splitMessage } from './runtime.ts';

describe('parseIdList', () => {
  it('returns an empty set for undefined/empty/whitespace', () => {
    expect(parseIdList(undefined).size).toBe(0);
    expect(parseIdList('').size).toBe(0);
    expect(parseIdList('   ').size).toBe(0);
  });

  it('splits, trims, and de-duplicates', () => {
    const out = parseIdList(' a , b ,a, ');
    expect(out.size).toBe(2);
    expect(out.has('a')).toBe(true);
    expect(out.has('b')).toBe(true);
  });

  it('handles a single value without commas', () => {
    expect([...parseIdList('solo')]).toEqual(['solo']);
  });
});

describe('splitMessage', () => {
  it('returns [] for empty input', () => {
    expect(splitMessage('', 100)).toEqual([]);
  });

  it('returns the whole string when within the limit', () => {
    expect(splitMessage('short', 100)).toEqual(['short']);
  });

  it('splits long plain text into chunks under the limit', () => {
    const text = 'x'.repeat(250);
    const chunks = splitMessage(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join('')).toBe(text);
  });

  it('prefers to break on paragraph then line boundaries', () => {
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}`;
    const chunks = splitMessage(text, 100);
    expect(chunks[0]).toBe('a'.repeat(60));
    expect(chunks[1]).toBe('b'.repeat(60));
  });

  it('keeps an open code fence balanced across a split', () => {
    const text = `\`\`\`ts\n${'const x = 1;\n'.repeat(20)}\`\`\``;
    const chunks = splitMessage(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk has an even number of fences (each is self-contained).
    for (const c of chunks) {
      expect((c.match(/```/g) || []).length % 2).toBe(0);
    }
    // The continuation re-opens the fence, preserving the language tag.
    expect(chunks[1].startsWith('```ts')).toBe(true);
  });

  it('drops empty chunks', () => {
    for (const c of splitMessage('a'.repeat(300), 50)) expect(c.length).toBeGreaterThan(0);
  });
});
