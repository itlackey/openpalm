/**
 * B2 [HIGH] (review 2026-07-10 §B2, transport half) — live SSE event
 * subscription on the client transport.
 *
 * `transport.subscribeEvents(handlers)` GETs `${base}/event`, reuses
 * `parseSseStream`, and ports the reconnect/backoff/Last-Event-ID logic from
 * `packages/ui/src/lib/chat/session-events.ts` (subscribeSessionEvents) —
 * generalized to hand back every parsed OpenCode event (not just session
 * lifecycle ones) so the UI stage can layer its own dispatch on top.
 *
 * `extractTextDelta`/`isTurnEnd` are ported/adapted from
 * `packages/ui/src/lib/chat/oc-events.ts` so the UI stage can render
 * incremental assistant text without a 150s blocking wait.
 *
 * This test file is new (allowed under the transport lane's ownership); it
 * does not modify the shared tests/helpers/*.ts contract files, so it opens
 * the production module directly instead of going through
 * tests/helpers/contract.ts's typed loader.
 */
import { afterEach, describe, expect, test } from 'bun:test';

async function loadTransportModule() {
  return import('../src/lib/transport/index.ts');
}

const BASE = 'http://gw.example:8443';

type StreamHandle = {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  body: ReadableStream<Uint8Array>;
  close: () => Promise<void>;
};

function makeStream(): StreamHandle {
  const encoder = new TextEncoder();
  const ts = new TransformStream<Uint8Array, Uint8Array>();
  const writer = ts.writable.getWriter();
  return {
    writer,
    body: ts.readable,
    async close() {
      try {
        await writer.close();
      } catch {
        // already closed
      }
    },
  };
}

async function writeChunk(handle: StreamHandle, text: string): Promise<void> {
  await handle.writer.write(new TextEncoder().encode(text));
}

async function waitFor(predicate: () => boolean, budgetMs = 1500): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < budgetMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error('waitFor: predicate never became true');
}

let openStreams: StreamHandle[] = [];

afterEach(async () => {
  for (const s of openStreams) await s.close().catch(() => {});
  openStreams = [];
});

const TEXT_DELTA_FRAME = `data: ${JSON.stringify({
  type: 'message.part.delta',
  properties: { sessionID: 'ses_1', field: 'text', delta: 'Hello' },
})}\n\n`;

const IDLE_FRAME = `data: ${JSON.stringify({
  type: 'session.idle',
  properties: { sessionID: 'ses_1' },
})}\n\n`;

describe('transport.subscribeEvents (B2)', () => {
  test('GETs ${base}/event with the accept header and connection credentials', async () => {
    const { createTransport } = await loadTransportModule();
    const handle = makeStream();
    openStreams.push(handle);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(handle.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof globalThis.fetch;

    const transport = createTransport({
      baseUrl: BASE,
      auth: { mode: 'bearer', token: 'tok_1' },
      fetch,
    });
    const unsubscribe = transport.subscribeEvents({ onEvent: () => {} });
    await waitFor(() => calls.length > 0);

    expect(calls[0].url).toBe(`${BASE}/event`);
    expect(calls[0].init.method).toBe('GET');
    expect((calls[0].init.headers as Record<string, string>).accept).toBe('text/event-stream');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok_1');
    expect(calls[0].init.credentials).toBe('omit');
    unsubscribe();
  });

  test('dispatches every parsed event via onEvent, in order', async () => {
    const { createTransport } = await loadTransportModule();
    const handle = makeStream();
    openStreams.push(handle);
    const fetch = (async () =>
      new Response(handle.body, { status: 200 })) as typeof globalThis.fetch;
    const transport = createTransport({ baseUrl: BASE, fetch });

    const events: string[] = [];
    const unsubscribe = transport.subscribeEvents({
      onEvent: (event) => events.push(event.type),
    });

    await writeChunk(handle, TEXT_DELTA_FRAME);
    await writeChunk(handle, IDLE_FRAME);
    await waitFor(() => events.length === 2);

    expect(events).toEqual(['message.part.delta', 'session.idle']);
    unsubscribe();
  });

  test('reconnects after the stream ends and sends Last-Event-ID on resume', async () => {
    const first = makeStream();
    const second = makeStream();
    openStreams.push(first, second);
    let call = 0;
    const requests: RequestInit[] = [];
    const fetch = (async (_url: string | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      call += 1;
      return new Response(call === 1 ? first.body : second.body, { status: 200 });
    }) as typeof globalThis.fetch;
    const { createTransport } = await loadTransportModule();
    const transport = createTransport({ baseUrl: BASE, fetch });
    const events: string[] = [];
    const unsubscribe = transport.subscribeEvents({ onEvent: (e) => events.push(e.type) });

    await writeChunk(
      first,
      `id: 42\ndata: ${JSON.stringify({ type: 'session.idle', properties: { sessionID: 'ses_1' } })}\n\n`
    );
    await waitFor(() => events.length === 1);
    await first.close();

    await waitFor(() => requests.length === 2, 3500);
    const secondHeaders = requests[1] as unknown as Record<string, string>;
    expect((secondHeaders.headers as unknown as Record<string, string>)['Last-Event-ID']).toBe('42');
    unsubscribe();
  }, 6000);

  test('unsubscribe stops reconnection', async () => {
    const handle = makeStream();
    openStreams.push(handle);
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response(handle.body, { status: 200 });
    }) as typeof globalThis.fetch;
    const { createTransport } = await loadTransportModule();
    const transport = createTransport({ baseUrl: BASE, fetch });
    const unsubscribe = transport.subscribeEvents({ onEvent: () => {} });
    await waitFor(() => calls === 1);
    unsubscribe();
    await handle.close();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(calls).toBe(1);
  }, 4000);

  test('fires onDisconnect for a non-abort stream failure', async () => {
    const { createTransport } = await loadTransportModule();
    let call = 0;
    const fetch = (async () => {
      call += 1;
      if (call === 1) return new Response(null, { status: 500 });
      return new Promise<Response>(() => {}); // hang — no further reconnects observed
    }) as typeof globalThis.fetch;
    const transport = createTransport({ baseUrl: BASE, fetch });
    const errors: Error[] = [];
    const unsubscribe = transport.subscribeEvents({
      onEvent: () => {},
      onDisconnect: (error) => errors.push(error),
    });
    await waitFor(() => errors.length > 0, 3000);
    expect(errors[0]).toBeInstanceOf(Error);
    unsubscribe();
  }, 5000);
});

