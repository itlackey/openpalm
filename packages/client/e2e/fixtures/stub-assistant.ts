/**
 * A minimal, zero-dependency stand-in for an OpenCode/guardian assistant
 * (G2/§12.2, review 2026-07-10) — implements just enough of the surface
 * `$lib/transport/index.ts` talks to (GET /, GET /session, POST /session,
 * POST /session/:id/message, POST /session/:id/abort, GET /session/:id/
 * message, GET /event) for the Playwright suite to drive real chat/history/
 * stop/streaming behavior against the built client, with no docker and no
 * live assistant. Modeled on bin/serve.mjs's style (plain node:http, no
 * deps) rather than route interception, because the streaming-render and
 * stop assertions need genuine incremental SSE delivery with real timing —
 * Playwright's `page.route().fulfill()` only supports a fixed response
 * body, not a long-lived push stream.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type SessionMessagePart = { type: string; text?: string };
export type SessionMessageRow = {
  info: { id: string; role: 'user' | 'assistant'; time: { created: number } };
  parts: SessionMessagePart[];
};

export type StubAssistantOptions = {
  /** Called synchronously when a POST /session/:id/message body is received,
   *  before the response is sent — the test's chance to push SSE deltas
   *  ahead of the HTTP response resolving (proves streaming, not polling). */
  onMessage?: (assistant: StubAssistant, sessionId: string, text: string) => void;
  /** Delay (ms) before the POST /session/:id/message response is sent. */
  respondAfterMs?: number;
};

export type StubAssistant = {
  url: string;
  close(): Promise<void>;
  /** Push one SSE frame (`{type, properties}`) to every open /event stream. */
  pushEvent(type: string, properties: Record<string, unknown>): void;
  /** Session ids that received a POST /session/:id/abort. */
  abortedSessions: Set<string>;
  /** Every session's row history, keyed by session id (mutable — tests may seed it). */
  sessions: Map<string, SessionMessageRow[]>;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

export async function startStubAssistant(options: StubAssistantOptions = {}): Promise<StubAssistant> {
  const sessions = new Map<string, SessionMessageRow[]>();
  const abortedSessions = new Set<string>();
  const eventClients = new Set<ServerResponse>();
  let nextSessionId = 1;

  function pushEvent(type: string, properties: Record<string, unknown>): void {
    const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
    for (const client of eventClients) client.write(frame);
  }

  const server = createServer((req, res) => {
    // The transport (like a real OpenCode/guardian connection) is a
    // cross-origin request from the client's own origin — CORS preflight
    // (OPTIONS) plus Access-Control-Allow-* on every actual response, or
    // the browser blocks every fetch before it reaches any route below.
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
    }
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, last-event-id');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stub.local');
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('ok');
      }

      if (method === 'GET' && url.pathname === '/event') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        eventClients.add(res);
        req.on('close', () => eventClients.delete(res));
        return;
      }

      if (method === 'GET' && url.pathname === '/session') {
        const list = [...sessions.entries()].map(([id, rows]) => {
          const created = rows[0]?.info.time.created ?? Date.now();
          const updated = rows.at(-1)?.info.time.created ?? created;
          return { id, title: '', time: { created, updated } };
        });
        return json(res, 200, list);
      }

      if (method === 'POST' && url.pathname === '/session') {
        const id = `sess-${nextSessionId++}`;
        sessions.set(id, []);
        return json(res, 200, { id });
      }

      const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
      if (messageMatch) {
        const sessionId = decodeURIComponent(messageMatch[1]);
        if (method === 'GET') {
          return json(res, 200, sessions.get(sessionId) ?? []);
        }
        if (method === 'POST') {
          const raw = await readBody(req);
          const body = raw ? (JSON.parse(raw) as { parts?: SessionMessagePart[] }) : {};
          const text = body.parts?.find((p) => p.type === 'text')?.text ?? '';
          const rows = sessions.get(sessionId) ?? [];
          rows.push({
            info: { id: `${sessionId}-u${rows.length}`, role: 'user', time: { created: Date.now() } },
            parts: [{ type: 'text', text }],
          });
          sessions.set(sessionId, rows);

          options.onMessage?.(assistant, sessionId, text);

          setTimeout(() => {
            // A stop()-triggered abort closes this response's underlying
            // connection before the timeout fires — writing to it then would
            // throw an unhandled "write after end" inside a bare setTimeout.
            if (res.writableEnded || res.destroyed) return;
            json(res, 200, { parts: [] });
          }, options.respondAfterMs ?? 20);
          return;
        }
      }

      const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
      if (abortMatch && method === 'POST') {
        abortedSessions.add(decodeURIComponent(abortMatch[1]));
        return json(res, 200, {});
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    })().catch((error) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const assistant: StubAssistant = {
    url: `http://127.0.0.1:${port}`,
    sessions,
    abortedSessions,
    pushEvent,
    close(): Promise<void> {
      for (const client of eventClients) client.end();
      // The browser keeps every HTTP/1.1 connection to this server
      // keep-alive'd (idle, not closed) even after each request/response
      // completes — server.close() alone waits forever for the page's own
      // idle sockets to close on their own, which only happens when the
      // page navigates away or the test's browser context tears down
      // (after this afterEach hook, not before). closeAllConnections()
      // forcibly ends every open socket so this resolves promptly.
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };

  return assistant;
}

/** Records the assistant's reply into session history (so a later
 *  getSessionMessages()/history reload sees it) — call from onMessage after
 *  streaming the reply's deltas. */
export function recordAssistantReply(assistant: StubAssistant, sessionId: string, text: string): void {
  const rows = assistant.sessions.get(sessionId) ?? [];
  rows.push({
    info: { id: `${sessionId}-a${rows.length}`, role: 'assistant', time: { created: Date.now() } },
    parts: [{ type: 'text', text }],
  });
  assistant.sessions.set(sessionId, rows);
}

/** Streams `text` as a handful of `message.part.delta` SSE events (a few ms
 *  apart) followed by `session.idle` — the shape chat-controller.ts's
 *  extractTextDelta/isTurnEnd expect (both scoped by `sessionID`). */
export async function streamReply(
  assistant: StubAssistant,
  sessionId: string,
  text: string,
  options: { chunkSize?: number; delayMs?: number } = {}
): Promise<void> {
  const chunkSize = options.chunkSize ?? 6;
  const delayMs = options.delayMs ?? 25;
  for (let i = 0; i < text.length; i += chunkSize) {
    assistant.pushEvent('message.part.delta', {
      sessionID: sessionId,
      field: 'text',
      delta: text.slice(i, i + chunkSize),
    });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  assistant.pushEvent('session.idle', { sessionID: sessionId });
}
