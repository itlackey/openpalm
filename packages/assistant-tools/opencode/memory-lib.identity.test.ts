import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { listMemories, searchMemories } from './plugins/memory-lib.ts';

type FetchCall = {
  url: string;
  method: string;
  body: unknown;
};

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const rawBody = typeof init?.body === 'string' ? init.body : null;
    const body = rawBody ? JSON.parse(rawBody) : null;
    calls.push({ url, method, body });

    if (url.endsWith('/api/v2/memories/search')) {
      return jsonResponse({ items: [] });
    }
    if (url.endsWith('/api/v1/memories/filter')) {
      return jsonResponse({ items: [] });
    }
    return jsonResponse({ ok: true });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('memory-lib retrieval identity', () => {
  it('does not inject default agent/app/run filters for retrieval', async () => {
    await searchMemories('preferences');
    await listMemories();

    const searchCall = calls.find((call) => call.url.endsWith('/api/v2/memories/search'));
    const listCall = calls.find((call) => call.url.endsWith('/api/v1/memories/filter'));
    const searchBody = (searchCall?.body ?? {}) as Record<string, unknown>;
    const listBody = (listCall?.body ?? {}) as Record<string, unknown>;

    expect(searchBody.user_id).toBeDefined();
    expect(searchBody.agent_id).toBeUndefined();
    expect(searchBody.app_id).toBeUndefined();
    expect(searchBody.run_id).toBeUndefined();

    expect(listBody.user_id).toBeDefined();
    expect(listBody.agent_id).toBeUndefined();
    expect(listBody.app_id).toBeUndefined();
    expect(listBody.run_id).toBeUndefined();
  });

  it('preserves explicitly provided retrieval filters', async () => {
    await searchMemories('procedures', {
      agentId: 'assistant',
      appId: 'openpalm',
      runId: 'run-1',
    });

    const searchCall = calls.find((call) => call.url.endsWith('/api/v2/memories/search'));
    const searchBody = (searchCall?.body ?? {}) as Record<string, unknown>;
    expect(searchBody.agent_id).toBe('assistant');
    expect(searchBody.app_id).toBe('openpalm');
    expect(searchBody.run_id).toBe('run-1');
  });
});
