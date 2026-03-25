import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { isVikingConfigured, vikingFetch, vikingResponseHasError } from './tools/viking-lib.ts';
import vikingSearch from './tools/viking-search.ts';
import vikingGrep from './tools/viking-grep.ts';
import vikingBrowse from './tools/viking-browse.ts';
import vikingRead from './tools/viking-read.ts';
import vikingAddResource from './tools/viking-add-resource.ts';
import vikingOverview from './tools/viking-overview.ts';

type FetchCall = {
  url: string;
  method: string;
  body: string | null;
  headers: Record<string, string>;
};

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let mockStatus = 200;
let mockBody = JSON.stringify({ ok: true });

beforeEach(() => {
  calls = [];
  mockStatus = 200;
  mockBody = JSON.stringify({ ok: true });
  process.env.OPENVIKING_URL = 'http://viking:9090';
  process.env.OPENVIKING_API_KEY = 'test-key-123';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : null;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) {
        headers[k] = v;
      }
    }
    calls.push({ url, method, body, headers });
    return new Response(mockBody, {
      status: mockStatus,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OPENVIKING_URL;
  delete process.env.OPENVIKING_API_KEY;
});

// ---------------------------------------------------------------------------
// isVikingConfigured
// ---------------------------------------------------------------------------
describe('isVikingConfigured', () => {
  it('returns true when both env vars are set', () => {
    expect(isVikingConfigured()).toBe(true);
  });

  it('returns false when OPENVIKING_URL is missing', () => {
    delete process.env.OPENVIKING_URL;
    expect(isVikingConfigured()).toBe(false);
  });

  it('returns false when OPENVIKING_API_KEY is missing', () => {
    delete process.env.OPENVIKING_API_KEY;
    expect(isVikingConfigured()).toBe(false);
  });

  it('returns false when both env vars are missing', () => {
    delete process.env.OPENVIKING_URL;
    delete process.env.OPENVIKING_API_KEY;
    expect(isVikingConfigured()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// vikingFetch
// ---------------------------------------------------------------------------
describe('vikingFetch', () => {
  it('returns disabled error when Viking is not configured', async () => {
    delete process.env.OPENVIKING_URL;
    delete process.env.OPENVIKING_API_KEY;
    const result = await vikingFetch('/search/find');
    const parsed = JSON.parse(result) as { error?: boolean; message?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.message).toBe('OpenViking is not configured');
    expect(calls.length).toBe(0);
  });

  it('sends correct URL with /api/v1 prefix when configured', async () => {
    await vikingFetch('/search/find');
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('http://viking:9090/api/v1/search/find');
  });

  it('sends x-api-key header with correct value', async () => {
    await vikingFetch('/search/find');
    expect(calls[0].headers['x-api-key']).toBe('test-key-123');
  });

  it('x-api-key cannot be overridden by caller headers', async () => {
    await vikingFetch('/search/find', {
      headers: { 'x-api-key': 'evil-key' },
    });
    expect(calls[0].headers['x-api-key']).toBe('test-key-123');
  });

  it('handles non-2xx responses correctly', async () => {
    mockStatus = 500;
    mockBody = 'Internal Server Error';
    const result = await vikingFetch('/search/find');
    const parsed = JSON.parse(result) as { error?: boolean; status?: number; body?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.status).toBe(500);
    expect(parsed.body).toBe('Internal Server Error');
  });

  it('handles network errors', async () => {
    globalThis.fetch = (() => {
      throw new Error('Connection refused');
    }) as typeof fetch;
    const result = await vikingFetch('/test');
    const parsed = JSON.parse(result) as { error?: boolean; message?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.message).toBe('Connection refused');
  });
});

// ---------------------------------------------------------------------------
// vikingResponseHasError
// ---------------------------------------------------------------------------
describe('vikingResponseHasError', () => {
  it('detects error responses', () => {
    expect(vikingResponseHasError(JSON.stringify({ error: true, message: 'fail' }))).toBe(true);
  });

  it('returns false for successful responses', () => {
    expect(vikingResponseHasError(JSON.stringify({ results: [] }))).toBe(false);
  });

  it('returns false for non-JSON strings', () => {
    expect(vikingResponseHasError('not json')).toBe(false);
  });

  it('returns false when error is not true', () => {
    expect(vikingResponseHasError(JSON.stringify({ error: false }))).toBe(false);
    expect(vikingResponseHasError(JSON.stringify({ error: 'yes' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// viking-search
// ---------------------------------------------------------------------------
describe('viking-search', () => {
  it('sends correct POST body with query', async () => {
    await vikingSearch.execute({ query: 'find docs' } as never, {} as never);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('http://viking:9090/api/v1/search/find');
    expect(calls[0].method).toBe('POST');
    const body = JSON.parse(calls[0].body!) as Record<string, unknown>;
    expect(body.query).toBe('find docs');
  });

  it('includes target_uri, limit, and score_threshold when provided', async () => {
    await vikingSearch.execute(
      { query: 'test', target_uri: 'viking://resources', limit: '5', score_threshold: '0.8' } as never,
      {} as never,
    );
    const body = JSON.parse(calls[0].body!) as Record<string, unknown>;
    expect(body.target_uri).toBe('viking://resources');
    expect(body.limit).toBe(5);
    expect(body.score_threshold).toBe(0.8);
  });

  it('rejects score_threshold outside 0-1 range', async () => {
    await vikingSearch.execute(
      { query: 'test', score_threshold: '1.5' } as never,
      {} as never,
    );
    const body = JSON.parse(calls[0].body!) as Record<string, unknown>;
    expect(body.score_threshold).toBeUndefined();
  });

  it('rejects negative score_threshold', async () => {
    await vikingSearch.execute(
      { query: 'test', score_threshold: '-0.1' } as never,
      {} as never,
    );
    const body = JSON.parse(calls[0].body!) as Record<string, unknown>;
    expect(body.score_threshold).toBeUndefined();
  });

  it('rejects target_uri without viking:// prefix', async () => {
    const result = await vikingSearch.execute(
      { query: 'test', target_uri: 'http://evil.com' } as never,
      {} as never,
    );
    const parsed = JSON.parse(result) as { error?: boolean; message?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.message).toContain("viking://");
    expect(calls.length).toBe(0);
  });

  it('returns disabled error when not configured', async () => {
    delete process.env.OPENVIKING_URL;
    delete process.env.OPENVIKING_API_KEY;
    const result = await vikingSearch.execute({ query: 'test' } as never, {} as never);
    const parsed = JSON.parse(result) as { error?: boolean; message?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.message).toBe('OpenViking is not configured');
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// viking-grep
// ---------------------------------------------------------------------------
describe('viking-grep', () => {
  it('sends correct POST body with pattern', async () => {
    await vikingGrep.execute(
      { uri: 'viking://resources', pattern: 'TODO' } as never,
      {} as never,
    );
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('http://viking:9090/api/v1/search/grep');
    expect(calls[0].method).toBe('POST');
    const body = JSON.parse(calls[0].body!) as Record<string, unknown>;
    expect(body.uri).toBe('viking://resources');
    expect(body.pattern).toBe('TODO');
  });

  it('handles case_insensitive flag (case-insensitive comparison)', async () => {
    await vikingGrep.execute(
      { uri: 'viking://resources', pattern: 'test', case_insensitive: 'True' } as never,
      {} as never,
    );
    const body = JSON.parse(calls[0].body!) as Record<string, unknown>;
    expect(body.case_insensitive).toBe(true);
  });

  it('handles case_insensitive "TRUE" (all caps)', async () => {
    await vikingGrep.execute(
      { uri: 'viking://resources', pattern: 'test', case_insensitive: 'TRUE' } as never,
      {} as never,
    );
    const body = JSON.parse(calls[0].body!) as Record<string, unknown>;
    expect(body.case_insensitive).toBe(true);
  });

  it('rejects URI without viking:// prefix', async () => {
    const result = await vikingGrep.execute(
      { uri: '/etc/passwd', pattern: 'root' } as never,
      {} as never,
    );
    const parsed = JSON.parse(result) as { error?: boolean; message?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.message).toContain("viking://");
    expect(calls.length).toBe(0);
  });

  it('returns disabled error when not configured', async () => {
    delete process.env.OPENVIKING_URL;
    delete process.env.OPENVIKING_API_KEY;
    const result = await vikingGrep.execute(
      { uri: 'viking://resources', pattern: 'test' } as never,
      {} as never,
    );
    const parsed = JSON.parse(result) as { error?: boolean; message?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.message).toBe('OpenViking is not configured');
  });
});

// ---------------------------------------------------------------------------
// viking-browse
// ---------------------------------------------------------------------------
describe('viking-browse', () => {
  it('constructs correct GET URL with encoded URI', async () => {
    await vikingBrowse.execute({ uri: 'viking://resources/my docs' } as never, {} as never);
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/api/v1/fs/ls?');
    expect(calls[0].url).toContain('uri=viking');
  });

  it('rejects URI without viking:// prefix', async () => {
    const result = await vikingBrowse.execute({ uri: 'http://evil.com' } as never, {} as never);
    const parsed = JSON.parse(result) as { error?: boolean; message?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.message).toContain("viking://");
    expect(calls.length).toBe(0);
  });

  it('returns disabled error when not configured', async () => {
    delete process.env.OPENVIKING_URL;
    delete process.env.OPENVIKING_API_KEY;
    const result = await vikingBrowse.execute({ uri: 'viking://resources' } as never, {} as never);
    const parsed = JSON.parse(result) as { error?: boolean; message?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.message).toBe('OpenViking is not configured');
  });
});

// ---------------------------------------------------------------------------
// viking-read
// ---------------------------------------------------------------------------
describe('viking-read', () => {
  it('constructs correct GET URL', async () => {
    await vikingRead.execute({ uri: 'viking://resources/doc.md' } as never, {} as never);
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/api/v1/content/read?');
    expect(calls[0].url).toContain('uri=viking');
  });

  it('rejects URI without viking:// prefix', async () => {
    const result = await vikingRead.execute({ uri: 'file:///etc/passwd' } as never, {} as never);
    const parsed = JSON.parse(result) as { error?: boolean; message?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.message).toContain("viking://");
    expect(calls.length).toBe(0);
  });

  it('returns disabled error when not configured', async () => {
    delete process.env.OPENVIKING_URL;
    delete process.env.OPENVIKING_API_KEY;
    const result = await vikingRead.execute({ uri: 'viking://resources/doc.md' } as never, {} as never);
    const parsed = JSON.parse(result) as { error?: boolean; message?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.message).toBe('OpenViking is not configured');
  });
});

// ---------------------------------------------------------------------------
// viking-overview
// ---------------------------------------------------------------------------
describe('viking-overview', () => {
  it('constructs correct GET URL', async () => {
    await vikingOverview.execute({ uri: 'viking://resources/doc.md' } as never, {} as never);
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/api/v1/content/overview?');
    expect(calls[0].url).toContain('uri=viking');
  });

  it('rejects URI without viking:// prefix', async () => {
    const result = await vikingOverview.execute({ uri: 'https://evil.com' } as never, {} as never);
    const parsed = JSON.parse(result) as { error?: boolean; message?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.message).toContain("viking://");
    expect(calls.length).toBe(0);
  });

  it('returns disabled error when not configured', async () => {
    delete process.env.OPENVIKING_URL;
    delete process.env.OPENVIKING_API_KEY;
    const result = await vikingOverview.execute({ uri: 'viking://resources/doc.md' } as never, {} as never);
    const parsed = JSON.parse(result) as { error?: boolean; message?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.message).toBe('OpenViking is not configured');
  });
});

// ---------------------------------------------------------------------------
// viking-add-resource
// ---------------------------------------------------------------------------
describe('viking-add-resource', () => {
  it('sends correct POST body with wait:true', async () => {
    await vikingAddResource.execute(
      { content: 'hello world', destination: 'viking://resources/docs' } as never,
      {} as never,
    );
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('http://viking:9090/api/v1/resources');
    expect(calls[0].method).toBe('POST');
    const body = JSON.parse(calls[0].body!) as Record<string, unknown>;
    expect(body.content).toBe('hello world');
    expect(body.destination).toBe('viking://resources/docs');
    expect(body.wait).toBe(true);
  });

  it('includes reason when provided', async () => {
    await vikingAddResource.execute(
      { content: 'data', destination: 'viking://resources/docs', reason: 'for later' } as never,
      {} as never,
    );
    const body = JSON.parse(calls[0].body!) as Record<string, unknown>;
    expect(body.reason).toBe('for later');
  });

  it('rejects destination without viking:// prefix', async () => {
    const result = await vikingAddResource.execute(
      { content: 'data', destination: '/tmp/evil' } as never,
      {} as never,
    );
    const parsed = JSON.parse(result) as { error?: boolean; message?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.message).toContain("viking://");
    expect(calls.length).toBe(0);
  });

  it('returns disabled error when not configured', async () => {
    delete process.env.OPENVIKING_URL;
    delete process.env.OPENVIKING_API_KEY;
    const result = await vikingAddResource.execute(
      { content: 'hello', destination: 'viking://resources/docs' } as never,
      {} as never,
    );
    const parsed = JSON.parse(result) as { error?: boolean; message?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.message).toBe('OpenViking is not configured');
  });
});
