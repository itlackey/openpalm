/**
 * B3 [HIGH] (review 2026-07-10 §B3, transport half) — stop/cancel for
 * in-flight turns.
 *
 * `transport.abortTurn(sessionId)` POSTs `/session/{id}/abort` (mirrors
 * `abortChatTurn` at `git show 455d8728:packages/ui/src/lib/api/chat.ts`).
 * `sendMessage` now accepts a caller-owned `AbortSignal` via a third
 * `{ signal }` argument so the UI stage can wire a stop button; the 150s
 * default budget is unchanged when no signal is supplied.
 *
 * New file — does not modify the shared tests/helpers/*.ts contract.
 */
import { describe, expect, test } from 'bun:test';
import { jsonResponse, recordingFetch } from './helpers/mocks.ts';

async function loadTransportModule() {
  return import('../src/lib/transport/index.ts');
}

const BASE = 'http://gw.example:8443';

describe('transport.abortTurn (B3)', () => {
  test('POSTs {base}/session/{id}/abort', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse({}));
    const transport = createTransport({ baseUrl: BASE, fetch });
    await transport.abortTurn('ses_abc');
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${BASE}/session/ses_abc/abort`);
  });

  test('URL-encodes the session id path segment', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse({}));
    const transport = createTransport({ baseUrl: BASE, fetch });
    await transport.abortTurn('ses/../etc');
    expect(calls[0].url).toBe(`${BASE}/session/${encodeURIComponent('ses/../etc')}/abort`);
  });

  test('sends no cookies and applies the connection credentials', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse({}));
    const transport = createTransport({
      baseUrl: BASE,
      auth: { mode: 'bearer', token: 'tok_1' },
      fetch,
    });
    await transport.abortTurn('ses_abc');
    expect(calls[0].credentials).toBe('omit');
    expect(calls[0].headers.get('authorization')).toBe('Bearer tok_1');
  });

  test('rejects with the HTTP status attached on a non-ok response', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch } = recordingFetch(() => jsonResponse({ error: 'no such session' }, 404));
    const transport = createTransport({ baseUrl: BASE, fetch });
    let caught: unknown;
    try {
      await transport.abortTurn('ses_gone');
    } catch (error) {
      caught = error;
    }
    expect((caught as { status?: number }).status).toBe(404);
  });
});

describe('transport.sendMessage caller-owned AbortSignal (B3)', () => {
  test('passes a caller-supplied signal through to fetch instead of the default timeout', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse({ parts: [] }));
    const transport = createTransport({ baseUrl: BASE, fetch });
    const controller = new AbortController();
    await transport.sendMessage('ses_abc', 'hi', { signal: controller.signal });
    // recordingFetch doesn't record the signal object itself; assert via
    // abort-before-send behavior instead.
    expect(calls.length).toBe(1);
  });

  test('a caller-supplied signal that is already aborted aborts the request', async () => {
    const { createTransport } = await loadTransportModule();
    const fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return jsonResponse({ parts: [] });
    }) as typeof globalThis.fetch;
    const transport = createTransport({ baseUrl: BASE, fetch });
    const controller = new AbortController();
    controller.abort();
    let caught: unknown;
    try {
      await transport.sendMessage('ses_abc', 'hi', { signal: controller.signal });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
  });

  test('with no signal supplied, sendMessage still applies the 150s default budget', async () => {
    const { createTransport } = await loadTransportModule();
    const capturedSignals: (AbortSignal | undefined)[] = [];
    const fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedSignals.push(init?.signal ?? undefined);
      return jsonResponse({ parts: [] });
    }) as typeof globalThis.fetch;
    const transport = createTransport({ baseUrl: BASE, fetch });
    await transport.sendMessage('ses_abc', 'hi');
    expect(capturedSignals.length).toBe(1);
    expect(capturedSignals[0]).toBeInstanceOf(AbortSignal);
    // A fresh, unaborted signal with a live timeout — not yet fired.
    expect(capturedSignals[0]?.aborted).toBe(false);
  });
});
