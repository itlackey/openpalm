import { describe, expect, it, afterEach } from 'bun:test';
import { GuardianOpenAiApi } from './openai-api.ts';

const REAL_FETCH = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = REAL_FETCH;
});

function stubStreamingGuardian(): void {
  const encoder = new TextEncoder();
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('http://guardian:8080/oc', '');
    const method = init?.method ?? 'GET';
    if (method === 'POST' && path === '/session') return new Response(JSON.stringify({ id: 'ses_stub' }), { status: 200 });
    if (method === 'POST' && path === '/session/ses_stub/message') return new Response(JSON.stringify({ parts: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/event') {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'session.status', properties: { sessionID: 'ses_stub', status: 'idle' } })}\n\n`));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  (globalThis as { fetch: typeof fetch }).fetch = stub;
}

type CapturedCall = { url: string; method: string; headers: Headers; body: string };

function ocFetchStub(calls?: CapturedCall[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: CapturedCall = { url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : '' };
    calls?.push(call);
    const path = call.url.replace('http://guardian:8080/oc', '');
    if (call.method === 'POST' && path === '/session') return Response.json({ id: 's1' });
    if (call.method === 'GET' && path === '/event') {
      const sse = [
        JSON.stringify({ type: 'message.part.delta', properties: { sessionID: 's1', messageID: '^msg1', delta: 'hello back' } }),
        JSON.stringify({ type: 'session.idle', properties: { sessionID: 's1' } }),
      ].map((frame) => `data: ${frame}\n\n`).join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (call.method === 'POST' && path === '/session/s1/message') return new Response(JSON.stringify({ parts: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('not found', { status: 404 });
  };
}

function createHandler(opts?: { apiKey?: string }) {
  const api = new GuardianOpenAiApi();
  Object.defineProperty(api, 'secret', { get: () => 'test-secret' });
  if (opts?.apiKey !== undefined) Object.defineProperty(api, 'apiKey', { get: () => opts.apiKey });
  return api.createFetch(ocFetchStub() as typeof fetch);
}

function createHandlerWithCapture(opts?: { apiKey?: string }) {
  const calls: CapturedCall[] = [];
  const api = new GuardianOpenAiApi();
  Object.defineProperty(api, 'secret', { get: () => 'test-secret' });
  if (opts?.apiKey !== undefined) Object.defineProperty(api, 'apiKey', { get: () => opts.apiKey });
  const handler = api.createFetch(ocFetchStub(calls) as typeof fetch);
  return { handler, captured: () => calls };
}

describe('guardian openai api health', () => {
  it('GET /health returns 200', async () => {
    const handler = createHandler();
    const resp = await handler(new Request('http://api/health'));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe('guardian-openai-api');
  });
});

describe('guardian openai api models', () => {
  it('GET /v1/models returns model list', async () => {
    const handler = createHandler();
    const resp = await handler(new Request('http://api/v1/models'));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.object).toBe('list');
  });
});

describe('guardian openai api chat completions', () => {
  it('returns chat.completion shape', async () => {
    const handler = createHandler();
    const resp = await handler(new Request('http://api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] }) }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.object).toBe('chat.completion');
    expect((((body.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>).content)).toBe('hello back');
  });

  it('forwards correct payload to guardian', async () => {
    const { handler, captured } = createHandlerWithCapture();
    await handler(new Request('http://api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-4o-mini', user: 'u1', messages: [{ role: 'user', content: 'hello' }] }) }));
    const calls = captured();
    const createCall = calls.find((call) => call.method === 'POST' && call.url === 'http://guardian:8080/oc/session');
    const messageCall = calls.find((call) => call.method === 'POST' && call.url === 'http://guardian:8080/oc/session/s1/message');
    expect(createCall?.headers.get('authorization')).toBe(`Basic ${Buffer.from('api:test-secret', 'utf-8').toString('base64')}`);
    expect(createCall?.headers.get('x-openpalm-user')).toBe('api:u1');
    expect(createCall?.headers.get('x-openpalm-session-key')).toBe('api:u1');
    const parsed = JSON.parse(messageCall?.body ?? '{}') as Record<string, unknown>;
    expect((parsed.parts as Array<Record<string, unknown>>)[0]?.text).toBe('hello');
  });

  it('honors stream:true with an SSE chat.completion.chunk response', async () => {
    stubStreamingGuardian();
    const handler = createHandler();
    const resp = await handler(new Request('http://api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-4', stream: true, messages: [{ role: 'user', content: 'hi' }] }) }));
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('text/event-stream');
  });
});

describe('guardian openai api legacy completions', () => {
  it('returns text_completion shape', async () => {
    const handler = createHandler();
    const resp = await handler(new Request('http://api/v1/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-3.5', prompt: 'hello' }) }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.object).toBe('text_completion');
  });
});

describe('guardian openai api anthropic messages', () => {
  it('returns Anthropic message shape', async () => {
    const handler = createHandler();
    const resp = await handler(new Request('http://api/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-3', max_tokens: 1024, messages: [{ role: 'user', content: 'hello' }] }) }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.type).toBe('message');
  });
});

