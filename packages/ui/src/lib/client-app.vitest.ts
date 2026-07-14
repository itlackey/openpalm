/**
 * Tests for lib/client-app.ts — probeClientApp() browser-side reachability
 * probe for the "Install OpenPalm app" affordance (#511 D8).
 *
 * Idiom: plain node-project vitest, injected fetch (no globals stubbed —
 * client-app.ts takes fetchImpl as a parameter, mirroring
 * packages/client/src/lib/transport/index.ts's probeCorsBlock no-cors
 * reachability trick).
 *
 * RED REASON: the module ./client-app.ts does not exist yet — every test in
 * this file fails at import.
 */
import { describe, expect, test, vi } from 'vitest';
import { probeClientApp } from './client-app.js';

describe('probeClientApp', () => {
  test('resolves true when a no-cors probe resolves', async () => {
    // A real no-cors browser fetch resolves an opaque Response (status 0,
    // type 'opaque') — but the Fetch spec's Response constructor only
    // accepts 200-599 (undici enforces this), so status 0 isn't
    // constructible here; a plain 200 exercises the same "resolved, don't
    // inspect the body" contract (test-only deviation from the spec's
    // literal "opaque-ish" construction; recorded in the #511 implementer
    // report).
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const result = await probeClientApp('http://127.0.0.1:3890', fetchImpl as unknown as typeof fetch);
    expect(result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3890/');
    expect(init.mode).toBe('no-cors');
    expect(init.cache).toBe('no-store');
  });

  test('resolves false when the probe rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const result = await probeClientApp('http://127.0.0.1:3890', fetchImpl as unknown as typeof fetch);
    expect(result).toBe(false);
  });
});
