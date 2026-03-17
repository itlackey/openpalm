import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import memoryAdd from '../opencode/tools/memory-add.ts';
import memoryList from '../opencode/tools/memory-list.ts';

type FetchCall = {
  url: string;
  method: string;
  body: string | null;
};

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, method, body });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('assistant tools validation', () => {
  it('rejects non-object memory metadata', async () => {
    const result = await memoryAdd.execute({
      text: 'User prefers Bun',
      metadata: '[]',
    } as never, {} as never);
    const parsed = JSON.parse(result) as { error?: boolean };
    expect(parsed.error).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('normalizes memory-list pagination and sort options', async () => {
    await memoryList.execute({
      page: -2,
      size: 999,
      sort_column: 'invalid',
      sort_direction: 'invalid',
    } as never, {} as never);

    const last = calls[calls.length - 1];
    expect(last.url).toContain('/api/v1/memories/filter');
    const body = JSON.parse(last.body ?? '{}') as {
      page: number;
      size: number;
      sort_column: string;
      sort_direction: string;
    };
    expect(body.page).toBe(1);
    expect(body.size).toBe(100);
    expect(body.sort_column).toBe('created_at');
    expect(body.sort_direction).toBe('desc');
  });
});
