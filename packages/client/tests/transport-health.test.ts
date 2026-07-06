/**
 * P5b (#555) RED — health probe status mapping (P5b item 1: "health probe").
 *
 * probeHealth() GETs the connection base URL with the connection credentials
 * and maps the outcome onto the same state vocabulary the host app uses for
 * connection probing (packages/ui/src/lib/server/endpoints.ts
 * probeEndpoint(): RemoteStatus):
 *   - 2xx and 3xx        -> 'accessible'
 *   - 401 / 403          -> 'unauthorized' (detail 'HTTP <status>')
 *   - other HTTP status  -> 'unreachable'  (detail 'HTTP <status>')
 *   - network failure    -> 'unreachable'  (detail = error message)
 *
 * The probe never throws — connection health is data, not an exception path
 * (the /connections list renders it for every stored connection, offline
 * included).
 *
 * RED until src/lib/transport/index.ts exists: every test fails with
 * "Cannot find module …/src/lib/transport/index.ts" (missing feature).
 */
import { describe, expect, test } from 'bun:test';
import { loadTransportModule } from './helpers/contract.ts';
import { recordingFetch } from './helpers/mocks.ts';

const BASE = 'http://gw.example:8443';

function statusResponse(status: number): Response {
  return new Response(status === 204 ? null : 'x', { status });
}

describe('transport health probe status mapping (P5b item 1)', () => {
  test('HTTP 200 maps to accessible', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch } = recordingFetch(() => statusResponse(200));
    const result = await createTransport({ baseUrl: BASE, fetch }).probeHealth();
    expect(result.state).toBe('accessible');
  });

  test('a 3xx redirect maps to accessible (endpoint is alive)', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch } = recordingFetch(() => statusResponse(302));
    const result = await createTransport({ baseUrl: BASE, fetch }).probeHealth();
    expect(result.state).toBe('accessible');
  });

  test('HTTP 401 maps to unauthorized with the HTTP status as detail', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch } = recordingFetch(() => statusResponse(401));
    const result = await createTransport({ baseUrl: BASE, fetch }).probeHealth();
    expect(result.state).toBe('unauthorized');
    expect(result.detail).toBe('HTTP 401');
  });

  test('HTTP 403 maps to unauthorized', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch } = recordingFetch(() => statusResponse(403));
    const result = await createTransport({ baseUrl: BASE, fetch }).probeHealth();
    expect(result.state).toBe('unauthorized');
    expect(result.detail).toBe('HTTP 403');
  });

  test('HTTP 500 maps to unreachable with the HTTP status as detail', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch } = recordingFetch(() => statusResponse(500));
    const result = await createTransport({ baseUrl: BASE, fetch }).probeHealth();
    expect(result.state).toBe('unreachable');
    expect(result.detail).toBe('HTTP 500');
  });

  test('a network failure maps to unreachable with the error message as detail (never throws)', async () => {
    const { createTransport } = await loadTransportModule();
    const failing = (async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof globalThis.fetch;
    const result = await createTransport({ baseUrl: BASE, fetch: failing }).probeHealth();
    expect(result.state).toBe('unreachable');
    expect(result.detail).toContain('connection refused');
  });

  test('probes the connection base URL itself, with credentials and no cookies', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => statusResponse(200));
    await createTransport({
      baseUrl: BASE,
      auth: { mode: 'bearer', token: 'tok_1' },
      fetch
    }).probeHealth();
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('GET');
    const probed = new URL(calls[0].url);
    expect(probed.origin).toBe(BASE);
    expect(probed.pathname).toBe('/');
    expect(calls[0].headers.get('authorization')).toBe('Bearer tok_1');
    expect(calls[0].credentials).toBe('omit');
  });
});