describe('guardian openai api auth', () => {
  it('rejects unauthorized chat completions when API key is set', async () => {
    const handler = createHandler({ apiKey: 'key-123' });
    const resp = await handler(new Request('http://api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] }) }));
    expect(resp.status).toBe(401);
  });

  it('accepts Anthropic messages with correct x-api-key', async () => {
    const handler = createHandler({ apiKey: 'key-123' });
    const resp = await handler(new Request('http://api/v1/messages', { method: 'POST', headers: { 'x-api-key': 'key-123' }, body: JSON.stringify({ model: 'claude-3', max_tokens: 1024, messages: [{ role: 'user', content: 'hello' }] }) }));
    expect(resp.status).toBe(200);
  });
});

// --- CHARACTERIZATION: non-streaming path is a pure text accumulator ----------
// The non-streaming collector (collectTurnAnswer, reached via the forward path)
// MUST NOT apply permission policy, MUST NOT reject questions, and MUST NOT
// break on session.error. It only accumulates text deltas until turn end.
function policyEventStub(calls: CapturedCall[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: CapturedCall = { url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : '' };
    calls.push(call);
    const path = call.url.replace('http://guardian:8080/oc', '');
    if (call.method === 'POST' && path === '/session') return Response.json({ id: 's1' });
    if (call.method === 'GET' && path === '/event') {
      const sse = [
        JSON.stringify({ type: 'permission.asked', properties: { id: 'per_ns', sessionID: 's1', permission: 'bash', patterns: ['echo x'] } }),
        JSON.stringify({ type: 'question.asked', properties: { id: 'q_ns', sessionID: 's1', questions: [{ question: 'ok?', header: 'h', options: [{ label: 'yes', description: '' }] }] } }),
        JSON.stringify({ type: 'message.part.delta', properties: { sessionID: 's1', delta: 'accum' } }),
        JSON.stringify({ type: 'session.error', properties: { sessionID: 's1' } }),
        JSON.stringify({ type: 'message.part.delta', properties: { sessionID: 's1', delta: 'ulated' } }),
        JSON.stringify({ type: 'session.idle', properties: { sessionID: 's1' } }),
      ].map((frame) => `data: ${frame}\n\n`).join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (call.method === 'POST' && path === '/session/s1/message') return new Response(JSON.stringify({ parts: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('not found', { status: 404 });
  };
}

describe('guardian openai api non-streaming policy characterization', () => {
  it('does NOT apply permission policy, reject questions, or break on session.error', async () => {
    const calls: CapturedCall[] = [];
    const api = new GuardianOpenAiApi();
    Object.defineProperty(api, 'secret', { get: () => 'test-secret' });
    Object.defineProperty(api, 'apiKey', { get: () => '' });
    const handler = api.createFetch(policyEventStub(calls) as typeof fetch);
    const resp = await handler(new Request('http://api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }) }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    const content = (((body.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>).content);
    // Accumulated text spans the delta AFTER session.error -> the collector did
    // not break on session.error (unlike the streaming path).
    expect(content).toBe('accumulated');
    // No permission reply and no question rejection were ever sent.
    expect(calls.some((call) => call.url.includes('/permission/'))).toBe(false);
    expect(calls.some((call) => call.url.includes('/question/'))).toBe(false);
  });
});

describe('guardian openai api error handling', () => {
  it('returns 404 for unknown paths', async () => {
    const handler = createHandler();
    const resp = await handler(new Request('http://api/v1/unknown', { method: 'POST' }));
    expect(resp.status).toBe(404);
  });

  it('returns 502 when guardian throws', async () => {
    const throwFetch = (async () => { throw new Error('network error'); }) as typeof fetch;
    const api = new GuardianOpenAiApi();
    Object.defineProperty(api, 'secret', { get: () => 'test-secret' });
    Object.defineProperty(api, 'apiKey', { get: () => '' });
    const handler = api.createFetch(throwFetch);
    const resp = await handler(new Request('http://api/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-3', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] }) }));
    expect(resp.status).toBe(502);
  });
});
