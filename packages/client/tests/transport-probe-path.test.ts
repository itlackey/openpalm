/**
 * #486 D2 — transport probeHealth() honors an optional probePath.
 *
 * Guardian /oc-fronted connections must NOT probe `${base}/` (bare `GET
 * /oc/` is not an allowlisted guardian route and 404s even against a fully
 * healthy guardian) — they probe the allowlisted `GET /session` instead.
 * `TransportOptions.probePath` lets the connections form (and the e2e suite)
 * choose the probed path per-connection-kind; every existing caller that
 * omits it keeps probing the base root exactly as before (test 15, C).
 *
 * Mirrors tests/transport-health.test.ts's harness (loadTransportModule +
 * recordingFetch).
 *
 * RED until TransportOptions gains `probePath` and probeHealth() honors it —
 * today probeHealth() hardcodes `${base}/` unconditionally
 * (src/lib/transport/index.ts:530).
 */
import { describe, expect, test } from 'bun:test';
import { loadTransportModule } from './helpers/contract.ts';
import { recordingFetch } from './helpers/mocks.ts';

const BASE = 'http://gw.example:8443';

function statusResponse(status: number): Response {
  return new Response(status === 204 ? null : 'x', { status });
}

describe('transport probeHealth probePath (#486 D2)', () => {
  test('probeHealth GETs ${base}${probePath} when TransportOptions.probePath is set', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => statusResponse(200));
    await createTransport({
      baseUrl: BASE,
      probePath: '/session',
      fetch,
    } as Parameters<typeof createTransport>[0]).probeHealth();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('http://gw.example:8443/session');
  });

  test('probePath defaults to the base root (C — zero behavior change for existing callers)', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => statusResponse(200));
    await createTransport({ baseUrl: BASE, fetch }).probeHealth();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${BASE}/`);
  });

  test('status mapping is unchanged under probePath (401 on /session -> unauthorized)', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => statusResponse(401));
    const result = await createTransport({
      baseUrl: BASE,
      probePath: '/session',
      fetch,
    } as Parameters<typeof createTransport>[0]).probeHealth();
    expect(calls[0].url).toBe(`${BASE}/session`);
    expect(result.state).toBe('unauthorized');
    expect(result.detail).toBe('HTTP 401');
  });
});
