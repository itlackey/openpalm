/**
 * Hand-rolled SSE consumer for OpenCode's `/event` stream.
 *
 * Why not `@opencode-ai/sdk`'s `createSseClient`? Pulling the SDK into the
 * client bundle drags in the rest of its generated code (~hundreds of kB).
 * The protocol we need is ~50 lines: split frames on `\n\n`, parse
 * `event:`/`data:`/`id:`, dispatch session events, reconnect on disconnect
 * with exponential backoff, send `Last-Event-ID` on resume.
 *
 * Why not `EventSource`? Setting `Last-Event-ID` on reconnect via the
 * standard SSE header is fine in `EventSource`, but we want exponential
 * backoff and explicit abort semantics — `EventSource`'s built-in retry
 * timer is opaque. Hand-rolled `fetch` + reader gives full control and
 * still pipes through `/proxy/assistant/event` so the SvelteKit broker
 * injects Basic auth + the active endpoint URL server-side.
 *
 * Phase D of docs/technical/multi-endpoint-session-ux.md.
 */

export type SessionEventHandlers = {
  onCreated(sessionId: string): void;
  onUpdated(sessionId: string, info?: { title?: string; updatedAt?: number }): void;
  onDeleted(sessionId: string): void;
  onConnect?: () => void;
  onDisconnect?: (error: Error) => void;
};

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const STREAM_URL = '/proxy/assistant/event';

type ParsedFrame = {
  event?: string;
  data?: string;
  id?: string;
};

/**
 * Parse one `\n\n`-delimited SSE frame. Multi-line `data:` fields are
 * concatenated with `\n` per the SSE spec.
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

type OpenCodeSessionEventPayload = {
  type: 'session.created' | 'session.updated' | 'session.deleted' | string;
  properties?: {
    info?: { id?: string; title?: string; time?: { updated?: number } };
  };
};

function dispatch(handlers: SessionEventHandlers, payload: OpenCodeSessionEventPayload): void {
  const info = payload.properties?.info;
  const id = info?.id;
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

/**
 * Open an SSE connection to `/proxy/assistant/event` and dispatch
 * session-scoped events. Returns an unsubscribe function that aborts the
 * stream and prevents reconnection.
 */
export function subscribeSessionEvents(handlers: SessionEventHandlers): () => void {
  let stopped = false;
  let controller = new AbortController();
  let lastEventId: string | undefined;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      controller.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });

  async function readStream(): Promise<void> {
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId;

    const response = await fetch(STREAM_URL, {
      method: 'GET',
      headers,
      credentials: 'include',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`SSE stream failed: ${response.status} ${response.statusText}`);
    }

    handlers.onConnect?.();
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          if (!chunk) continue;
          const frame = parseFrame(chunk);
          if (frame.id !== undefined) lastEventId = frame.id;
          if (!frame.data) continue;
          let payload: OpenCodeSessionEventPayload;
          try {
            payload = JSON.parse(frame.data) as OpenCodeSessionEventPayload;
          } catch (err) {
            console.warn('[session-events] Bad JSON in SSE frame', err);
            continue;
          }
          dispatch(handlers, payload);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
  }

  void (async () => {
    let attempt = 0;
    while (!stopped) {
      try {
        attempt++;
        await readStream();
        // Stream ended cleanly (server closed). Reconnect with a tiny
        // delay so we don't tight-loop if the server hangs up immediately.
        attempt = 0;
        if (!stopped) await sleep(500);
      } catch (err) {
        if (stopped) return;
        const error = err instanceof Error ? err : new Error(String(err));
        // Don't log aborts triggered by the unsubscribe path — those are
        // expected.
        if (error.name !== 'AbortError') {
          console.warn('[session-events] SSE error, reconnecting', error);
          handlers.onDisconnect?.(error);
        }
        const backoff = Math.min(
          INITIAL_BACKOFF_MS * 2 ** Math.max(0, attempt - 1),
          MAX_BACKOFF_MS
        );
        await sleep(backoff);
        // Reset the AbortController if the previous one was aborted by
        // something other than us (e.g. a network layer). We track `stopped`
        // for our own teardown signal.
        if (controller.signal.aborted && !stopped) {
          controller = new AbortController();
        }
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
