/**
 * PR #564 P2-1: the host Basic-auth encoder must produce the exact same bytes
 * the assistant/guardian expect — UTF-8, surrounding spaces preserved — across
 * ASCII, spaces, accents, CJK, and emoji.
 */
import { describe, expect, it } from 'vitest';
import { basicAuthHeader, stripTrailingNewlines, DEFAULT_OPENCODE_USERNAME } from './basic-auth.js';

/** The reference encoding the guardian uses (config.ts): Buffer UTF-8 → base64. */
function guardianEncoding(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf-8').toString('base64')}`;
}

describe('basicAuthHeader — UTF-8 parity with the guardian/assistant', () => {
  const cases: Array<[string, string]> = [
    ['opencode', 's3cret'], // ASCII
    ['opencode', 'päss 🔒 '], // accents + emoji + TRAILING SPACE (must be preserved)
    ['opencode', '  leading-and-trailing  '], // surrounding spaces
    ['opencode', '密码-パスワード'], // CJK / Japanese
    ['alice', 'naïve-café-Ωmega'], // accented, custom username
  ];

  for (const [user, pw] of cases) {
    it(`encodes ${JSON.stringify(pw)} identically to the guardian`, () => {
      expect(basicAuthHeader(user, pw)).toBe(guardianEncoding(user, pw));
    });
  }

  it('never throws on non-Latin-1 bytes (unlike btoa)', () => {
    expect(() => basicAuthHeader('opencode', '🔒🔥')).not.toThrow();
  });

  it('exposes opencode as the default username', () => {
    expect(DEFAULT_OPENCODE_USERNAME).toBe('opencode');
  });
});

describe('stripTrailingNewlines — matches the assistant entrypoint $(cat)', () => {
  it('strips only trailing newlines, preserving surrounding spaces', () => {
    expect(stripTrailingNewlines('päss 🔒 \n')).toBe('päss 🔒 ');
    expect(stripTrailingNewlines('secret\n\n')).toBe('secret');
    expect(stripTrailingNewlines('  spaced  ')).toBe('  spaced  ');
    expect(stripTrailingNewlines('no-newline')).toBe('no-newline');
  });
});
