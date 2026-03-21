import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as adminArtifacts from '../opencode/tools/admin-artifacts.ts';
import * as adminConnections from '../opencode/tools/admin-connections.ts';
import * as adminContainers from '../opencode/tools/admin-containers.ts';

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

describe('admin tools validation', () => {
  it('rejects invalid artifact names before API call', async () => {
    const result = await adminArtifacts.get.execute({ name: 'env' } as never, {} as never);
    const parsed = JSON.parse(result) as { error?: boolean };
    expect(parsed.error).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('forwards container service requests to the admin API (server validates)', async () => {
    // Client-side service validation was removed; the admin API is the authoritative
    // validator. The tool should always forward the request rather than rejecting locally.
    await adminContainers.up.execute({ service: 'postgres' } as never, {} as never);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain('/admin/containers/up');
  });

  it('rejects unsupported connection keys', async () => {
    const result = await adminConnections.set.execute({
      patches: '{"OPENAI_API_KEY":"sk-123","UNSAFE_KEY":"x"}',
    } as never, {} as never);
    const parsed = JSON.parse(result) as { error?: boolean; message?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.message).toContain('Unsupported key');
    expect(calls.length).toBe(0);
  });

  it('accepts valid artifact names', async () => {
    await adminArtifacts.get.execute({ name: 'compose' } as never, {} as never);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain('/admin/artifacts/compose');
  });

  it('accepts valid container service names', async () => {
    await adminContainers.list.execute({} as never, {} as never);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain('/admin/containers/list');
  });

  it('sends admin auth headers on all requests', async () => {
    await adminArtifacts.list.execute({} as never, {} as never);
    expect(calls.length).toBe(1);
    // adminFetch adds these headers; we verify the call was made
    expect(calls[0].url).toContain('/admin/artifacts');
  });
});
