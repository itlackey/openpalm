/**
 * Unit tests for the hand-rolled SSE consumer.
 *
 * Runs in the node project — no Svelte runes here, just fetch + streams.
 * We mock `globalThis.fetch` to return a controllable ReadableStream so we
 * never open a socket. `TransformStream` + `TextEncoder` produce SSE frames
 * the consumer parses.
 *
 * Phase D of docs/technical/multi-endpoint-session-ux.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseFrame, subscribeSessionEvents } from './session-events.js';

type StreamHandle = {
  encoder: TextEncoder;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  body: ReadableStream<Uint8Array>;
  close: () => Promise<void>;
};

type StreamHandleInternal = StreamHandle & {
  abort: (reason?: unknown) => Promise<void>;
};

function makeStream(): StreamHandleInternal {
  const encoder = new TextEncoder();
  const ts = new TransformStream<Uint8Array, Uint8Array>();
  const writer = ts.writable.getWriter();
  return {
    encoder,
    writer,
    body: ts.readable,
    async close() {
      try {
        await writer.close();
      } catch {
        // already closed
      }
    },
    async abort(reason?: unknown) {
      try {
        await writer.abort(reason);
      } catch {
        // already aborted
      }
    },
  };
}

async function writeChunk(handle: StreamHandle, text: string): Promise<void> {
  await handle.writer.write(handle.encoder.encode(text));
}

const SESSION_CREATED_FRAME = `data: ${JSON.stringify({
  type: 'session.created',
  properties: { info: { id: 'sess-1' } },
})}\n\n`;

const SESSION_UPDATED_FRAME = `data: ${JSON.stringify({
  type: 'session.updated',
  properties: { info: { id: 'sess-1', title: 'Renamed', time: { updated: 42 } } },
})}\n\n`;

const SESSION_DELETED_FRAME = `data: ${JSON.stringify({
  type: 'session.deleted',
  properties: { info: { id: 'sess-1' } },
})}\n\n`;

let fetchSpy: ReturnType<typeof vi.spyOn>;
let openStreams: StreamHandle[] = [];

beforeEach(() => {
  openStreams = [];
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(async () => {
  // Close any leaked streams so vitest doesn't hang on pending writers.
  for (const s of openStreams) {
    await s.close().catch(() => {});
  }
  vi.restoreAllMocks();
});

/** Tick the event loop so the consumer's reader can drain pending chunks. */
async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/** Helper: wait until a predicate becomes true or a budget expires. */
async function waitFor(predicate: () => boolean, budgetMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < budgetMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error('waitFor: predicate never became true');
}

describe('parseFrame', () => {
  it('parses a single-line data frame', () => {
    const out = parseFrame('event: ping\ndata: hello\nid: 1');
    expect(out).toEqual({ event: 'ping', data: 'hello', id: '1' });
  });

  it('concatenates multi-line data fields with \\n', () => {
    const out = parseFrame('data: line1\ndata: line2\ndata: line3');
    expect(out.data).toBe('line1\nline2\nline3');
  });

  it('ignores comment / heartbeat lines', () => {
    const out = parseFrame(': keep-alive\ndata: x');
    expect(out.data).toBe('x');
  });

  it('strips an optional space after the field name', () => {
    const out = parseFrame('data:no-space');
    expect(out.data).toBe('no-space');
  });
});

