/**
 * Characterization tests for the shared runtime helpers extracted into the SDK:
 * `parseIdList` and `splitMessage`. These pin the exact splitting/parsing
 * behavior the two portals relied on before the extraction. (ConversationQueue
 * and OcClient are covered by session.test.ts and opencode.test.ts.)
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIdList, readRequiredSecret, SecretFileError, splitMessage } from './runtime.ts';

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

/**
 * `readRequiredSecret` — the D3 direct-env secret fallback. `_FILE` beats a
 * direct var for the same key (Compose-secrets discipline wins); everything
 * fails closed. Env is passed explicitly (the function's second param) rather
 * than mutating Bun.env, mirroring readRequiredSecretFile's existing
 * signature — only the `_FILE` cases need a real temp file on disk.
 *
 * `readRequiredSecret` is not exported yet — this import fails to resolve,
 * failing every test below at load time (red stage).
 */
function withTempSecretFile(value: string, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'openpalm-secret-test-'));
  const path = join(dir, 'secret');
  writeFileSync(path, value);
  try {
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('readRequiredSecret', () => {
  it('reads the _FILE variant when set', () => {
    withTempSecretFile('s3cret\n', (path) => {
      const value = readRequiredSecret('PRINCIPAL_SECRET', { PRINCIPAL_SECRET_FILE: path });
      expect(value).toBe('s3cret');
    });
  });

  it('falls back to the direct env var when the _FILE variant is unset', () => {
    const value = readRequiredSecret('PRINCIPAL_SECRET', { PRINCIPAL_SECRET: 'direct' });
    expect(value).toBe('direct');
  });

  it('_FILE takes precedence over the direct var for the same key', () => {
    withTempSecretFile('from-file', (path) => {
      const value = readRequiredSecret('PRINCIPAL_SECRET', {
        PRINCIPAL_SECRET_FILE: path,
        PRINCIPAL_SECRET: 'direct',
      });
      expect(value).toBe('from-file');
    });
  });

  it('fails closed when a configured _FILE path is unreadable, even if the direct var is set', () => {
    expect(() =>
      readRequiredSecret('PRINCIPAL_SECRET', {
        PRINCIPAL_SECRET_FILE: '/nonexistent',
        PRINCIPAL_SECRET: 'direct',
      }),
    ).toThrow(SecretFileError);
  });

  it('tries keys in priority order', () => {
    expect(
      readRequiredSecret(['PRINCIPAL_SECRET', 'OPENCODE_PASSWORD'], { OPENCODE_PASSWORD: 'pw' }),
    ).toBe('pw');
    expect(
      readRequiredSecret(['PRINCIPAL_SECRET', 'OPENCODE_PASSWORD'], {
        PRINCIPAL_SECRET: 'ps',
        OPENCODE_PASSWORD: 'pw',
      }),
    ).toBe('ps');
  });

  it('throws SecretFileError naming every accepted variable when nothing is configured', () => {
    try {
      readRequiredSecret(['PRINCIPAL_SECRET', 'OPENCODE_PASSWORD'], {});
      throw new Error('expected readRequiredSecret to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretFileError);
      const message = (err as Error).message;
      expect(message).toContain('PRINCIPAL_SECRET_FILE');
      expect(message).toContain('PRINCIPAL_SECRET');
      expect(message).toContain('OPENCODE_PASSWORD');
    }
  });

  it('ignores whitespace-only direct values', () => {
    expect(() => readRequiredSecret('PRINCIPAL_SECRET', { PRINCIPAL_SECRET: '   ' })).toThrow(SecretFileError);
  });
});
