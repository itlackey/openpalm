/**
 * Regression test for the 0.12.0 "Discord portal stopped working" bug.
 *
 * The @opencode-ai/sdk client (1.17.x) resolves every session.* call to a
 * { data, error } envelope. The adapter used to read the session object off the
 * envelope directly, so `createSession().id` was `undefined`; the subsequent
 * `prompt({ path: { id: undefined } })` left the path template un-substituted and
 * sent the LITERAL `/session/{id}/message`. The guardian denied it with
 * `no_route` (403), so every Discord message silently failed.
 *
 * This test drives the REAL SDK through a fake transport (the `fetch` the adapter
 * accepts) and asserts the prompt request carries the actual session id — i.e.
 * the path is `/session/<real-id>/message`, never the literal `{id}` / `%7Bid%7D`.
 */
import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import { OcClient } from './opencode.ts';

const REAL_SESSION_ID = 'ses_real_abc123';

/** A fake transport standing in for guardian → OpenCode. Records every request
 *  URL and answers session.create / session.prompt with realistic envelopes. */
function makeFakeTransport() {
  const urls: string[] = [];
  const fetchFn = (async (input: Request | string | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    if (/\/session$/.test(new URL(url).pathname) || /\/session$/.test(url)) {
      // POST /session → the created session lives in the JSON body.
      return new Response(JSON.stringify({ id: REAL_SESSION_ID, title: 'chat' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // POST /session/<id>/message → accept and echo an empty assistant message.
    return new Response(JSON.stringify({ info: {}, parts: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { urls, fetchFn };
}

describe('OcClient — SDK envelope handling', () => {
  it('createSession returns the real session id from the { data } envelope', async () => {
    const { fetchFn } = makeFakeTransport();
    const client = new OcClient({ principalId: 'discord', secret: 's', baseUrl: 'http://guardian:8080/oc', fetch: fetchFn });

    const session = await client.createSession('discord:123');
    // Pre-fix this was `undefined` (read off the envelope instead of `.data`).
    expect(session.id).toBe(REAL_SESSION_ID);
  });

  it('prompt substitutes the session id into the path (never the literal {id})', async () => {
    const { urls, fetchFn } = makeFakeTransport();
    const client = new OcClient({ principalId: 'discord', secret: 's', baseUrl: 'http://guardian:8080/oc', fetch: fetchFn });

    const session = await client.createSession('discord:123');
    await client.prompt('discord:123', session.id, 'hello');

    const promptUrl = urls.find((u) => u.includes('/message'));
    expect(promptUrl, 'a /message request must have been made').toBeDefined();
    // The exact prod failure: the un-substituted template reaching the guardian.
    expect(promptUrl).not.toContain('%7Bid%7D');
    expect(promptUrl).not.toContain('{id}');
    expect(promptUrl).toContain(`/session/${REAL_SESSION_ID}/message`);
  });

  it('createSession throws when the SDK returns an error envelope', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ message: 'denied' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const client = new OcClient({ principalId: 'discord', secret: 's', baseUrl: 'http://guardian:8080/oc', fetch: fetchFn });

    await expect(client.createSession('discord:123')).rejects.toThrow(/createSession failed/);
  });
});

/**
 * #491 — OPENCODE_BASE_URL env fallback (D1) and client-side session reuse (D2).
 *
 * Env hygiene mirrors packages/portal-slack/src/index.test.ts:95-97: save/delete/restore
 * so these tests never leak state into others in the same file/run.
 */
const RESET_ENV_KEYS = ['OPENCODE_BASE_URL', 'PORTAL_SESSION_REUSE', 'PORTAL_SESSION_TTL_MS'] as const;
let savedEnv: Partial<Record<(typeof RESET_ENV_KEYS)[number], string>> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of RESET_ENV_KEYS) {
    savedEnv[key] = Bun.env[key];
    delete Bun.env[key];
  }
});

afterEach(() => {
  for (const key of RESET_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete Bun.env[key];
    else Bun.env[key] = savedEnv[key];
  }
});

describe('OcClient — OPENCODE_BASE_URL env fallback (#491)', () => {
  // Characterization pin: this behavior already exists in opencode.ts:30 and is
  // ALLOWED TO PASS at red stage — D1's fix (removing BasePortal's hardcoded
  // baseUrl override) depends on this fallback already working correctly.
  // Every OTHER test in this file must be red before implementation.
  it('constructor falls back to Bun.env.OPENCODE_BASE_URL when baseUrl is not passed', async () => {
    Bun.env.OPENCODE_BASE_URL = 'http://oc.example:4096';
    const urls: string[] = [];
    const fetchFn = (async (input: Request | string | URL): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      return new Response(JSON.stringify({ id: 's1', title: 'chat' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new OcClient({ principalId: 'p', secret: 's', fetch: fetchFn });
    await client.createSession('u1');

    expect(urls[0]).toStartWith('http://oc.example:4096/session');
  });
});

/** A fake transport simulating a plain OpenCode server that ignores the
 * `x-openpalm-session-key` hint header and mints a FRESH session id
 * (`s1`, `s2`, …) on every `POST /session`. Records each create's URL and
 * headers, and can be told to fail a subsequent `/session/<id>/message`. */
function makeReuseTransport() {
  const creates: Array<{ url: string; headers: Record<string, string> }> = [];
  const failingSessionIds = new Set<string>();
  let counter = 0;

  const fetchFn = (async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const headerSource = input instanceof Request ? input.headers : new Headers(init?.headers);
    const headers: Record<string, string> = {};
    headerSource.forEach((value, key) => {
      headers[key] = value;
    });
    const pathname = new URL(url).pathname;

    if (/\/session$/.test(pathname)) {
      counter += 1;
      const id = `s${counter}`;
      creates.push({ url, headers });
      return new Response(JSON.stringify({ id, title: 'chat' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const messageMatch = pathname.match(/\/session\/([^/]+)\/message$/);
    if (messageMatch) {
      const sessionId = messageMatch[1] as string;
      if (failingSessionIds.has(sessionId)) {
        return new Response(JSON.stringify({ message: 'session not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ info: {}, parts: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  return {
    fetchFn,
    creates,
    get createCount() {
      return creates.length;
    },
    failNextMessageFor: (sessionId: string) => failingSessionIds.add(sessionId),
  };
}

describe('client-side session reuse (S4, #581 finding #6: client is now the default)', () => {
  it('reuses one sessionId across createSession calls with the same (userId, sessionKey)', async () => {
    Bun.env.PORTAL_SESSION_REUSE = 'client';
    const transport = makeReuseTransport();
    const client = new OcClient({ principalId: 'p', secret: 's', baseUrl: 'http://oc.example', fetch: transport.fetchFn });

    const first = await client.createSession('u1', 'thread-a');
    const second = await client.createSession('u1', 'thread-a');

    expect(first.id).toBe('s1');
    expect(second.id).toBe('s1');
    expect(transport.createCount).toBe(1);
  });

  it('distinct sessionKeys under one user create distinct sessions', async () => {
    Bun.env.PORTAL_SESSION_REUSE = 'client';
    const transport = makeReuseTransport();
    const client = new OcClient({ principalId: 'p', secret: 's', baseUrl: 'http://oc.example', fetch: transport.fetchFn });

    const a = await client.createSession('u1', 'a');
    const b = await client.createSession('u1', 'b');

    expect(transport.createCount).toBe(2);
    expect(a.id).not.toBe(b.id);
  });

  it('distinct userIds sharing a sessionKey do not collide', async () => {
    Bun.env.PORTAL_SESSION_REUSE = 'client';
    const transport = makeReuseTransport();
    const client = new OcClient({ principalId: 'p', secret: 's', baseUrl: 'http://oc.example', fetch: transport.fetchFn });

    const a = await client.createSession('u1', 'shared');
    const b = await client.createSession('u2', 'shared');

    expect(transport.createCount).toBe(2);
    expect(a.id).not.toBe(b.id);
  });

  it('still sends the x-openpalm-session-key guardian hint on the create it performs', async () => {
    Bun.env.PORTAL_SESSION_REUSE = 'client';
    const transport = makeReuseTransport();
    const client = new OcClient({ principalId: 'p', secret: 's', baseUrl: 'http://oc.example', fetch: transport.fetchFn });

    await client.createSession('u1', 'thread-a');

    expect(transport.creates[0]?.headers['x-openpalm-session-key']).toBe('thread-a');
  });

  it('a failed prompt evicts the cached session so the next createSession re-creates', async () => {
    Bun.env.PORTAL_SESSION_REUSE = 'client';
    const transport = makeReuseTransport();
    const client = new OcClient({ principalId: 'p', secret: 's', baseUrl: 'http://oc.example', fetch: transport.fetchFn });

    const first = await client.createSession('u1', 'thread-a');
    expect(first.id).toBe('s1');
    transport.failNextMessageFor('s1');

    await expect(client.prompt('u1', first.id, 'hello')).rejects.toThrow(/prompt failed/);

    const second = await client.createSession('u1', 'thread-a');
    expect(second.id).toBe('s2');
    expect(transport.createCount).toBe(2);
  });

  it('server mode (opt-in via PORTAL_SESSION_REUSE=server) posts /session on every createSession call', async () => {
    // S4 (#581 finding #6): 'server' used to be the silent default, naming the
    // guardian the reuse authority — but the guardian has no server-side reuse
    // cache and strips the session-key hint, so every portal turn leaked a new
    // root. 'server' is now an explicit opt-in for a deployment that HAS built
    // its own guardian-side reuse cache; it must still disable the client map.
    Bun.env.PORTAL_SESSION_REUSE = 'server';
    const transport = makeReuseTransport();
    const client = new OcClient({ principalId: 'p', secret: 's', baseUrl: 'http://oc.example', fetch: transport.fetchFn });

    await client.createSession('u1', 'thread-a');
    await client.createSession('u1', 'thread-a');

    expect(transport.createCount).toBe(2);
  });

  it('client mode is now the default (env unset): a stable thread key reuses one session', async () => {
    // The dead-contract fix (S4): rather than implement the promised-but-missing
    // guardian-side reuse cache, the client-side reuse map (already implemented
    // and tested above) becomes the default so a stable (userId, sessionKey)
    // reuses one session with NO guardian involvement required.
    const transport = makeReuseTransport();
    const client = new OcClient({ principalId: 'p', secret: 's', baseUrl: 'http://oc.example', fetch: transport.fetchFn });

    const first = await client.createSession('u1', 'thread-a');
    const second = await client.createSession('u1', 'thread-a');

    expect(first.id).toBe('s1');
    expect(second.id).toBe('s1');
    expect(transport.createCount).toBe(1);
  });

  it('any value other than "server" (e.g. a typo) resolves to the fail-safe client default', async () => {
    Bun.env.PORTAL_SESSION_REUSE = 'clientt';
    const transport = makeReuseTransport();
    const client = new OcClient({ principalId: 'p', secret: 's', baseUrl: 'http://oc.example', fetch: transport.fetchFn });

    await client.createSession('u1', 'thread-a');
    await client.createSession('u1', 'thread-a');

    expect(transport.createCount).toBe(1);
  });

  it('falls back to userId as the reuse key when no sessionKey is given', async () => {
    Bun.env.PORTAL_SESSION_REUSE = 'client';
    const transport = makeReuseTransport();
    const client = new OcClient({ principalId: 'p', secret: 's', baseUrl: 'http://oc.example', fetch: transport.fetchFn });

    await client.createSession('u1');
    await client.createSession('u1');

    expect(transport.createCount).toBe(1);
  });
});
