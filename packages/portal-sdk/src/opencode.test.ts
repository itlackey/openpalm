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
import { describe, it, expect } from 'bun:test';
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
