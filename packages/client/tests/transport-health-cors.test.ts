/**
 * E3 [MEDIUM] (review 2026-07-10 §E3, transport half) — probeHealth() could
 * not distinguish a CORS-blocked connection from a genuinely down one; both
 * surface as the browser throwing a bare `TypeError` from `fetch`, so the
 * health badge showed "unreachable" with no remediation hint even though the
 * upstream was up and reachable.
 *
 * Heuristic (documented in the implementation too): a CORS-denied response
 * and a network-down failure are indistinguishable from the *first* fetch's
 * TypeError alone. Disambiguate with a second, `mode: 'no-cors'` probe: an
 * opaque no-cors request still succeeds whenever the server is reachable at
 * the network level, regardless of what CORS headers it sends (no-cors
 * responses are always type 'opaque' and never throic on a CORS mismatch) —
 * so if the no-cors probe resolves, the ONLY thing that could have made the
 * first, normal-mode fetch throw is the browser refusing to expose a
 * cross-origin response body, i.e. CORS. If the no-cors probe ALSO throws,
 * the connection is genuinely unreachable.
 *
 * This keeps the existing 'accessible' | 'unauthorized' | 'unreachable'
 * vocabulary working and adds a new 'blocked' state (detail: 'cors').
 *
 * New file — does not modify the shared tests/helpers/*.ts contract.
 */
import { describe, expect, test } from 'bun:test';

async function loadTransportModule() {
  return import('../src/lib/transport/index.ts');
}

const BASE = 'http://gw.example:8443';

describe('probeHealth CORS-block detection (E3)', () => {
  test('a TypeError on the primary probe followed by a successful no-cors probe reports "blocked"/"cors"', async () => {
    const { createTransport } = await loadTransportModule();
    const calls: RequestInit[] = [];
    const fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      if (init?.mode === 'no-cors') {
        // A real browser opaque no-cors response has status 0 and an
        // unreadable body — `Response` refuses to construct status 0
        // directly (spec: [200,599] or 101), so this stand-in just proves
        // "the no-cors fetch resolved instead of throwing", which is the
        // only signal probeHealth is allowed to use for an opaque response.
        return new Response(null, { status: 200 });
      }
      throw new TypeError('Failed to fetch');
    }) as typeof globalThis.fetch;

    const transport = createTransport({ baseUrl: BASE, fetch });
    const result = await transport.probeHealth();
    expect(result.state).toBe('blocked');
    expect(result.detail).toBe('cors');
    expect(calls.length).toBe(2);
    expect(calls[1].mode).toBe('no-cors');
  });

  test('a TypeError on both the primary AND the no-cors probe reports "unreachable"', async () => {
    const { createTransport } = await loadTransportModule();
    const fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof globalThis.fetch;

    const transport = createTransport({ baseUrl: BASE, fetch });
    const result = await transport.probeHealth();
    expect(result.state).toBe('unreachable');
  });

  test('the no-cors fallback probe never carries the Authorization header', async () => {
    // no-cors requests may only carry CORS-safelisted headers; Authorization
    // is not one of them, so the probe must be sent bare.
    const { createTransport } = await loadTransportModule();
    const calls: RequestInit[] = [];
    const fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      if (init?.mode === 'no-cors') return new Response(null, { status: 200 });
      throw new TypeError('Failed to fetch');
    }) as typeof globalThis.fetch;

    const transport = createTransport({
      baseUrl: BASE,
      auth: { mode: 'bearer', token: 'tok_1' },
      fetch,
    });
    await transport.probeHealth();
    const noCorsCall = calls.find((c) => c.mode === 'no-cors');
    const headers = new Headers(noCorsCall?.headers);
    expect(headers.get('authorization')).toBeNull();
  });

  test('a non-TypeError failure (e.g. an explicit abort) does not attempt the no-cors fallback', async () => {
    const { createTransport } = await loadTransportModule();
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      throw new DOMException('The operation was aborted.', 'AbortError');
    }) as typeof globalThis.fetch;

    const transport = createTransport({ baseUrl: BASE, fetch });
    const result = await transport.probeHealth();
    expect(result.state).toBe('unreachable');
    expect(calls).toBe(1);
  });

  test('existing vocabulary values (accessible/unauthorized/unreachable via HTTP status) still work', async () => {
    const { createTransport } = await loadTransportModule();
    const okFetch = (async () => new Response('ok', { status: 200 })) as typeof globalThis.fetch;
    const unauthorizedFetch = (async () => new Response('no', { status: 401 })) as typeof globalThis.fetch;
    expect((await createTransport({ baseUrl: BASE, fetch: okFetch }).probeHealth()).state).toBe('accessible');
    expect((await createTransport({ baseUrl: BASE, fetch: unauthorizedFetch }).probeHealth()).state).toBe(
      'unauthorized'
    );
  });
});
