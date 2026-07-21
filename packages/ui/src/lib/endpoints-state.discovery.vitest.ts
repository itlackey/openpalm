/**
 * PR #571 review P2 (#511) — localDiscoverySettled().
 *
 * The chat landing decides "no connections at all → go to /connections/new"
 * only AFTER the once-per-session local discovery had its chance to add a
 * reachable local assistant. That requires the service to expose when
 * discovery has settled: load() itself must stay fire-and-forget (boot never
 * waits on the probe), so the empty-store verdict needs its own await point.
 *
 * Pins:
 *  - before any load(), localDiscoverySettled() resolves immediately;
 *  - after a load() that finds an empty store, localDiscoverySettled() waits
 *    for the in-flight discovery, and a discovery hit is visible in
 *    `endpoints` once it resolves (so the chat landing stays put);
 *  - a second load() does not restart discovery (once per session).
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Connection } from './connections/store.js';

const LOCAL_CONNECTION: Connection = {
  id: 'local-assistant',
  label: 'Local assistant',
  baseUrl: 'http://127.0.0.1:3800',
  auth: { mode: 'none' },
} as Connection;

// In-memory stand-in for the browser connection store; discovery flips
// `discovered` to make the follow-up list() include the found assistant.
const fakeStore = {
  discovered: false,
  seedFromRuntimeConfig: vi.fn(async () => {}),
  list: vi.fn(async () => (fakeStore.discovered ? [LOCAL_CONNECTION] : [])),
  getActiveId: vi.fn(async () => null),
  get: vi.fn(async () => LOCAL_CONNECTION),
  setActive: vi.fn(async () => {}),
  clearActive: vi.fn(async () => {}),
};

let releaseDiscovery: (() => void) | null = null;
const discoverLocalAssistant = vi.fn(async () => {
  await new Promise<void>((res) => {
    releaseDiscovery = res;
  });
  fakeStore.discovered = true;
  return LOCAL_CONNECTION;
});

vi.mock('./connections/boot.js', () => ({
  getConnectionStore: () => fakeStore,
  setActiveConnection: vi.fn(),
}));
vi.mock('./connections/store.js', () => ({
  loadRuntimeConfig: vi.fn(async () => null),
}));
vi.mock('./connections/discovery.js', () => ({
  // The real signature takes the store; the stub ignores it, so the wrapper
  // drops the argument to keep the typed vi.fn zero-arg.
  discoverLocalAssistant: () => discoverLocalAssistant(),
}));
vi.mock('./connection-events.js', () => ({
  activationBlockReason: () => null,
  emitConnectionActivated: vi.fn(async () => {}),
}));

import { endpointsService } from './endpoints-state.svelte.js';

describe('endpointsService.localDiscoverySettled()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('resolves immediately before any load() has started discovery', async () => {
    await expect(endpointsService.localDiscoverySettled()).resolves.toBeUndefined();
    expect(discoverLocalAssistant).not.toHaveBeenCalled();
  });

  test('after an empty-store load(), waits for discovery and sees its result', async () => {
    await endpointsService.load();
    // Boot did not wait on the probe: load() settled with an empty list while
    // discovery is still in flight.
    expect(endpointsService.endpoints).toHaveLength(0);
    expect(discoverLocalAssistant).toHaveBeenCalledTimes(1);

    let settled = false;
    const wait = endpointsService.localDiscoverySettled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseDiscovery?.();
    await wait;
    expect(endpointsService.endpoints.map((e) => e.id)).toEqual(['local-assistant']);
  });

  test('a second load(force) does not restart discovery (once per session)', async () => {
    await endpointsService.load(true);
    expect(discoverLocalAssistant).not.toHaveBeenCalled();
    await expect(endpointsService.localDiscoverySettled()).resolves.toBeUndefined();
  });
});
