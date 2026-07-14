/**
 * B4 [HIGH] (review 2026-07-10 §B4, transport half) — permission requests and
 * assistant questions must be answerable from the client.
 *
 * Mirrors `replyChatPermission`/`replyChatQuestion`/`rejectChatQuestion` at
 * `git show 455d8728:packages/ui/src/lib/api/chat.ts:140-166`, adapted to the
 * direct-to-connection transport (no `/proxy/assistant` prefix, no cookies).
 *
 * New file — does not modify the shared tests/helpers/*.ts contract.
 */
import { describe, expect, test } from 'bun:test';
import { jsonResponse, recordingFetch } from './helpers/mocks.ts';

async function loadTransportModule() {
  return import('../src/lib/transport/index.ts');
}

const BASE = 'http://gw.example:8443';

describe('transport.replyPermission (B4)', () => {
  test('POSTs {base}/permission/{requestId}/reply with the reply body', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse({}));
    const transport = createTransport({ baseUrl: BASE, fetch });
    await transport.replyPermission('req_1', 'once');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${BASE}/permission/req_1/reply`);
    expect(JSON.parse(calls[0].body ?? '')).toEqual({ reply: 'once' });
  });

  test('supports "always" and "reject" reply values', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse({}));
    const transport = createTransport({ baseUrl: BASE, fetch });
    await transport.replyPermission('req_1', 'always');
    await transport.replyPermission('req_1', 'reject');
    expect(JSON.parse(calls[0].body ?? '')).toEqual({ reply: 'always' });
    expect(JSON.parse(calls[1].body ?? '')).toEqual({ reply: 'reject' });
  });

  test('URL-encodes the request id', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse({}));
    const transport = createTransport({ baseUrl: BASE, fetch });
    await transport.replyPermission('req/../x', 'once');
    expect(calls[0].url).toBe(`${BASE}/permission/${encodeURIComponent('req/../x')}/reply`);
  });
});

describe('transport.replyQuestion (B4)', () => {
  test('POSTs {base}/question/{requestId}/reply with the answers body', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse({}));
    const transport = createTransport({ baseUrl: BASE, fetch });
    await transport.replyQuestion('q_1', [['yes']]);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${BASE}/question/q_1/reply`);
    expect(JSON.parse(calls[0].body ?? '')).toEqual({ answers: [['yes']] });
  });
});

describe('transport.rejectQuestion (B4)', () => {
  test('POSTs {base}/question/{requestId}/reject with an empty body', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse({}));
    const transport = createTransport({ baseUrl: BASE, fetch });
    await transport.rejectQuestion('q_1');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${BASE}/question/q_1/reject`);
    expect(JSON.parse(calls[0].body ?? '')).toEqual({});
  });
});

describe('permission/question reply transport hygiene (B4)', () => {
  test('never send cookies and carry the connection credentials', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse({}));
    const transport = createTransport({
      baseUrl: BASE,
      auth: { mode: 'basic', password: 'hunter2' },
      fetch,
    });
    await transport.replyPermission('req_1', 'once');
    await transport.replyQuestion('q_1', [['yes']]);
    await transport.rejectQuestion('q_1');
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call.credentials).toBe('omit');
      // PR #564 P2-2: a password-only Basic connection defaults the username to
      // OpenCode's server default 'opencode' (not 'openpalm').
      expect(call.headers.get('authorization')).toBe(`Basic ${btoa('opencode:hunter2')}`);
    }
  });

  test('rejects with the HTTP status attached on a non-ok response', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch } = recordingFetch(() => jsonResponse({ error: 'gone' }, 410));
    const transport = createTransport({ baseUrl: BASE, fetch });
    let caught: unknown;
    try {
      await transport.replyPermission('req_1', 'once');
    } catch (error) {
      caught = error;
    }
    expect((caught as { status?: number }).status).toBe(410);
  });
});
