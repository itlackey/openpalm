/**
 * Unit tests for the SSE consumer.
 *
 * Runs in the node project. `parseFrame` is a pure function. For
 * `subscribeSessionEvents`, the underlying stream is now the browser-owned
 * direct transport (`$lib/connections/boot.getTransport()`), so we stub that
 * module with a controllable fake transport whose `subscribeEvents` we drive by
 * hand — pushing parsed `/event` frames, ending the stream, or failing it.
 * Reconnect/backoff and dispatch still live in this module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FrameHandler = (event: { type: string; properties?: Record<string, unknown> }) => void;

type StreamCall = {
  onFrame: FrameHandler;
  resolve: () => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
};

const transport = vi.hoisted(() => {
  const calls: StreamCall[] = [];
  const subscribeEvents = vi.fn(
    (onFrame: FrameHandler, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const call: StreamCall = { onFrame, resolve, reject, signal };
        calls.push(call);
        signal.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true }
        );
      })
  );
  return {
    calls,
    subscribeEvents,
    request: vi.fn(),
    probeHealth: vi.fn(),
    reset() {
      calls.length = 0;
      subscribeEvents.mockClear();
    },
  };
});

vi.mock('$lib/connections/boot.js', () => ({ getTransport: () => transport }));

import { parseFrame, subscribeSessionEvents } from './session-events.js';

/** Wait until a predicate becomes true or a budget expires. */
async function waitFor(predicate: () => boolean, budgetMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < budgetMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error('waitFor: predicate never became true');
}

beforeEach(() => {
  transport.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

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
  it('fires onConnect on the first frame and dispatches session.created', async () => {
    const onCreated = vi.fn();
    const onConnect = vi.fn();
    const unsub = subscribeSessionEvents({
      onCreated,
      onUpdated: vi.fn(),
      onDeleted: vi.fn(),
      onConnect,
    });

    await waitFor(() => transport.calls.length === 1);
    transport.calls[0].onFrame({ type: 'session.created', properties: { info: { id: 'sess-1' } } });

    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith('sess-1');
    unsub();
  });

  it('dispatches multiple events in order', async () => {
    const events: string[] = [];
    const unsub = subscribeSessionEvents({
      onCreated: (id) => events.push(`created:${id}`),
      onUpdated: (id) => events.push(`updated:${id}`),
      onDeleted: (id) => events.push(`deleted:${id}`),
    });

    await waitFor(() => transport.calls.length === 1);
    const push = transport.calls[0].onFrame;
    push({ type: 'session.created', properties: { info: { id: 'sess-1' } } });
    push({ type: 'session.updated', properties: { info: { id: 'sess-1', title: 'Renamed', time: { updated: 42 } } } });
    push({ type: 'session.deleted', properties: { info: { id: 'sess-1' } } });

    expect(events).toEqual(['created:sess-1', 'updated:sess-1', 'deleted:sess-1']);
    unsub();
  });

  it('reconnects after the stream ends cleanly', async () => {
    const unsub = subscribeSessionEvents({
      onCreated: vi.fn(),
      onUpdated: vi.fn(),
      onDeleted: vi.fn(),
    });

    await waitFor(() => transport.calls.length === 1);
    // Server closed the stream — the consumer must reopen after a short delay.
    transport.calls[0].resolve();
    await waitFor(() => transport.subscribeEvents.mock.calls.length === 2);
    expect(transport.calls.length).toBe(2);
    unsub();
  });

  it('fires onDisconnect for non-abort errors and reconnects with backoff', async () => {
    const onDisconnect = vi.fn();
    const unsub = subscribeSessionEvents({
      onCreated: vi.fn(),
      onUpdated: vi.fn(),
      onDeleted: vi.fn(),
      onDisconnect,
    });

    await waitFor(() => transport.calls.length === 1);
    transport.calls[0].reject(new Error('boom'));
    await waitFor(() => onDisconnect.mock.calls.length > 0);
    expect(onDisconnect.mock.calls[0][0]).toBeInstanceOf(Error);
    unsub();
  });

  it('unsubscribe aborts the stream and prevents reconnection', async () => {
    const unsub = subscribeSessionEvents({
      onCreated: vi.fn(),
      onUpdated: vi.fn(),
      onDeleted: vi.fn(),
    });

    await waitFor(() => transport.calls.length === 1);
    unsub();
    // The abort rejects the in-flight stream with an AbortError; the loop must
    // see `stopped` and NOT reopen.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(transport.subscribeEvents).toHaveBeenCalledTimes(1);
  });
});
