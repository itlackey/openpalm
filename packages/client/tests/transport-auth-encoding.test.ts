/**
 * E8 [LOW] (review 2026-07-10 §E8) — `authorizationHeader()` used `btoa()`
 * directly, which throws `InvalidCharacterError` synchronously (before any
 * I/O) on a non-Latin-1 password. UTF-8-encode the credentials before
 * base64-encoding them, mirroring the old broker's UTF-8 Buffer encoding.
 *
 * New file — does not modify the shared tests/helpers/*.ts contract.
 */
import { describe, expect, test } from 'bun:test';
import { jsonResponse, recordingFetch } from './helpers/mocks.ts';

async function loadTransportModule() {
  return import('../src/lib/transport/index.ts');
}

const BASE = 'http://gw.example:8443';

/** UTF-8-correct base64, independent of the implementation under test. */
function expectedBasic(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

describe('authorizationHeader UTF-8 encoding (E8)', () => {
  test('a non-Latin-1 password no longer throws InvalidCharacterError', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse([]));
    const transport = createTransport({
      baseUrl: BASE,
      auth: { mode: 'basic', username: 'alice', password: 'пароль-密码-🔒' },
      fetch,
    });
    // Must not throw synchronously building the header.
    await transport.listSessions();
    expect(calls[0].headers.get('authorization')).toBe(
      expectedBasic('alice', 'пароль-密码-🔒')
    );
  });

  test('ASCII credentials still round-trip to the same header as plain btoa', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse([]));
    const transport = createTransport({
      baseUrl: BASE,
      auth: { mode: 'basic', username: 'alice', password: 's3cret' },
      fetch,
    });
    await transport.listSessions();
    expect(calls[0].headers.get('authorization')).toBe(`Basic ${btoa('alice:s3cret')}`);
  });

  test('P2-2: a password-only Basic connection defaults the username to opencode', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse([]));
    const transport = createTransport({
      baseUrl: BASE,
      auth: { mode: 'basic', password: 's3cret' },
      fetch,
    });
    await transport.listSessions();
    expect(calls[0].headers.get('authorization')).toBe(`Basic ${btoa('opencode:s3cret')}`);
  });

  test('probeHealth also builds the header without throwing for a non-Latin-1 password', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch } = recordingFetch(() => new Response('ok', { status: 200 }));
    const transport = createTransport({
      baseUrl: BASE,
      auth: { mode: 'basic', username: 'bob', password: 'mötörhead' },
      fetch,
    });
    const result = await transport.probeHealth();
    expect(result.state).toBe('accessible');
  });
});
