/**
 * P5b (#555) RED — transport request shaping (plan §6.11: "ONE transport:
 * guardian/OpenCode base URL + credentials"; P5b item 1).
 *
 * The client talks to a connection's base URL DIRECTLY from the browser: no
 * same-origin proxy, no op_session cookie. These tests pin:
 *   - base URL + API path joining (trailing slash / path-prefix safe),
 *   - Basic auth header derived from connection credentials (username
 *     defaults to 'openpalm', mirroring the host app's probeEndpoint()),
 *   - Bearer mode,
 *   - cookie hygiene: every request sets credentials 'omit' and never sends
 *     a cookie header (§6.8/§8.10 — the client holds per-connection
 *     credentials, not host cookies),
 *   - the minimal ported chat surface: session list/create + message send
 *     (packages/ui/src/lib/api/chat.ts is the reference implementation).
 *
 * RED until src/lib/transport/index.ts exists: every test fails with
 * "Cannot find module …/src/lib/transport/index.ts" (missing feature).
 */
import { describe, expect, test } from 'bun:test';
import { loadTransportModule } from './helpers/contract.ts';
import { byteStream, jsonResponse, recordingFetch } from './helpers/mocks.ts';

const BASE = 'http://gw.example:8443';

describe('transport request shaping (P5b item 1)', () => {
  test('joins the base URL and API paths without doubled or dropped slashes', async () => {
    const { createTransport } = await loadTransportModule();
    const cases: Array<{ baseUrl: string; expected: string }> = [
      { baseUrl: 'http://gw.example:8443', expected: 'http://gw.example:8443/session' },
      { baseUrl: 'http://gw.example:8443/', expected: 'http://gw.example:8443/session' },
      // Reverse-proxied instance under a path prefix — the prefix must survive.
      { baseUrl: 'https://proxy.example/opencode', expected: 'https://proxy.example/opencode/session' },
      { baseUrl: 'https://proxy.example/opencode/', expected: 'https://proxy.example/opencode/session' }
    ];
    for (const { baseUrl, expected } of cases) {
      const { fetch, calls } = recordingFetch(() => jsonResponse([]));
      const transport = createTransport({ baseUrl, fetch });
      await transport.listSessions();
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe(expected);
      expect(calls[0].method).toBe('GET');
    }
  });

  test('basic mode sends an Authorization header derived from the connection credentials', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse([]));
    const transport = createTransport({
      baseUrl: BASE,
      auth: { mode: 'basic', username: 'alice', password: 's3cret' },
      fetch
    });
    await transport.listSessions();
    expect(calls[0].headers.get('authorization')).toBe(`Basic ${btoa('alice:s3cret')}`);
  });

  test('basic mode defaults the username to "openpalm" when only a password is held', async () => {
    // Mirrors the host app's probeEndpoint() default so credentials minted by
    // the host stack (guardian Basic auth, #435) work without a username field.
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse([]));
    const transport = createTransport({
      baseUrl: BASE,
      auth: { mode: 'basic', password: 'hunter2' },
      fetch
    });
    await transport.listSessions();
    expect(calls[0].headers.get('authorization')).toBe(`Basic ${btoa('openpalm:hunter2')}`);
  });

  test('bearer mode sends a Bearer Authorization header', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse([]));
    const transport = createTransport({
      baseUrl: BASE,
      auth: { mode: 'bearer', token: 'tok_12345' },
      fetch
    });
    await transport.listSessions();
    expect(calls[0].headers.get('authorization')).toBe('Bearer tok_12345');
  });

  test('mode none sends no Authorization header', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse([]));
    const transport = createTransport({ baseUrl: BASE, auth: { mode: 'none' }, fetch });
    await transport.listSessions();
    expect(calls[0].headers.get('authorization')).toBeNull();
  });

  test('never sends cookies: every request sets credentials "omit" and no cookie header', async () => {
    // 'omit' is the only fetch credentials mode that guarantees no cookies —
    // the default ('same-origin') would still leak cookies to a same-origin
    // connection URL. The host app's proxy transport does the opposite
    // (credentials 'include'); the client must never inherit that.
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch((request) => {
      if (request.method === 'POST' && request.url.endsWith('/session')) {
        return jsonResponse({ id: 'ses_new' });
      }
      return jsonResponse([]);
    });
    const transport = createTransport({
      baseUrl: BASE,
      auth: { mode: 'basic', password: 'hunter2' },
      fetch
    });
    await transport.listSessions();
    await transport.createSession();
    await transport.sendMessage('ses_new', 'hello');
    await transport.probeHealth();
    expect(calls.length).toBe(4);
    for (const call of calls) {
      expect(call.credentials).toBe('omit');
      expect(call.headers.get('cookie')).toBeNull();
    }
  });

  test('createSession POSTs {base}/session and returns the created id', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse({ id: 'ses_abc' }));
    const transport = createTransport({ baseUrl: BASE, fetch });
    const created = await transport.createSession();
    expect(created).toEqual({ id: 'ses_abc' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${BASE}/session`);
  });

  test('sendMessage POSTs the OpenCode parts envelope to the session message path', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse({ parts: [] }));
    const transport = createTransport({ baseUrl: BASE, fetch });
    await transport.sendMessage('ses_abc', 'hi there');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${BASE}/session/ses_abc/message`);
    expect(calls[0].headers.get('content-type')).toContain('application/json');
    expect(JSON.parse(calls[0].body ?? '')).toEqual({
      parts: [{ type: 'text', text: 'hi there' }]
    });
  });

  test('sendMessage URL-encodes the session id path segment', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse({ parts: [] }));
    const transport = createTransport({ baseUrl: BASE, fetch });
    await transport.sendMessage('ses/../etc', 'x');
    expect(calls[0].url).toBe(`${BASE}/session/${encodeURIComponent('ses/../etc')}/message`);
  });

  test('sendMessage parses text/event-stream responses', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() =>
      new Response(byteStream(['event: message\ndata: {"parts":[{"type":"text","text":"via sse"}]}\n\n']), {
        headers: { 'content-type': 'text/event-stream' },
      })
    );
    const transport = createTransport({ baseUrl: BASE, fetch });
    const response = await transport.sendMessage('ses_abc', 'hi there');
    expect(calls[0].headers.get('content-type')).toContain('application/json');
    expect(response).toEqual({ parts: [{ type: 'text', text: 'via sse' }] });
  });

  test('listSessions maps OpenCode sessions and sorts desc by updatedAt (title fallback "")', async () => {
    // Ported contract from packages/ui listSessions(): OpenCode returns
    // Array<Session> with no ordering guarantee; consumers rely on desc
    // `time.updated` ordering and '' title fallback.
    const { createTransport } = await loadTransportModule();
    const { fetch } = recordingFetch(() =>
      jsonResponse([
        { id: 'a', title: 'Older', time: { created: 1, updated: 10 } },
        { id: 'b', time: { created: 5 } },
        { id: 'c', title: 'Newest', time: { created: 2, updated: 99 } }
      ])
    );
    const transport = createTransport({ baseUrl: BASE, fetch });
    const sessions = await transport.listSessions();
    expect(sessions).toEqual([
      { id: 'c', title: 'Newest', createdAt: 2, updatedAt: 99 },
      { id: 'a', title: 'Older', createdAt: 1, updatedAt: 10 },
      { id: 'b', title: '', createdAt: 5, updatedAt: 5 }
    ]);
  });

  test('non-ok responses reject with the HTTP status attached', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch } = recordingFetch(() => jsonResponse({ error: 'nope' }, 500));
    const transport = createTransport({ baseUrl: BASE, fetch });
    let caught: unknown;
    try {
      await transport.listSessions();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { status?: number }).status).toBe(500);
  });
});
