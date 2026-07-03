import { describe, test, expect, afterEach } from 'bun:test';
import { _internal, streamTurn, openAiChatFramer, anthropicFramer } from './openai-api-stream.ts';
import { loadPermissionPolicy } from './openai-api-permissions.ts';
import { createGatewayClient } from './openai-api-oc-client.ts';

const REAL_FETCH = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = REAL_FETCH;
});

function sseBody(events: Array<{ type: string; properties: Record<string, unknown> }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
}

interface StubOpts {
  sessionId: string;
  events: Array<{ type: string; properties: Record<string, unknown> }>;
  calls: Array<{ method: string; path: string; body: string }>;
}

function stubGuardian(opts: StubOpts): void {
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const path = url.replace('http://guardian:8080/oc', '');
    opts.calls.push({ method, path, body: typeof init?.body === 'string' ? init.body : '' });
    if (method === 'POST' && path === '/session') return new Response(JSON.stringify({ id: opts.sessionId }), { status: 200 });
    if (method === 'POST' && path.endsWith('/message')) return new Response(JSON.stringify({ info: {}, parts: [] }), { status: 200 });
    if (method === 'GET' && path === '/event') return new Response(sseBody(opts.events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    if (method === 'POST' && path.includes('/permission/')) return new Response(JSON.stringify(true), { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  (globalThis as { fetch: typeof fetch }).fetch = stub;
}

async function readAll(resp: Response): Promise<string> {
  // biome-ignore lint/style/noNonNullAssertion: streaming test responses always have a body.
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

const SESSION_ID = 'ses_api_target';

describe('openAiChunk — chat.completion.chunk delta frame', () => {
  test('wraps the delta as a content delta and terminates with a blank line', () => {
    const frame = _internal.openAiChunk('chatcmpl-x', 'gpt-4', 'hello');
    expect(frame.startsWith('data: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    const json = JSON.parse(frame.slice('data: '.length).trim());
    expect(json.object).toBe('chat.completion.chunk');
    expect(json.id).toBe('chatcmpl-x');
    expect(json.model).toBe('gpt-4');
    expect(json.choices[0].delta.content).toBe('hello');
    expect(json.choices[0].finish_reason).toBeNull();
  });
});

describe('openAiDoneChunks — terminal stop + [DONE]', () => {
  test('emits a finish_reason:stop chunk then data: [DONE]', () => {
    const out = _internal.openAiDoneChunks('chatcmpl-x', 'gpt-4');
    const frames = out.split('\n\n').filter(Boolean);
    const stop = JSON.parse(frames[0].slice('data: '.length));
    expect(stop.choices[0].finish_reason).toBe('stop');
    expect(stop.choices[0].delta).toEqual({});
    expect(frames[1]).toBe('data: [DONE]');
  });
});

describe('openAiLegacyChunk — text_completion streaming frame', () => {
  test('carries text + finish_reason', () => {
    const json = JSON.parse(_internal.openAiLegacyChunk('cmpl-x', 'gpt-3.5', 'abc', null).slice('data: '.length));
    expect(json.object).toBe('text_completion');
    expect(json.choices[0].text).toBe('abc');
    expect(json.choices[0].finish_reason).toBeNull();
  });
});

describe('anthropic framing — message_start … message_stop sequence', () => {
  test('start emits message_start then content_block_start', () => {
    const out = _internal.anthropicStart('msg_x', 'claude-3');
    expect(out).toContain('event: message_start');
    expect(out).toContain('event: content_block_start');
    const first = JSON.parse(out.split('\n\n')[0].split('data: ')[1]);
    expect(first.type).toBe('message_start');
    expect(first.message.id).toBe('msg_x');
    expect(first.message.role).toBe('assistant');
  });

  test('delta is a text_delta content_block_delta', () => {
    const json = JSON.parse(_internal.anthropicDelta('hi').split('data: ')[1].trim());
    expect(json.type).toBe('content_block_delta');
    expect(json.delta.type).toBe('text_delta');
    expect(json.delta.text).toBe('hi');
  });

  test('stop emits block_stop → message_delta → message_stop', () => {
    const out = _internal.anthropicStop();
    expect(out).toContain('event: content_block_stop');
    expect(out).toContain('event: message_delta');
    expect(out).toContain('event: message_stop');
  });
});

describe('streamTurn — OpenAI deltas map to chat.completion.chunk SSE', () => {
  test('text deltas for our session stream as chunks, ending with [DONE]', async () => {
    const calls: StubOpts['calls'] = [];
    stubGuardian({
      sessionId: SESSION_ID,
      calls,
      events: [
        { type: 'message.part.delta', properties: { sessionID: SESSION_ID, delta: 'Hel' } },
        { type: 'message.part.delta', properties: { sessionID: SESSION_ID, delta: 'lo' } },
        { type: 'session.status', properties: { sessionID: SESSION_ID, status: 'idle' } },
      ],
    });
    const client = createGatewayClient('http://guardian:8080/oc', 'api', 's');
    const resp = streamTurn({ client, policy: loadPermissionPolicy({}), userId: 'api:u1', sessionKey: 'api:u1', text: 'hi', framer: openAiChatFramer('chatcmpl-test', 'gpt-4') });
    expect(resp.headers.get('content-type')).toBe('text/event-stream');
    const out = await readAll(resp);
    expect(out).toContain('"role":"assistant"');
    expect(out).toContain('"content":"Hel"');
    expect(out).toContain('"content":"lo"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(calls.some((call) => call.method === 'POST' && call.path === '/session')).toBe(true);
    expect(calls.some((call) => call.path.endsWith('/message'))).toBe(true);
    expect(calls.some((call) => call.path === '/event')).toBe(true);
  });
});

describe('streamTurn — Anthropic deltas map to content_block_delta SSE', () => {
  test('emits message_start, a text_delta, and the stop sequence', async () => {
    const calls: StubOpts['calls'] = [];
    stubGuardian({
      sessionId: SESSION_ID,
      calls,
      events: [
        { type: 'session.next.text.delta', properties: { sessionID: SESSION_ID, delta: 'world' } },
        { type: 'session.status', properties: { sessionID: SESSION_ID, status: 'idle' } },
      ],
    });
    const client = createGatewayClient('http://guardian:8080/oc', 'api', 's');
    const resp = streamTurn({ client, policy: loadPermissionPolicy({}), userId: 'api:u1', sessionKey: 'api:u1', text: 'hi', framer: anthropicFramer('msg_test', 'claude-3') });
    const out = await readAll(resp);
    expect(out).toContain('event: message_start');
    expect(out).toContain('"text":"world"');
    expect(out).toContain('event: message_stop');
  });
});

describe('streamTurn — non-interactive permission policy', () => {
  test('default policy rejects permission.asked via a signed guardian reply', async () => {
    const calls: StubOpts['calls'] = [];
    stubGuardian({
      sessionId: SESSION_ID,
      calls,
      events: [
        { type: 'permission.asked', properties: { id: 'per_42', sessionID: SESSION_ID, permission: 'bash', patterns: ['echo x'] } },
        { type: 'session.status', properties: { sessionID: SESSION_ID, status: 'idle' } },
      ],
    });
    const client = createGatewayClient('http://guardian:8080/oc', 'api', 's');
    const resp = streamTurn({ client, policy: loadPermissionPolicy({}), userId: 'api:u1', sessionKey: 'api:u1', text: 'run bash', framer: openAiChatFramer('chatcmpl-test', 'gpt-4') });
    await readAll(resp);
    const reply = calls.find((call) => call.path === '/permission/per_42/reply');
    expect(reply).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: reply is asserted defined immediately above.
    expect(JSON.parse(reply!.body).reply).toBe('reject');
  });

  test('auto policy with an allowlist approves the matching tool', async () => {
    const calls: StubOpts['calls'] = [];
    stubGuardian({
      sessionId: SESSION_ID,
      calls,
      events: [
        { type: 'permission.asked', properties: { id: 'per_99', sessionID: SESSION_ID, permission: 'bash', patterns: [] } },
        { type: 'session.status', properties: { sessionID: SESSION_ID, status: 'idle' } },
      ],
    });
    const client = createGatewayClient('http://guardian:8080/oc', 'api', 's');
    const resp = streamTurn({ client, policy: loadPermissionPolicy({ OP_API_PERMISSION_MODE: 'auto', OP_API_PERMISSION_ALLOWLIST: 'bash' }), userId: 'api:u1', sessionKey: 'api:u1', text: 'run bash', framer: openAiChatFramer('chatcmpl-test', 'gpt-4') });
    await readAll(resp);
    const reply = calls.find((call) => call.path === '/permission/per_99/reply');
    // biome-ignore lint/style/noNonNullAssertion: the matching permission reply is guaranteed to have been recorded.
    expect(JSON.parse(reply!.body).reply).toBe('once');
  });
});

// --- CHARACTERIZATION: streaming path security divergence ---------------------
// These pin the behaviors the streaming path MUST keep and that the
// non-streaming path (openai-api.test.ts) MUST NOT have.

describe('streamTurn — CHARACTERIZATION: rejects interactive questions', () => {
  test('question.asked is rejected via a signed guardian reject call', async () => {
    const calls: StubOpts['calls'] = [];
    stubGuardian({
      sessionId: SESSION_ID,
      calls,
      events: [
        { type: 'question.asked', properties: { id: 'q_1', sessionID: SESSION_ID, questions: [{ question: 'proceed?', header: 'h', options: [{ label: 'yes', description: '' }] }] } },
        { type: 'session.status', properties: { sessionID: SESSION_ID, status: 'idle' } },
      ],
    });
    const client = createGatewayClient('http://guardian:8080/oc', 'api', 's');
    const resp = streamTurn({ client, policy: loadPermissionPolicy({}), userId: 'api:u1', sessionKey: 'api:u1', text: 'ask me', framer: openAiChatFramer('chatcmpl-test', 'gpt-4') });
    await readAll(resp);
    const reject = calls.find((call) => call.method === 'POST' && call.path === '/question/q_1/reject');
    expect(reject).toBeDefined();
  });
});

describe('streamTurn — CHARACTERIZATION: breaks on session.error', () => {
  test('a session.error terminates the turn; deltas after it are not emitted', async () => {
    const calls: StubOpts['calls'] = [];
    stubGuardian({
      sessionId: SESSION_ID,
      calls,
      events: [
        { type: 'message.part.delta', properties: { sessionID: SESSION_ID, delta: 'BEFORE' } },
        { type: 'session.error', properties: { sessionID: SESSION_ID } },
        { type: 'message.part.delta', properties: { sessionID: SESSION_ID, delta: 'AFTER' } },
        { type: 'session.status', properties: { sessionID: SESSION_ID, status: 'idle' } },
      ],
    });
    const client = createGatewayClient('http://guardian:8080/oc', 'api', 's');
    const resp = streamTurn({ client, policy: loadPermissionPolicy({}), userId: 'api:u1', sessionKey: 'api:u1', text: 'go', framer: openAiChatFramer('chatcmpl-test', 'gpt-4') });
    const out = await readAll(resp);
    expect(out).toContain('"content":"BEFORE"');
    expect(out).not.toContain('AFTER');
    expect(out.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});

describe('streamTurn — CHARACTERIZATION: enforces the render timeout', () => {
  test('an already-expired deadline breaks before any delta is emitted', async () => {
    const realNow = Date.now;
    let clock = 0;
    // Every Date.now() reading jumps far past the previous one. The deadline is
    // computed before the loop, so the loop's first `Date.now() > deadline`
    // guard is always a later (larger) reading and fires immediately —
    // regardless of how many intervening Date.now() calls occur.
    (Date as unknown as { now: () => number }).now = () => (clock += 10 ** 15);
    try {
      const calls: StubOpts['calls'] = [];
      stubGuardian({
        sessionId: SESSION_ID,
        calls,
        events: [
          { type: 'message.part.delta', properties: { sessionID: SESSION_ID, delta: 'NEVER' } },
          { type: 'session.status', properties: { sessionID: SESSION_ID, status: 'idle' } },
        ],
      });
      const client = createGatewayClient('http://guardian:8080/oc', 'api', 's');
      const resp = streamTurn({ client, policy: loadPermissionPolicy({}), userId: 'api:u1', sessionKey: 'api:u1', text: 'go', framer: openAiChatFramer('chatcmpl-test', 'gpt-4') });
      const out = await readAll(resp);
      expect(out).not.toContain('NEVER');
      expect(out.trimEnd().endsWith('data: [DONE]')).toBe(true);
    } finally {
      (Date as unknown as { now: () => number }).now = realNow;
    }
  });
});
