/**
 * SSE consumer for OpenCode's `/event` stream.
 *
 * Phase 3b ("One UI, delete the split"): the underlying stream is now opened by
 * the browser-owned direct transport (`$lib/connections/boot.getTransport()`
 * → `subscribeEvents(onFrame, signal)`), which talks to the active connection's
 * OpenCode/Guardian base URL directly (no host proxy, no admin cookie) and
 * REUSES this module's `parseFrame`. Reconnect/backoff, session-scoped dispatch,
 * and abort semantics stay here — the chat layer's concern, not the transport's.
 *
 * Phase D of docs/technical/multi-endpoint-session-ux.md.
 */
import { getTransport } from '$lib/connections/boot.js';
import type { RawEvent } from './oc-events.js';

export type SessionEventHandlers = {
  onCreated(sessionId: string): void;
  onUpdated(sessionId: string, info?: { title?: string; updatedAt?: number }): void;
  onDeleted(sessionId: string): void;
  onEvent?: (event: OpenCodeSessionEventPayload) => void;
  onConnect?: () => void;
  onDisconnect?: (error: Error) => void;
};

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

type ParsedFrame = {
  event?: string;
  data?: string;
  id?: string;
};

/**
 * Parse one `\n\n`-delimited SSE frame. Multi-line `data:` fields are
 * concatenated with `\n` per the SSE spec. Reused by the direct transport.
 */
export function parseFrame(chunk: string): ParsedFrame {
  const frame: ParsedFrame = {};
  const dataLines: string[] = [];
  for (const rawLine of chunk.split('\n')) {
    if (!rawLine || rawLine.startsWith(':')) continue; // comment / heartbeat
    if (rawLine.startsWith('data:')) {
      dataLines.push(rawLine.replace(/^data:\s?/, ''));
    } else if (rawLine.startsWith('event:')) {
      frame.event = rawLine.replace(/^event:\s?/, '');
    } else if (rawLine.startsWith('id:')) {
      frame.id = rawLine.replace(/^id:\s?/, '');
    }
    // `retry:` is ignored — we drive backoff ourselves.
  }
  if (dataLines.length > 0) frame.data = dataLines.join('\n');
  return frame;
}

export type OpenCodeSessionEventPayload = {
  type: 'session.created' | 'session.updated' | 'session.deleted' | string;
  sessionID?: string;
  properties?: {
    info?: { id?: string; title?: string; time?: { updated?: number } };
    [key: string]: unknown;
  };
};

function dispatch(handlers: SessionEventHandlers, payload: OpenCodeSessionEventPayload): void {
  const info = payload.properties?.info;
  // OpenCode may carry the session id at the top level (`sessionID`) or nested
  // under `properties.info.id`. Accept both so events aren't silently dropped
  // when the SDK changes the envelope shape.
  const id = info?.id ?? payload.sessionID;
  if (!id) return;
  switch (payload.type) {
    case 'session.created':
      handlers.onCreated(id);
      return;
    case 'session.updated':
      handlers.onUpdated(id, {
        title: info?.title,
        updatedAt: info?.time?.updated,
      });
      return;
    case 'session.deleted':
      handlers.onDeleted(id);
      return;
    default:
      // Ignore non-session events (message.*, todo.*, tui.*, etc.).
      return;
  }
}

/** Fixed, no-jitter delay before reopening a stream that actually delivered at
 * least one frame this run — a "genuinely transient drop" (network blip,
 * routine server restart) gets a fast retry rather than the escalating
 * backoff below. */
const FAST_RECONNECT_MS = 500;

/**
 * Exponential backoff with full jitter, applied only when a run never
 * delivered a single frame (see `established` below). A server that accepts
 * the connection and closes it immediately — the F7 case — would otherwise
 * hit the `established` branch's fixed delay every time and reconnect at a
 * steady 2 req/s forever; escalating (and randomizing, so a later multi-tab
 * reconnect doesn't all land on the same tick) the delay instead settles into
 * a slow, bounded poll against a wedged endpoint.
 */
function backoffWithJitter(attempt: number): number {
  const cap = Math.min(INITIAL_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
  return Math.random() * cap;
}

/**
 * Open the active connection's `/event` SSE stream (via the direct transport)
 * and dispatch session-scoped events. Returns an unsubscribe function that
 * aborts the stream and prevents reconnection.
 *
 * `onConnect` fires on the first frame of each (re)connected stream — the point
 * at which live updates are demonstrably flowing. The transport owns the fetch;
 * this loop owns exponential-backoff reconnect and abort.
 */
export function subscribeSessionEvents(handlers: SessionEventHandlers): () => void {
  let stopped = false;
  let controller = new AbortController();

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      // Capture the signal so the timeout path removes its listener from the
      // SAME signal it was added to (controller can be swapped between sleeps).
      // Without the removal, every reconnect sleep left a dangling {once:true}
      // listener on the long-lived signal — unbounded growth in long-lived tabs.
      const signal = controller.signal;
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });

  async function readStream(onEstablished: () => void): Promise<void> {
    let connected = false;
    await getTransport().subscribeEvents((event: RawEvent) => {
      if (!connected) {
        connected = true;
        onEstablished();
        handlers.onConnect?.();
      }
      // A RawEvent is the parsed `/event` frame JSON — the same object shape as
      // OpenCodeSessionEventPayload (type + properties[+ sessionID]).
      const payload = event as unknown as OpenCodeSessionEventPayload;
      handlers.onEvent?.(payload);
      dispatch(handlers, payload);
    }, controller.signal);
  }

  void (async () => {
    let attempt = 0;
    while (!stopped) {
      attempt++;
      let established = false;
      let thrown: Error | null = null;
      try {
        await readStream(() => {
          established = true;
        });
      } catch (err) {
        if (stopped) return;
        thrown = err instanceof Error ? err : new Error(String(err));
      }
      if (stopped) return;

      if (thrown) {
        // Don't log aborts triggered by the unsubscribe path — those are
        // expected.
        if (thrown.name !== 'AbortError') {
          console.warn('[session-events] SSE error, reconnecting', thrown);
        }
        if (established || thrown.name !== 'AbortError') {
          handlers.onDisconnect?.(thrown);
        }
        // Reset the AbortController if the previous one was aborted by
        // something other than us (e.g. a network layer). We track `stopped`
        // for our own teardown signal.
        if (controller.signal.aborted && !stopped) {
          controller = new AbortController();
        }
      } else if (established) {
        // Stream ended cleanly after actually delivering data.
        handlers.onDisconnect?.(new Error('The assistant event stream closed.'));
      }
      // else: resolved with no thrown error AND no frame ever arrived — the
      // server accepted the connection and closed it right away. Falls
      // through to the `established` check below, which routes this to the
      // escalating branch instead of the fast one.
      if (stopped) return;

      if (established) {
        // A frame got through this run, so the endpoint genuinely works right
        // now — reconnect quickly rather than punishing a real, if brief, drop.
        attempt = 0;
        await sleep(FAST_RECONNECT_MS);
      } else {
        await sleep(backoffWithJitter(attempt));
      }
    }
  })();

  return () => {
    stopped = true;
    try {
      controller.abort();
    } catch {
      // noop
    }
  };
}
