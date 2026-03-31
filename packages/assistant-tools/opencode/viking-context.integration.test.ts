import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MemoryContextPlugin } from './plugins/memory-context.ts';

type FetchCall = {
  url: string;
  method: string;
  body: unknown;
};

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let calls: FetchCall[] = [];
let memoryIdCounter = 0;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function setupVikingEnv() {
  process.env.OPENVIKING_URL = 'http://viking:9090';
  process.env.OPENVIKING_API_KEY = 'test-viking-key';
}

function clearVikingEnv() {
  delete process.env.OPENVIKING_URL;
  delete process.env.OPENVIKING_API_KEY;
}

function installFetchMock() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const rawBody = typeof init?.body === 'string' ? init.body : null;
    const body = rawBody ? JSON.parse(rawBody) : null;
    calls.push({ url, method, body });

    // Memory API mocks
    if (url.includes('/api/v1/stats/')) {
      return jsonResponse({ total_memories: 12, total_apps: 3 });
    }

    if (url.endsWith('/api/v2/memories/search') && method === 'POST') {
      const query = typeof body?.query === 'string' ? body.query : '';
      if (query.startsWith('Session ')) {
        return jsonResponse({ items: [] });
      }
      memoryIdCounter++;
      const category =
        typeof body?.filters?.category === 'string' ? body.filters.category : 'semantic';
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

    // Viking API mocks
    if (url.includes('/api/v1/sessions') && method === 'POST' && !url.includes('/messages') && !url.includes('/commit')) {
      return jsonResponse({ result: { session_id: 'viking-sess-42' } });
    }

    if (url.includes('/api/v1/content/abstract')) {
      if (url.includes('memories')) {
        return jsonResponse({ result: 'Agent memory abstract summary' });
      }
      if (url.includes('resources')) {
        return jsonResponse({ result: 'Resources abstract summary' });
      }
    }

    if (url.includes('/api/v1/content/overview')) {
      return jsonResponse({ result: 'Viking knowledge overview content' });
    }

    if (url.includes('/messages') && method === 'POST') {
      return jsonResponse({ ok: true });
    }

    if (url.includes('/commit') && method === 'POST') {
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: true });
  }) as typeof fetch;
}

function vikingCalls(): FetchCall[] {
  return calls.filter((c) => c.url.includes('viking:9090'));
}

function memoryCalls(): FetchCall[] {
  return calls.filter((c) => !c.url.includes('viking:9090'));
}

async function createPlugin() {
  return (await MemoryContextPlugin({
    directory: '/workspace/openpalm',
    client: {},
  } as never)) as Record<string, (input: unknown, output?: unknown) => Promise<void>>;
}

beforeEach(() => {
  calls = [];
  memoryIdCounter = 0;
  installFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearVikingEnv();
  // Restore original env
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, val] of Object.entries(originalEnv)) {
    if (val !== undefined) process.env[key] = val;
  }
});