describe('extractTextDelta (ported from packages/ui oc-events.ts, B2)', () => {
  test('extracts session.next.text.delta for the matching session', async () => {
    const { extractTextDelta } = await loadTransportModule();
    const delta = extractTextDelta(
      { type: 'session.next.text.delta', properties: { sessionID: 'ses_1', delta: 'hi' } },
      'ses_1'
    );
    expect(delta).toBe('hi');
  });

  test('extracts message.part.delta text field for the matching session', async () => {
    const { extractTextDelta } = await loadTransportModule();
    const delta = extractTextDelta(
      { type: 'message.part.delta', properties: { sessionID: 'ses_1', field: 'text', delta: 'chunk' } },
      'ses_1'
    );
    expect(delta).toBe('chunk');
  });

  test('ignores a message.part.delta for a non-text field', async () => {
    const { extractTextDelta } = await loadTransportModule();
    const delta = extractTextDelta(
      { type: 'message.part.delta', properties: { sessionID: 'ses_1', field: 'reasoning', delta: 'chunk' } },
      'ses_1'
    );
    expect(delta).toBeNull();
  });

  test('ignores events for a different session', async () => {
    const { extractTextDelta } = await loadTransportModule();
    const delta = extractTextDelta(
      { type: 'session.next.text.delta', properties: { sessionID: 'ses_other', delta: 'hi' } },
      'ses_1'
    );
    expect(delta).toBeNull();
  });

  test('ignores reasoning parts named in reasoningPartIds', async () => {
    const { extractTextDelta } = await loadTransportModule();
    const delta = extractTextDelta(
      {
        type: 'message.part.delta',
        properties: { sessionID: 'ses_1', field: 'text', partID: 'part_1', delta: 'chunk' },
      },
      'ses_1',
      new Set(['part_1'])
    );
    expect(delta).toBeNull();
  });
});

describe('isTurnEnd (ported from packages/ui oc-events.ts, B2)', () => {
  test('session.idle for the matching session ends the turn', async () => {
    const { isTurnEnd } = await loadTransportModule();
    expect(isTurnEnd({ type: 'session.idle', properties: { sessionID: 'ses_1' } }, 'ses_1')).toBe(true);
  });

  test('session.status idle/completed/done end the turn', async () => {
    const { isTurnEnd } = await loadTransportModule();
    for (const status of ['idle', 'completed', 'done']) {
      expect(
        isTurnEnd(
          { type: 'session.status', properties: { sessionID: 'ses_1', status } },
          'ses_1'
        )
      ).toBe(true);
    }
  });

  test('other events and other sessions do not end the turn', async () => {
    const { isTurnEnd } = await loadTransportModule();
    expect(isTurnEnd({ type: 'session.status', properties: { sessionID: 'ses_1', status: 'running' } }, 'ses_1')).toBe(
      false
    );
    expect(isTurnEnd({ type: 'session.idle', properties: { sessionID: 'ses_other' } }, 'ses_1')).toBe(false);
  });
});