describe('subscribeSessionEvents', () => {
  it('dispatches a session.created event', async () => {
    const handle = makeStream();
    openStreams.push(handle);
    fetchSpy.mockResolvedValueOnce(
      new Response(handle.body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );

    const onCreated = vi.fn();
    const onConnect = vi.fn();
    const unsub = subscribeSessionEvents({
      onCreated,
      onUpdated: vi.fn(),
      onDeleted: vi.fn(),
      onConnect,
    });

    await tick();
    await writeChunk(handle, SESSION_CREATED_FRAME);
    await waitFor(() => onCreated.mock.calls.length > 0);

    expect(onConnect).toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith('sess-1');
    unsub();
  });

  it('dispatches multiple events in order', async () => {
    const handle = makeStream();
    openStreams.push(handle);
    fetchSpy.mockResolvedValueOnce(
      new Response(handle.body, { status: 200 })
    );

    const events: string[] = [];
    const unsub = subscribeSessionEvents({
      onCreated: (id) => events.push(`created:${id}`),
      onUpdated: (id) => events.push(`updated:${id}`),
      onDeleted: (id) => events.push(`deleted:${id}`),
    });

    await tick();
    await writeChunk(handle, SESSION_CREATED_FRAME);
    await writeChunk(handle, SESSION_UPDATED_FRAME);
    await writeChunk(handle, SESSION_DELETED_FRAME);
    await waitFor(() => events.length === 3);

    expect(events).toEqual(['created:sess-1', 'updated:sess-1', 'deleted:sess-1']);
    unsub();
  });

  it('parses multi-line data fields as one JSON payload', async () => {
    const handle = makeStream();
    openStreams.push(handle);
    fetchSpy.mockResolvedValueOnce(new Response(handle.body, { status: 200 }));

    const onCreated = vi.fn();
    const unsub = subscribeSessionEvents({
      onCreated,
      onUpdated: vi.fn(),
      onDeleted: vi.fn(),
    });

    await tick();
    // SSE spec: multiple `data:` lines in one frame concatenate with `\n`
    // before JSON.parse. Split between top-level fields where embedded
    // whitespace is JSON-legal.
    const a = '{"type":"session.created",';
    const b = '"properties":{"info":{"id":"multi-line"}}}';
    await writeChunk(handle, `data: ${a}\ndata: ${b}\n\n`);
    await waitFor(() => onCreated.mock.calls.length > 0);

    expect(onCreated).toHaveBeenCalledWith('multi-line');
    unsub();
  });

  it('reconnects after a stream error and sends Last-Event-ID', async () => {
    const first = makeStream();
    openStreams.push(first);
    const second = makeStream();
    openStreams.push(second);

    fetchSpy
      .mockResolvedValueOnce(new Response(first.body, { status: 200 }))
      .mockResolvedValueOnce(new Response(second.body, { status: 200 }));

    const onCreated = vi.fn();
    const onUpdated = vi.fn();
    const onDisconnect = vi.fn();
    const unsub = subscribeSessionEvents({
      onCreated,
      onUpdated,
      onDeleted: vi.fn(),
      onDisconnect,
    });

    await tick();
    // First stream: send an event with an id, then close to trigger reconnect.
    const framed = `id: 42\ndata: ${JSON.stringify({
      type: 'session.created',
      properties: { info: { id: 'A' } },
    })}\n\n`;
    await writeChunk(first, framed);
    await waitFor(() => onCreated.mock.calls.length > 0);
    expect(onCreated).toHaveBeenCalledWith('A');

    // Close the first stream — consumer should reconnect with backoff.
    await first.close();

    // Second stream should be requested. With 1s initial backoff this can
    // take up to ~1.5s, give it 3s.
    await waitFor(() => fetchSpy.mock.calls.length === 2, 3500);

    const secondCallHeaders = (fetchSpy.mock.calls[1][1] as RequestInit).headers as
      | Record<string, string>
      | undefined;
    expect(secondCallHeaders?.['Last-Event-ID']).toBe('42');

    await writeChunk(second, SESSION_UPDATED_FRAME);
    await waitFor(() => onUpdated.mock.calls.length > 0);
    expect(onUpdated).toHaveBeenCalledWith('sess-1', expect.objectContaining({ title: 'Renamed' }));
    unsub();
  }, 8000);

  it('unsubscribe aborts the controller and prevents reconnection', async () => {
    const handle = makeStream();
    openStreams.push(handle);
    fetchSpy.mockResolvedValueOnce(new Response(handle.body, { status: 200 }));

    const unsub = subscribeSessionEvents({
      onCreated: vi.fn(),
      onUpdated: vi.fn(),
      onDeleted: vi.fn(),
    });

    await tick();
    unsub();
    // Trigger the stream-end path. With stopped=true, the loop must exit
    // and NOT call fetch again.
    await handle.close();

    // Give the consumer ample time to (incorrectly) reconnect.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  }, 4000);

  it('fires onDisconnect for non-abort errors', async () => {
    const first = makeStream();
    openStreams.push(first);
    fetchSpy
      .mockResolvedValueOnce(new Response(first.body, { status: 200 }))
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementation(() => new Promise(() => {})); // hang

    const onDisconnect = vi.fn();
    const unsub = subscribeSessionEvents({
      onCreated: vi.fn(),
      onUpdated: vi.fn(),
      onDeleted: vi.fn(),
      onDisconnect,
    });

    await tick();
    await first.close();
    await waitFor(() => onDisconnect.mock.calls.length > 0, 4000);
    expect(onDisconnect.mock.calls[0][0]).toBeInstanceOf(Error);
    unsub();
  }, 6000);
});
