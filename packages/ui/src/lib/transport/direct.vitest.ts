/**
 * Minimal direct transport: request (URL/auth-header/credentials/body),
 * authorizationHeader (UTF-8-safe base64, username default), subscribeEvents
 * (SSE frame parse into RawEvent via the reused ui parser), and probeHealth
 * (discriminated status union incl. the insecure short-circuit).
 *
 * All fetch is stubbed — no network. New tests for the new module (the client
 * transport is deliberately NOT ported).
 */
import { describe, expect, test } from 'vitest';
import type { RawEvent } from '../chat/oc-events.js';
import type { Connection } from '../connections/store.js';
import { authorizationHeader, createDirectTransport, type ResolvedAuth } from './direct.js';

type RecordedRequest = {
  url: string;
  method: string;
  headers: Headers;
  credentials: RequestCredentials | undefined;
  cache: RequestCache | undefined;
  body: string | null;
};

function recordingFetch(respond: () => Response | Promise<Response>): {
  fetch: typeof globalThis.fetch;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawBody = init?.body;
    calls.push({
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers),
      credentials: init?.credentials,
      cache: init?.cache,
      body: typeof rawBody === 'string' ? rawBody : rawBody == null ? null : String(rawBody),
    });
    return respond();
  };
  return { fetch: impl as typeof globalThis.fetch, calls };
}

function byteStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const CONNECTION: Connection = {
  id: 'conn-1',
  label: 'Home guardian',
  baseUrl: 'http://gw.example:8443',
  auth: { mode: 'basic', username: 'carol', secretRef: 'sec_1' },
};

const NO_AUTH = async (): Promise<{ authorization?: string }> => ({});

async function withLocation<T>(
  protocol: string,
  hostname: string,
  run: () => Promise<T>
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol, hostname } });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'location', original);
    else delete (globalThis as Record<string, unknown>).location;
  }
}

describe('authorizationHeader', () => {
  test('none mode has no header', () => {
    expect(authorizationHeader({ mode: 'none' })).toBeNull();
  });

  test('basic uses the given username, UTF-8-safe base64', () => {
    expect(authorizationHeader({ mode: 'basic', username: 'alice', password: 's3cret' })).toBe(
      `Basic ${btoa('alice:s3cret')}`
    );
  });

  test('a password-only Basic auth defaults the username to opencode', () => {
    expect(authorizationHeader({ mode: 'basic', password: 's3cret' })).toBe(
      `Basic ${btoa('opencode:s3cret')}`
    );
  });

  test('a non-Latin-1 password does not throw and encodes as UTF-8', () => {
    const auth: ResolvedAuth = { mode: 'basic', username: 'bob', password: 'пароль-密码-🔒' };
    const bytes = new TextEncoder().encode('bob:пароль-密码-🔒');
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    expect(authorizationHeader(auth)).toBe(`Basic ${btoa(binary)}`);
  });
});

describe('request', () => {
  test('GET hits baseUrl+path with credentials omit and the resolved auth header', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('{}', { status: 200 }));
    const transport = createDirectTransport(
      () => CONNECTION,
      async () => ({ authorization: 'Basic abc' }),
      fetch
    );
    await transport.request('GET', '/session');
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('http://gw.example:8443/session');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].credentials).toBe('omit');
    expect(calls[0].headers.get('authorization')).toBe('Basic abc');
    expect(calls[0].body).toBeNull();
  });

  test('POST serializes a JSON body and sets content-type', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('{}', { status: 200 }));
    const transport = createDirectTransport(() => CONNECTION, NO_AUTH, fetch);
    await transport.request('POST', '/session', { title: 'hi' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.get('content-type')).toBe('application/json');
    expect(calls[0].body).toBe(JSON.stringify({ title: 'hi' }));
    // No resolved auth -> no authorization header.
    expect(calls[0].headers.get('authorization')).toBeNull();
  });

  test('a trailing slash on baseUrl does not double up with the path', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('{}', { status: 200 }));
    const transport = createDirectTransport(
      () => ({ ...CONNECTION, baseUrl: 'http://gw.example:8443/' }),
      NO_AUTH,
      fetch
    );
    await transport.request('GET', '/session');
    expect(calls[0].url).toBe('http://gw.example:8443/session');
  });

  test('a non-ok response throws an error carrying the status', async () => {
    const { fetch } = recordingFetch(() => new Response('nope', { status: 503 }));
    const transport = createDirectTransport(() => CONNECTION, NO_AUTH, fetch);
    await expect(transport.request('GET', '/session')).rejects.toMatchObject({ status: 503 });
  });

  test('no active connection throws', async () => {
    const { fetch } = recordingFetch(() => new Response('{}', { status: 200 }));
    const transport = createDirectTransport(() => null, NO_AUTH, fetch);
    await expect(transport.request('GET', '/session')).rejects.toThrow(/No active connection/);
  });
});

