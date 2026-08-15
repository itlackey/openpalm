/**
 * Upstream Basic auth to the assistant — always resolved, fail-closed at boot.
 *
 * The assistant's OpenCode always authenticates, so a guardian that cannot
 * build the header must refuse to boot loudly (these throws) rather than 401
 * on every forwarded portal call at request time.
 */
import { describe, expect, test } from 'bun:test';
import { resolveAssistantUpstreamAuth } from './config.ts';

const FILE = '/run/secrets/opencode_server_password';

function readerReturning(value: string): (path: string) => string {
  return (path) => {
    if (path !== FILE) throw new Error(`unexpected path ${path}`);
    return value;
  };
}

describe('resolveAssistantUpstreamAuth', () => {
  test('always builds the header from the secret file', () => {
    const auth = resolveAssistantUpstreamAuth(
      { OPENCODE_SERVER_PASSWORD_FILE: FILE },
      readerReturning('s3cret\n'),
    );
    expect(auth.authorization).toBe(`Basic ${Buffer.from('opencode:s3cret').toString('base64')}`);
  });

  test('strips ONLY trailing newlines — the entrypoint reads with $(cat)', () => {
    // Command substitution strips trailing newlines and nothing else; a
    // divergent trim here produced a silent 401 storm once already (#564).
    const auth = resolveAssistantUpstreamAuth(
      { OPENCODE_SERVER_PASSWORD_FILE: FILE },
      readerReturning('  spaced key  \n\n'),
    );
    expect(auth.authorization).toBe(
      `Basic ${Buffer.from('opencode:  spaced key  ').toString('base64')}`,
    );
  });

  test('honors OPENCODE_SERVER_USERNAME', () => {
    const auth = resolveAssistantUpstreamAuth(
      { OPENCODE_SERVER_PASSWORD_FILE: FILE, OPENCODE_SERVER_USERNAME: 'operator' },
      readerReturning('k'),
    );
    expect(auth.authorization).toBe(`Basic ${Buffer.from('operator:k').toString('base64')}`);
  });

  test('boot-fails when the file variable is missing', () => {
    expect(() => resolveAssistantUpstreamAuth({}, readerReturning('x'))).toThrow(
      /OPENCODE_SERVER_PASSWORD_FILE is not set/,
    );
  });

  test('boot-fails when the file is unreadable', () => {
    expect(() =>
      resolveAssistantUpstreamAuth({ OPENCODE_SERVER_PASSWORD_FILE: FILE }, () => {
        throw new Error('ENOENT');
      }),
    ).toThrow(/could not be read/);
  });

  test('boot-fails on an empty or whitespace-only file', () => {
    for (const value of ['', '\n', '   \n']) {
      expect(() =>
        resolveAssistantUpstreamAuth({ OPENCODE_SERVER_PASSWORD_FILE: FILE }, readerReturning(value)),
      ).toThrow(/is empty/);
    }
  });
});
