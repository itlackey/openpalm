import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MemoryContextPlugin } from '../opencode/plugins/memory-context.ts';

type FetchCall = {
  url: string;
  method: string;
  body: unknown;
};

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let memoryIdCounter = 0;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  memoryIdCounter = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const rawBody = typeof init?.body === 'string' ? init.body : null;
    const body = rawBody ? JSON.parse(rawBody) : null;
    calls.push({ url, method, body });

    if (url.includes('/api/v1/stats/')) {
      return jsonResponse({ total_memories: 12, total_apps: 3 });
    }

    if (url.endsWith('/api/v2/memories/search') && method === 'POST') {
      const query = typeof body?.query === 'string' ? body.query : '';
      if (query.startsWith('Session ')) {
        return jsonResponse({ items: [] });
      }
      const category =
        typeof body?.filters?.category === 'string' ? body.filters.category : 'semantic';
      memoryIdCounter++;
      return jsonResponse({
        items: [
          {
            id: `mem-${memoryIdCounter}`,
            content: `${query || 'memory'} guidance`,
            metadata: { category, confidence: 0.9 },
          },
        ],
      });
    }

    if (url.endsWith('/api/v1/memories/filter') && method === 'POST') {
      return jsonResponse({ items: [] });
    }

    if (url.endsWith('/api/v1/memories/') && method === 'POST') {
      return jsonResponse({ id: `stored-${memoryIdCounter++}` });
    }

    if (url.includes('/feedback') && method === 'POST') {
      return jsonResponse({ ok: true });
    }

    if (url.endsWith('/api/v1/memories/') && method === 'DELETE') {
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: true });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('MemoryContextPlugin lifecycle integration', () => {
  it('injects context, applies tool reinforcement, and persists episodic memory', async () => {
    const plugin = await MemoryContextPlugin({ directory: '/workspace/openpalm', client: {} } as never);
    const hooks = plugin as Record<string, (input: unknown, output?: unknown) => Promise<void>>;

    const createdOutput: { context: string[] } = { context: [] };
    await hooks['session.created'](
      {
        session: { id: 'sess-1' },
        project: { name: 'openpalm' },
        agent: { name: 'assistant' },
      },
      createdOutput,
    );

    expect(createdOutput.context.length).toBeGreaterThan(0);
    expect(createdOutput.context[0]).toContain('Memory - Session Context');
    const retrievalCall = calls.find((call) => {
      return call.url.endsWith('/api/v2/memories/search') && call.method === 'POST';
    });
    const retrievalBody = (retrievalCall?.body ?? {}) as Record<string, unknown>;
    expect(retrievalBody.run_id).toBeUndefined();
    expect(retrievalBody.agent_id).toBeUndefined();

    const beforeOutput: { context: string[] } = { context: [] };
    await hooks['tool.execute.before'](
      {
        session: { id: 'sess-1' },
        tool: { name: 'bash' },
        args: {},
      },
      beforeOutput,
    );
    expect(beforeOutput.context.length).toBe(1);
    expect(beforeOutput.context[0]).toContain('Learned Procedures For bash');

    await hooks['tool.execute.after'](
      {
        session: { id: 'sess-1' },
        tool: { name: 'bash' },
        args: {},
      },
      { result: { ok: true } },
    );

    await hooks['session.idle']({ session: { id: 'sess-1' } });
    await hooks['session.idle']({ session: { id: 'sess-1' } });
    await hooks['session.deleted']({ session: { id: 'sess-1' } });

    const feedbackCalls = calls.filter((call) => call.url.includes('/feedback'));
    expect(feedbackCalls.length).toBeGreaterThan(0);

    const episodicWrites = calls.filter((call) => {
      if (!call.url.endsWith('/api/v1/memories/') || call.method !== 'POST') return false;
      const metadata = (call.body as Record<string, unknown>)?.metadata as Record<string, unknown>;
      return metadata?.category === 'episodic';
    });
    expect(episodicWrites.length).toBeGreaterThan(0);
  });
});