describe('subscribeEvents', () => {
  test('parses SSE frames into RawEvent objects and forwards them to onFrame', async () => {
    const stream = byteStream([
      'event: message\ndata: {"type":"session.idle","properties":{"sessionID":"s1"}}\n\n',
      ': heartbeat\n\n',
      'data: {"type":"message.part.delta","properties":{"delta":"hi"}}\n\n',
    ]);
    const { fetch, calls } = recordingFetch(
      () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    );
    const transport = createDirectTransport(
      () => CONNECTION,
      async () => ({ authorization: 'Basic abc' }),
      fetch
    );
    const events: RawEvent[] = [];
    await transport.subscribeEvents((event) => events.push(event), new AbortController().signal);

    expect(calls[0].url).toBe('http://gw.example:8443/event');
    expect(calls[0].credentials).toBe('omit');
    expect(calls[0].headers.get('authorization')).toBe('Basic abc');
    expect(calls[0].headers.get('accept')).toBe('text/event-stream');
    expect(events).toEqual([
      { type: 'session.idle', properties: { sessionID: 's1' } },
      { type: 'message.part.delta', properties: { delta: 'hi' } },
    ]);
  });

  test('skips frames whose data is not valid JSON', async () => {
    const stream = byteStream(['data: not json{\n\n', 'data: {"type":"ok"}\n\n']);
    const { fetch } = recordingFetch(() => new Response(stream, { status: 200 }));
    const transport = createDirectTransport(() => CONNECTION, NO_AUTH, fetch);
    const events: RawEvent[] = [];
    await transport.subscribeEvents((event) => events.push(event), new AbortController().signal);
    expect(events).toEqual([{ type: 'ok' }]);
  });

  test('a non-ok stream response throws', async () => {
    const { fetch } = recordingFetch(() => new Response('no', { status: 401 }));
    const transport = createDirectTransport(() => CONNECTION, NO_AUTH, fetch);
    await expect(
      transport.subscribeEvents(() => {}, new AbortController().signal)
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('probeHealth', () => {
  test('2xx is accessible, with credentials omit and no-store cache', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('ok', { status: 200 }));
    const transport = createDirectTransport(() => CONNECTION, NO_AUTH, fetch);
    expect(await transport.probeHealth()).toEqual({ status: 'accessible' });
    expect(calls[0].url).toBe('http://gw.example:8443/');
    expect(calls[0].credentials).toBe('omit');
    expect(calls[0].cache).toBe('no-store');
  });

  test('401/403 is unauthorized', async () => {
    const { fetch } = recordingFetch(() => new Response('no', { status: 401 }));
    const transport = createDirectTransport(() => CONNECTION, NO_AUTH, fetch);
    expect(await transport.probeHealth()).toEqual({ status: 'unauthorized' });
  });

  test('a 5xx status is unreachable', async () => {
    const { fetch } = recordingFetch(() => new Response('boom', { status: 502 }));
    const transport = createDirectTransport(() => CONNECTION, NO_AUTH, fetch);
    expect(await transport.probeHealth()).toEqual({ status: 'unreachable' });
  });

  test('a thrown fetch is unreachable, not an exception', async () => {
    const fetch = (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof globalThis.fetch;
    const transport = createDirectTransport(() => CONNECTION, NO_AUTH, fetch);
    expect(await transport.probeHealth()).toEqual({ status: 'unreachable' });
  });

  test('no active connection is unreachable without a fetch', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('ok', { status: 200 }));
    const transport = createDirectTransport(() => null, NO_AUTH, fetch);
    expect(await transport.probeHealth()).toEqual({ status: 'unreachable' });
    expect(calls.length).toBe(0);
  });

  test('short-circuits a plain-http remote target on an https origin — insecure, zero fetches', async () => {
    await withLocation('https:', 'app.openpalm.dev', async () => {
      const { fetch, calls } = recordingFetch(() => new Response('ok', { status: 200 }));
      const transport = createDirectTransport(
        () => ({ ...CONNECTION, baseUrl: 'http://gw.lan:3830' }),
        NO_AUTH,
        fetch
      );
      expect(await transport.probeHealth()).toEqual({ status: 'insecure' });
      expect(calls.length).toBe(0);
    });
  });

  test('still probes a loopback target from an https origin', async () => {
    await withLocation('https:', 'app.openpalm.dev', async () => {
      const { fetch, calls } = recordingFetch(() => new Response('ok', { status: 200 }));
      const transport = createDirectTransport(
        () => ({ ...CONNECTION, baseUrl: 'http://127.0.0.1:3800' }),
        NO_AUTH,
        fetch
      );
      expect(await transport.probeHealth()).toEqual({ status: 'accessible' });
      expect(calls.length).toBe(1);
    });
  });
});
