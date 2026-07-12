/**
 * #557 D6 — probeHealth() short-circuits a plain-HTTP remote target on an
 * https app origin, WITHOUT performing any network I/O: it must not observe
 * the misleading `unreachable` a mixed-content-blocked fetch produces today
 * (a TypeError on the primary probe, then a second no-cors re-probe that is
 * ALSO mixed-content-blocked). validateConnectionUrl() is consulted first;
 * an `insecure-remote` verdict returns `{ state: 'insecure', detail:
 * 'plain-http-remote' }` before `fetch` is ever called.
 *
 * Modeled on transport-health-cors.test.ts's injectable-counting-fetch idiom,
 * plus a local withLocation(protocol, hostname, run) helper mirroring
 * connections-seed.test.ts's withLocationHost — extended to stub both
 * `protocol` and `hostname` since validateConnectionUrl's default origin
 * argument reads `globalThis.location`.
 *
 * RED reasons:
 *   - the short-circuit test fails at the type level ('insecure' is not yet
 *     in the HealthProbeResult.state union) and at runtime (today's
 *     probeHealth calls fetch twice and returns 'unreachable' instead of
 *     short-circuiting with zero fetches);
 *   - the three "still fetches"/"unchanged" tests are called out as
 *     green-on-arrival pins in the commit message (they guard the allowed
 *     tiers and the location-absent path, which pre-#557 code already gets
 *     right by having no insecure-remote branch to short-circuit into).
 */
import { describe, expect, test } from 'bun:test';

async function loadTransportModule() {
  return import('../src/lib/transport/index.ts');
}

async function withLocation<T>(
  protocol: string,
  hostname: string,
  run: () => Promise<T>
): Promise<T> {
  const originalLocation = globalThis.location;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { protocol, hostname }
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: originalLocation
    });
  }
}

async function withNoLocation<T>(run: () => Promise<T>): Promise<T> {
  const hasOwn = Object.prototype.hasOwnProperty.call(globalThis, 'location');
  const originalDescriptor = hasOwn
    ? Object.getOwnPropertyDescriptor(globalThis, 'location')
    : undefined;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: undefined
  });
  try {
    return await run();
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'location', originalDescriptor);
    } else {
      // biome-ignore lint: test cleanup only — remove the stub we added.
      delete (globalThis as Record<string, unknown>).location;
    }
  }
}

describe('probeHealth insecure-remote short-circuit (#557 D6)', () => {
  test('probeHealth short-circuits a plain-http remote target on an https origin — state insecure, zero fetches', async () => {
    await withLocation('https:', 'app.openpalm.dev', async () => {
      const { createTransport } = await loadTransportModule();
      let calls = 0;
      const fetch = (async () => {
        calls += 1;
        return new Response('ok', { status: 200 });
      }) as typeof globalThis.fetch;

      const transport = createTransport({ baseUrl: 'http://gw.lan:3830', fetch });
      const result = await transport.probeHealth();
      expect(result.state).toBe('insecure');
      expect(result.detail).toBe('plain-http-remote');
      expect(calls).toBe(0);
    });
  });

  test('probeHealth still fetches a loopback target from an https origin', async () => {
    await withLocation('https:', 'app.openpalm.dev', async () => {
      const { createTransport } = await loadTransportModule();
      let calls = 0;
      const fetch = (async () => {
        calls += 1;
        return new Response('ok', { status: 200 });
      }) as typeof globalThis.fetch;

      const transport = createTransport({ baseUrl: 'http://127.0.0.1:3800', fetch });
      const result = await transport.probeHealth();
      expect(result.state).toBe('accessible');
      expect(calls).toBe(1);
    });
  });

  test('probeHealth still fetches a plain-http remote target from a loopback origin', async () => {
    await withLocation('http:', 'localhost', async () => {
      const { createTransport } = await loadTransportModule();
      let calls = 0;
      const fetch = (async () => {
        calls += 1;
        return new Response('ok', { status: 200 });
      }) as typeof globalThis.fetch;

      const transport = createTransport({ baseUrl: 'http://gw.lan:3830', fetch });
      const result = await transport.probeHealth();
      expect(result.state).toBe('accessible');
      expect(calls).toBe(1);
    });
  });

  test('probeHealth behavior is unchanged when globalThis.location is absent', async () => {
    await withNoLocation(async () => {
      const { createTransport } = await loadTransportModule();
      let calls = 0;
      const fetch = (async () => {
        calls += 1;
        return new Response('no', { status: 401 });
      }) as typeof globalThis.fetch;

      const transport = createTransport({ baseUrl: 'http://gw.lan:3830', fetch });
      const result = await transport.probeHealth();
      expect(result.state).toBe('unauthorized');
      expect(calls).toBe(1);
    });
  });
});
