import { describe, expect, test, vi } from 'vitest';
import { bootstrapStart } from './bootstrap.js';

type Endpoint = { id: string };

function harness(options: {
  capabilities?: string[];
  endpoints?: Endpoint[];
  serviceActiveId?: string;
  loadError?: string;
} = {}) {
  const calls: string[] = [];
  const endpoints = options.endpoints ?? [];
  const service = {
    endpoints,
    activeId: options.serviceActiveId ?? '',
    error: '',
    async load(force = false) {
      calls.push(`load:${force}`);
      this.error = options.loadError ?? '';
      if (!this.endpoints.some((endpoint) => endpoint.id === this.activeId)) {
        this.activeId = this.endpoints[0]?.id ?? '';
      }
    },
    async localDiscoverySettled() {
      calls.push('discovery');
    },
  };
  const runtimeContext = {
    effectiveCapabilities: options.capabilities ?? [],
  };
  return { calls, runtimeContext, service };
}

describe('/start browser bootstrap', () => {
  // F11: an already-known active connection must short-circuit straight to
  // /chat instead of also waiting out localDiscoverySettled()'s probe
  // timeouts — that detour is for the genuinely-empty-list case only.
  test('restores a valid saved active connection without a health probe or a discovery detour', async () => {
    const h = harness({
      endpoints: [{ id: 'saved' }, { id: 'other' }],
      serviceActiveId: 'saved',
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(bootstrapStart(h.runtimeContext, h.service)).resolves.toEqual({
      kind: 'navigate',
      href: '/chat?assistant=saved',
    });
    expect(h.calls).toEqual(['load:false']);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test('uses the active id repaired by endpointsService during load, without a discovery detour', async () => {
    const h = harness({
      endpoints: [{ id: 'first' }, { id: 'second' }],
      serviceActiveId: 'removed',
    });

    await expect(bootstrapStart(h.runtimeContext, h.service)).resolves.toEqual({
      kind: 'navigate',
      href: '/chat?assistant=first',
    });
    expect(h.calls).toEqual(['load:false']);
  });

  // The discovery detour still runs — and is still awaited — when load()
  // resolves to no active connection at all (a genuinely fresh browser).
  test('still waits on local discovery when load resolves to no active connection', async () => {
    const h = harness({ capabilities: ['host:setup'] });
    await expect(bootstrapStart(h.runtimeContext, h.service)).resolves.toEqual({ kind: 'choice' });
    expect(h.calls).toEqual(['load:false', 'discovery']);
  });

  test('shows the one-screen choice only when no connection exists and host setup is effective', async () => {
    const h = harness({ capabilities: ['host:setup'] });
    await expect(bootstrapStart(h.runtimeContext, h.service)).resolves.toEqual({ kind: 'choice' });
  });

  test('sends a client-only or standalone PWA directly to remote onboarding', async () => {
    const h = harness();
    await expect(bootstrapStart(h.runtimeContext, h.service)).resolves.toEqual({
      kind: 'navigate',
      href: '/connections/new?onboarding=1',
    });
  });

  test('surfaces connection-load failure and supports a forced retry', async () => {
    const h = harness({ loadError: 'IndexedDB unavailable' });
    await expect(bootstrapStart(h.runtimeContext, h.service, true)).rejects.toThrow(
      'IndexedDB unavailable',
    );
    expect(h.calls).toEqual(['load:true']);
  });
});
