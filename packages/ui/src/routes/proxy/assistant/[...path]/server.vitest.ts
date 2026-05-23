/**
 * Streaming-passthrough test for /proxy/assistant/[...path].
 *
 * Covers the Phase-1 fix: previously the proxy did
 * `await upstream.arrayBuffer()` which buffered entire SSE responses, breaking
 * streaming completions. The proxy must now return upstream.body directly so
 * adapter-node forwards chunks as they arrive.
 *
 * Strategy: stand up a tiny http.Server that emits text/event-stream chunks
 * with explicit delays between them, point the active endpoint at it via
 * OP_OPENCODE_URL, then invoke the proxy handler with a valid op_session
 * cookie and assert the response body is a ReadableStream that delivers
 * incremental chunks (not one buffered payload).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
// Importing the server endpoint directly. We use the .js extension that
// SvelteKit's tsconfig expects for sibling-route imports.
import { POST } from './+server.js';
import type { RequestHandler } from './$types';
import { _replaceState } from '$lib/server/state.js';
import { makeTestState } from '$lib/server/test-helpers.js';

const ENV_KEYS = ['OP_OPENCODE_URL', 'OP_ASSISTANT_URL', 'OP_ASSISTANT_PORT', 'OPENCODE_SERVER_PASSWORD'] as const;
const savedEnv: Record<string, string | undefined> = {};

let sseServer: Server | undefined;
let sseUrl = '';

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  _replaceState(makeTestState());

  // Stand up an SSE emitter that writes 4 chunks with 80ms gaps between them.
  sseServer = createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'transfer-encoding': 'chunked',
      connection: 'keep-alive',
    });
    let i = 0;
    const total = 4;
    const tick = () => {
      if (i >= total) {
        res.end();
        return;
      }
      res.write(`data: chunk-${i}\n\n`);
      i += 1;
      setTimeout(tick, 80);
    };
    tick();
  });
  await new Promise<void>((resolve) => sseServer!.listen(0, '127.0.0.1', resolve));
  const port = (sseServer.address() as AddressInfo).port;
  sseUrl = `http://127.0.0.1:${port}`;
  process.env.OP_OPENCODE_URL = sseUrl;
});

afterEach(async () => {
  await new Promise<void>((resolve) => sseServer?.close(() => resolve()));
  sseServer = undefined;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

type Handler = RequestHandler;

function makeAuthedEvent(): Parameters<Handler>[0] {
  // makeTestState() seeds adminToken = "test-admin-token"; the proxy reads
  // the cookie via the same extractToken() helper used by /admin routes.
  const request = new Request(`http://localhost:8100/proxy/assistant/event`, {
    method: 'POST',
    headers: {
      cookie: 'op_session=test-admin-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  const event = {
    request,
    params: { path: 'event' },
    url: new URL(request.url),
  } as unknown as Parameters<Handler>[0];
  return event;
}

describe('proxy/assistant streaming passthrough', () => {
  it('proxy streams response body incrementally (does not buffer)', async () => {
    const event = makeAuthedEvent();
    const res = await POST(event);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.body).toBeInstanceOf(ReadableStream);

    // Read chunks with timestamps so we can confirm they arrive over time
    // rather than as one buffered blob.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const arrivals: { t: number; text: string }[] = [];
    const start = Date.now();
    let combined = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text.length > 0) {
        arrivals.push({ t: Date.now() - start, text });
        combined += text;
      }
    }

    // We sent 4 chunks 80ms apart, so we should see at least 2 distinct
    // arrivals separated by >= ~50ms (allow slack for CI). If the proxy
    // buffered, all chunks would arrive in a single read at the end.
    expect(arrivals.length).toBeGreaterThanOrEqual(2);
    const spread = arrivals[arrivals.length - 1].t - arrivals[0].t;
    expect(spread).toBeGreaterThanOrEqual(50);

    // And we got every chunk we sent.
    for (let i = 0; i < 4; i++) {
      expect(combined).toContain(`data: chunk-${i}`);
    }
  });

  it('forwards x-request-id, x-endpoint-id, x-endpoint-label headers', async () => {
    const event = makeAuthedEvent();
    const res = await POST(event);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(res.headers.get('x-endpoint-id')).toBe('default');
    expect(res.headers.get('x-endpoint-label')).toBeTruthy();
    // Drain the body so the upstream socket closes cleanly.
    await res.body?.cancel();
  });
});
