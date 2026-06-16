/**
 * A7 AC tests — remoteStatusCache / listRemoteStatuses probe-TTL.
 *
 * Verifies:
 *   1. Results are cached in-memory for ~5 s (second call does NOT fire a second
 *      network probe within the TTL window).
 *   2. Cache expires after the TTL — a call past expiry issues a fresh probe.
 *   3. Results are NEVER written to the 0600 config file (endpoints.json); the
 *      cache lives entirely in process memory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestState, registerCleanup, trackDir } from './test-helpers.js';
import { _replaceState } from './state.js';
import {
  listRemoteStatuses,
  _resetRemoteStatusCache,
  addEndpoint,
} from './endpoints.js';

registerCleanup();

beforeEach(() => {
  _resetRemoteStatusCache();
  const state = makeTestState();
  trackDir(state.dataDir);
  trackDir(state.configDir);
  mkdirSync(state.dataDir, { recursive: true });
  mkdirSync(state.configDir, { recursive: true });
  _replaceState(state);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Minimal fetch mock that records call count.
function makeFetchSpy(responseStatus = 200): { spy: ReturnType<typeof vi.fn>; callCount: () => number } {
  let calls = 0;
  const spy = vi.fn(async (_url: string | URL | Request) => {
    calls++;
    return new Response(null, { status: responseStatus });
  });
  return { spy, callCount: () => calls };
}

describe('listRemoteStatuses — probe TTL (in-memory only)', () => {
  it('returns results from cache on the second call within 5 s TTL', async () => {
    vi.useFakeTimers();
    const { spy, callCount } = makeFetchSpy(200);
    vi.stubGlobal('fetch', spy);

    // Add a real endpoint so there is something to probe beyond the default.
    addEndpoint({ label: 'Test Remote', url: 'http://127.0.0.1:9999' });

    // First call — fires one probe per endpoint (default + user-added).
    const first = await listRemoteStatuses();
    const callsAfterFirst = callCount();
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Second call within TTL — must return cached value, no new probes fired.
    const second = await listRemoteStatuses();
    expect(callCount()).toBe(callsAfterFirst); // count unchanged — cache hit

    // Results should be structurally equal.
    expect(second).toEqual(first);
  });

  it('re-probes after the 5 s TTL expires', async () => {
    vi.useFakeTimers();
    const { spy, callCount } = makeFetchSpy(200);
    vi.stubGlobal('fetch', spy);

    addEndpoint({ label: 'Expiry Remote', url: 'http://127.0.0.1:9998' });

    await listRemoteStatuses(); // first probe batch
    const callsAfterFirst = callCount();
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Advance time past the 5 000 ms TTL.
    vi.advanceTimersByTime(6_000);

    await listRemoteStatuses(); // should issue a fresh probe batch
    expect(callCount()).toBe(callsAfterFirst * 2);
  });

  it('cache reset forces a fresh probe', async () => {
    const { spy, callCount } = makeFetchSpy(200);
    vi.stubGlobal('fetch', spy);

    addEndpoint({ label: 'Reset Remote', url: 'http://127.0.0.1:9997' });

    await listRemoteStatuses();
    const callsAfterFirst = callCount();
    expect(callsAfterFirst).toBeGreaterThan(0);

    _resetRemoteStatusCache();
    await listRemoteStatuses();
    expect(callCount()).toBe(callsAfterFirst * 2); // another full batch
  });

  it('does NOT write probe results to the 0600 config file (endpoints.json)', async () => {
    vi.useFakeTimers();
    const { spy } = makeFetchSpy(200);
    vi.stubGlobal('fetch', spy);

    // Capture the config dir path before any probe.
    const { getState } = await import('./state.js');
    const configDir = getState().configDir;
    const endpointsPath = join(configDir, 'endpoints.json');

    // Record mtime (or absence) before the probe.
    const mtimeBefore = existsSync(endpointsPath)
      ? statSync(endpointsPath).mtimeMs
      : null;

    addEndpoint({ label: 'NoDisk Remote', url: 'http://127.0.0.1:9996' });

    // addEndpoint WILL write endpoints.json — capture mtime AFTER that write.
    const mtimeAfterAdd = existsSync(endpointsPath)
      ? statSync(endpointsPath).mtimeMs
      : null;

    // Now run the probe.
    await listRemoteStatuses();

    // The file must NOT have been touched after addEndpoint wrote it.
    const mtimeAfterProbe = existsSync(endpointsPath)
      ? statSync(endpointsPath).mtimeMs
      : null;

    expect(mtimeAfterProbe).toBe(mtimeAfterAdd);

    // Sanity: neither the default endpoint nor probe results appear in the file.
    if (existsSync(endpointsPath)) {
      const parsed = JSON.parse(readFileSync(endpointsPath, 'utf-8')) as {
        endpoints: Array<{ label: string }>;
        activeId: string | null;
      };
      // The file stores user-defined endpoints — not statuses.
      const hasStatusKeys = parsed.endpoints.some(
        (e) => 'state' in e || 'reachable' in e,
      );
      expect(hasStatusKeys).toBe(false);
    }

    void mtimeBefore; // used only for documentation purposes
  });

  it('returns defensive copies so mutating the return value does not corrupt the cache', async () => {
    const { spy } = makeFetchSpy(200);
    vi.stubGlobal('fetch', spy);

    addEndpoint({ label: 'Copy Remote', url: 'http://127.0.0.1:9995' });

    const first = await listRemoteStatuses();
    // Mutate an element in the returned array.
    if (first.length > 0) {
      (first[0] as unknown as Record<string, unknown>)['state'] = 'MUTATED' as never;
    }

    const second = await listRemoteStatuses();
    // Cache should return a clean copy — not the mutated value.
    for (const status of second) {
      expect(status.state).not.toBe('MUTATED');
    }
  });
});