describe('Viking + MemoryContextPlugin integration', () => {
  it('Viking disabled: zero Viking fetch calls, existing memory behavior intact', async () => {
    clearVikingEnv();
    const hooks = await createPlugin();

    const output: { context: string[] } = { context: [] };
    await hooks['session.created'](
      { session: { id: 'sess-no-viking' }, project: { name: 'test-proj' }, agent: { name: 'assistant' } },
      output,
    );

    // Memory context should still be injected
    expect(output.context.length).toBeGreaterThan(0);
    expect(output.context[0]).toContain('Memory - Session Context');

    // No Viking calls at all
    expect(vikingCalls().length).toBe(0);

    // Memory calls should have happened
    expect(memoryCalls().length).toBeGreaterThan(0);

    // No Viking context block
    const vikingBlock = output.context.find((c) => c.includes('Viking Knowledge Context'));
    expect(vikingBlock).toBeUndefined();

    await hooks['session.deleted']({ session: { id: 'sess-no-viking' } });

    // Still no Viking calls after full lifecycle
    expect(vikingCalls().length).toBe(0);
  });

  it('Viking enabled: session create called, abstracts fetched, context injected', async () => {
    setupVikingEnv();
    const hooks = await createPlugin();

    const output: { context: string[] } = { context: [] };
    await hooks['session.created'](
      { session: { id: 'sess-viking-1' }, project: { name: 'test-proj' }, agent: { name: 'assistant' } },
      output,
    );

    // Memory context should still be injected
    expect(output.context[0]).toContain('Memory - Session Context');

    // Viking session creation call
    const sessionCreateCalls = vikingCalls().filter(
      (c) => c.url.includes('/sessions') && c.method === 'POST' && !c.url.includes('/messages') && !c.url.includes('/commit'),
    );
    expect(sessionCreateCalls.length).toBe(1);

    // Viking abstract calls (memories + resources)
    const abstractCalls = vikingCalls().filter((c) => c.url.includes('/content/abstract'));
    expect(abstractCalls.length).toBe(2);

    // Viking context block injected
    const vikingBlock = output.context.find((c) => c.includes('Viking Knowledge Context'));
    expect(vikingBlock).toBeDefined();
    expect(vikingBlock).toContain('Viking Agent Memories');
    expect(vikingBlock).toContain('Viking Resources');

    await hooks['session.deleted']({ session: { id: 'sess-viking-1' } });
  });

  it('Viking enabled: tool.execute.after logs to Viking session', async () => {
    setupVikingEnv();
    const hooks = await createPlugin();

    const output: { context: string[] } = { context: [] };
    await hooks['session.created'](
      { session: { id: 'sess-viking-tool' }, project: { name: 'test-proj' }, agent: { name: 'assistant' } },
      output,
    );

    // Execute a tool
    await hooks['tool.execute.after'](
      { session: { id: 'sess-viking-tool' }, tool: { name: 'bash' }, args: { command: 'ls' } },
      { result: { ok: true } },
    );

    // Give fire-and-forget promise a tick to settle
    await new Promise((r) => setTimeout(r, 10));

    // Viking message call should have been made
    const messageCalls = vikingCalls().filter(
      (c) => c.url.includes('/messages') && c.method === 'POST',
    );
    expect(messageCalls.length).toBe(1);
    expect(messageCalls[0].body).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('Tool bash succeeded'),
      }),
    );

    await hooks['session.deleted']({ session: { id: 'sess-viking-tool' } });
  });

  it('Viking enabled: session.deleted commits Viking session', async () => {
    setupVikingEnv();
    const hooks = await createPlugin();

    const output: { context: string[] } = { context: [] };
    await hooks['session.created'](
      { session: { id: 'sess-viking-commit' }, project: { name: 'test-proj' }, agent: { name: 'assistant' } },
      output,
    );

    await hooks['session.idle']({ session: { id: 'sess-viking-commit' } });
    await hooks['session.idle']({ session: { id: 'sess-viking-commit' } });
    await hooks['session.deleted']({ session: { id: 'sess-viking-commit' } });

    // Viking commit call
    const commitCalls = vikingCalls().filter(
      (c) => c.url.includes('/commit') && c.method === 'POST',
    );
    expect(commitCalls.length).toBe(1);
    expect(commitCalls[0].url).toContain('/sessions/viking-sess-42/commit');
  });

  it('two sessions each commit exactly once', async () => {
    setupVikingEnv();
    const hooks = await createPlugin();

    const output: { context: string[] } = { context: [] };
    await hooks['session.created'](
      { session: { id: 'sess-viking-idem' }, project: { name: 'test-proj' }, agent: { name: 'assistant' } },
      output,
    );

    // Delete the session (commits Viking)
    await hooks['session.deleted']({ session: { id: 'sess-viking-idem' } });

    const commitCallsBefore = vikingCalls().filter(
      (c) => c.url.includes('/commit') && c.method === 'POST',
    );
    expect(commitCallsBefore.length).toBe(1);

    // Create a new session with same ID to verify the guard
    // The old session is deleted from the map, so a new one starts fresh
    // This test validates that the committed flag prevents double-commit within a session
    // We simulate by creating another session and checking only one commit per lifecycle
    const output2: { context: string[] } = { context: [] };
    await hooks['session.created'](
      { session: { id: 'sess-viking-idem-2' }, project: { name: 'test-proj' }, agent: { name: 'assistant' } },
      output2,
    );
    await hooks['session.deleted']({ session: { id: 'sess-viking-idem-2' } });

    const allCommitCalls = vikingCalls().filter(
      (c) => c.url.includes('/commit') && c.method === 'POST',
    );
    // Each session should commit exactly once
    expect(allCommitCalls.length).toBe(2);
  });

  it('Viking initialization failure: falls back to memory-only mode gracefully', async () => {
    setupVikingEnv();

    // Override fetch to throw for Viking URLs
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const rawBody = typeof init?.body === 'string' ? init.body : null;
      const body = rawBody ? JSON.parse(rawBody) : null;
      calls.push({ url, method, body });

      // Viking calls throw
      if (url.includes('viking:9090')) {
        throw new Error('Viking connection refused');
      }

      // Memory API mocks (same as standard)
      if (url.includes('/api/v1/stats/')) {
        return jsonResponse({ total_memories: 12, total_apps: 3 });
      }
      if (url.endsWith('/api/v2/memories/search') && method === 'POST') {
        const query = typeof body?.query === 'string' ? body.query : '';
        if (query.startsWith('Session ')) return jsonResponse({ items: [] });
        memoryIdCounter++;
        const category = typeof body?.filters?.category === 'string' ? body.filters.category : 'semantic';
        return jsonResponse({
          items: [
            { id: `mem-${memoryIdCounter}`, content: `${query || 'memory'} guidance`, metadata: { category, confidence: 0.9 } },
          ],
        });
      }
      if (url.endsWith('/api/v1/memories/filter') && method === 'POST') return jsonResponse({ items: [] });
      if (url.endsWith('/api/v1/memories/') && method === 'POST') return jsonResponse({ id: `stored-${memoryIdCounter++}` });
      if (url.includes('/feedback') && method === 'POST') return jsonResponse({ ok: true });
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const hooks = await createPlugin();
    const output: { context: string[] } = { context: [] };

    // Should not throw despite Viking failure
    await hooks['session.created'](
      { session: { id: 'sess-viking-fail' }, project: { name: 'test-proj' }, agent: { name: 'assistant' } },
      output,
    );

    // Memory context should still be injected
    expect(output.context.length).toBeGreaterThan(0);
    expect(output.context[0]).toContain('Memory - Session Context');

    // No Viking context block since it failed
    const vikingBlock = output.context.find((c) => c.includes('Viking Knowledge Context'));
    expect(vikingBlock).toBeUndefined();

    // Viking session commit should be skipped since vikingAvailable was set to false
    await hooks['session.deleted']({ session: { id: 'sess-viking-fail' } });

    const commitCalls = vikingCalls().filter(
      (c) => c.url.includes('/commit') && c.method === 'POST',
    );
    expect(commitCalls.length).toBe(0);
  });

  it('Viking enabled: shell.env includes OPENVIKING_URL', async () => {
    setupVikingEnv();
    const hooks = await createPlugin();

    const envOutput: { env: Record<string, string> } = { env: {} };
    await hooks['shell.env']({}, envOutput);

    expect(envOutput.env.OPENVIKING_URL).toBe('http://viking:9090');
    expect(envOutput.env.MEMORY_API_URL).toBeDefined();
    expect(envOutput.env.OPENVIKING_API_KEY).toBeUndefined();
  });

  it('Viking disabled: shell.env does not include OPENVIKING_URL', async () => {
    clearVikingEnv();
    const hooks = await createPlugin();

    const envOutput: { env: Record<string, string> } = { env: {} };
    await hooks['shell.env']({}, envOutput);

    expect(envOutput.env.OPENVIKING_URL).toBeUndefined();
    expect(envOutput.env.MEMORY_API_URL).toBeDefined();
  });

  it('Viking enabled: compaction includes Viking overview', async () => {
    setupVikingEnv();
    const hooks = await createPlugin();

    const createOutput: { context: string[] } = { context: [] };
    await hooks['session.created'](
      { session: { id: 'sess-viking-compact' }, project: { name: 'test-proj' }, agent: { name: 'assistant' } },
      createOutput,
    );

    const compactOutput: { context: string[] } = { context: [] };
    await hooks['experimental.session.compacting'](
      { session: { id: 'sess-viking-compact' } },
      compactOutput,
    );

    expect(compactOutput.context.length).toBe(1);
    const compactedBlock = compactOutput.context[0];
    expect(compactedBlock).toContain('Memory Context (Compaction)');
    expect(compactedBlock).toContain('Viking Knowledge Overview');
    expect(compactedBlock).toContain('Viking knowledge overview content');

    await hooks['session.deleted']({ session: { id: 'sess-viking-compact' } });
  });

  it('partial failure: session creation fails but abstracts succeed — no commit, memory context works', async () => {
    setupVikingEnv();

    // Override fetch: Viking session creation returns error, abstracts succeed
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const rawBody = typeof init?.body === 'string' ? init.body : null;
      const body = rawBody ? JSON.parse(rawBody) : null;
      calls.push({ url, method, body });

      // Viking session creation → error
      if (url.includes('/api/v1/sessions') && method === 'POST' && !url.includes('/messages') && !url.includes('/commit')) {
        return jsonResponse({ error: true, message: 'session creation failed' });
      }
      // Viking abstracts → success
      if (url.includes('/api/v1/content/abstract')) {
        if (url.includes('memories')) return jsonResponse({ result: 'Agent memory abstract' });
        if (url.includes('resources')) return jsonResponse({ result: 'Resources abstract' });
      }
      // Viking commit → success (should never be reached)
      if (url.includes('/commit') && method === 'POST') {
        return jsonResponse({ ok: true });
      }
      // Memory API mocks
      if (url.includes('/api/v1/stats/')) return jsonResponse({ total_memories: 12, total_apps: 3 });
      if (url.endsWith('/api/v2/memories/search') && method === 'POST') {
        const query = typeof body?.query === 'string' ? body.query : '';
        if (query.startsWith('Session ')) return jsonResponse({ items: [] });
        memoryIdCounter++;
        const category = typeof body?.filters?.category === 'string' ? body.filters.category : 'semantic';
        return jsonResponse({
          items: [{ id: `mem-${memoryIdCounter}`, content: `${query} guidance`, metadata: { category, confidence: 0.9 } }],
        });
      }
      if (url.endsWith('/api/v1/memories/filter') && method === 'POST') return jsonResponse({ items: [] });
      if (url.endsWith('/api/v1/memories/') && method === 'POST') return jsonResponse({ id: `stored-${memoryIdCounter++}` });
      if (url.includes('/feedback') && method === 'POST') return jsonResponse({ ok: true });
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const hooks = await createPlugin();
    const output: { context: string[] } = { context: [] };

    await hooks['session.created'](
      { session: { id: 'sess-partial-no-session' }, project: { name: 'test-proj' }, agent: { name: 'assistant' } },
      output,
    );

    // Memory context should still be injected
    expect(output.context[0]).toContain('Memory - Session Context');

    // Viking context block should still appear (abstracts succeeded)
    const vikingBlock = output.context.find((c) => c.includes('Viking Knowledge Context'));
    expect(vikingBlock).toBeDefined();

    // session.deleted should NOT commit (vikingAvailable set to false because no session ID)
    await hooks['session.deleted']({ session: { id: 'sess-partial-no-session' } });

    const commitCalls = vikingCalls().filter(
      (c) => c.url.includes('/commit') && c.method === 'POST',
    );
    expect(commitCalls.length).toBe(0);
  });

  it('partial failure: session creation succeeds but abstracts fail — no Viking context, commit still fires', async () => {
    setupVikingEnv();

    // Override fetch: Viking session creation succeeds, abstracts return errors
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const rawBody = typeof init?.body === 'string' ? init.body : null;
      const body = rawBody ? JSON.parse(rawBody) : null;
      calls.push({ url, method, body });

      // Viking session creation → success
      if (url.includes('/api/v1/sessions') && method === 'POST' && !url.includes('/messages') && !url.includes('/commit')) {
        return jsonResponse({ result: { session_id: 'viking-sess-partial' } });
      }
      // Viking abstracts → error
      if (url.includes('/api/v1/content/abstract')) {
        return jsonResponse({ error: true, message: 'abstract unavailable' });
      }
      // Viking commit → success
      if (url.includes('/commit') && method === 'POST') {
        return jsonResponse({ ok: true });
      }
      // Memory API mocks
      if (url.includes('/api/v1/stats/')) return jsonResponse({ total_memories: 12, total_apps: 3 });
      if (url.endsWith('/api/v2/memories/search') && method === 'POST') {
        const query = typeof body?.query === 'string' ? body.query : '';
        if (query.startsWith('Session ')) return jsonResponse({ items: [] });
        memoryIdCounter++;
        const category = typeof body?.filters?.category === 'string' ? body.filters.category : 'semantic';
        return jsonResponse({
          items: [{ id: `mem-${memoryIdCounter}`, content: `${query} guidance`, metadata: { category, confidence: 0.9 } }],
        });
      }
      if (url.endsWith('/api/v1/memories/filter') && method === 'POST') return jsonResponse({ items: [] });
      if (url.endsWith('/api/v1/memories/') && method === 'POST') return jsonResponse({ id: `stored-${memoryIdCounter++}` });
      if (url.includes('/feedback') && method === 'POST') return jsonResponse({ ok: true });
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const hooks = await createPlugin();
    const output: { context: string[] } = { context: [] };

    await hooks['session.created'](
      { session: { id: 'sess-partial-no-abstract' }, project: { name: 'test-proj' }, agent: { name: 'assistant' } },
      output,
    );

    // Memory context should still be injected
    expect(output.context[0]).toContain('Memory - Session Context');

    // Viking context block should NOT appear (abstracts failed, no content)
    const vikingBlock = output.context.find((c) => c.includes('Viking Knowledge Context'));
    expect(vikingBlock).toBeUndefined();

    // session.deleted should still commit (session ID is valid)
    await hooks['session.deleted']({ session: { id: 'sess-partial-no-abstract' } });

    const commitCalls = vikingCalls().filter(
      (c) => c.url.includes('/commit') && c.method === 'POST',
    );
    expect(commitCalls.length).toBe(1);
    expect(commitCalls[0].url).toContain('/sessions/viking-sess-partial/commit');
  });
});
