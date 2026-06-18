/**
 * Route-level tests for GET /admin/versions.
 *
 * Locks the contract that the desktop (Electron) version + update info are
 * surfaced to the UI. The env-var NAMES here must stay in sync with
 * buildUIServerEnv() in packages/electron/src/main.ts — a rename there would
 * silently blank the "Desktop app" row in the Updates tab, so pin them.
 *
 * Docker Hub and npm lookups are mocked so the tests are fast and deterministic.
 * The version cache is reset between tests.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetState } from '$lib/server/test-helpers.js';
import { _resetVersionCache } from '$lib/server/version-cache.js';
import { GET } from './+server.js';

const ELECTRON_ENV = ['OP_INSIDE_ELECTRON', 'OP_ELECTRON_VERSION', 'OP_ELECTRON_LATEST_VERSION', 'OP_ELECTRON_LATEST_URL'] as const;
const saved: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

function makeGetEvent(token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    url: new URL('http://localhost/admin/versions'),
    request: new Request('http://localhost/admin/versions', {
      method: 'GET',
      headers: { cookie: `op_session=${token}`, 'x-request-id': 'req-versions-test' },
    }),
  } as Parameters<typeof GET>[0];
}

// Mock fetch: Docker Hub tags → valid response, npm → valid packument.
// Non-matching URLs get an empty 200 so nothing throws unexpectedly.
function mockFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('registry.hub.docker.com')) {
      return new Response(
        JSON.stringify({ results: [{ name: 'v0.12.5' }, { name: 'v0.12.4' }, { name: 'latest' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('registry.npmjs.org')) {
      return new Response(
        JSON.stringify({
          'dist-tags': { latest: '0.12.5' },
          versions: { '0.12.5': {} },
          time: { '0.12.5': '2026-06-18T00:00:00Z' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

beforeEach(() => {
  resetState('admin-token');
  _resetVersionCache();
  for (const k of ELECTRON_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  vi.stubGlobal('fetch', mockFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
  for (const k of ELECTRON_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

type VersionsBody = {
  imageTag: string;
  inElectron: boolean;
  electronVersion: string | null;
  electronLatestVersion: string | null;
  electronLatestUrl: string | null;
  electronUpdateAvailable: boolean;
  platformVersion: string;
  platformLatest: string | null;
  unitTags: Record<string, string[]>;
  services: { id: string; latestVersion?: string | null }[];
};

describe('GET /admin/versions', () => {
  test('requires admin auth', async () => {
    const res = await GET(makeGetEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('reports no Electron info outside the desktop app', async () => {
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as VersionsBody;
    expect(body.inElectron).toBe(false);
    expect(body.electronVersion).toBeNull();
    expect(body.electronUpdateAvailable).toBe(false);
  });

  test('surfaces the Electron version (up to date)', async () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    process.env.OP_ELECTRON_VERSION = '0.11.2';
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as VersionsBody;
    expect(body.inElectron).toBe(true);
    expect(body.electronVersion).toBe('0.11.2');
    expect(body.electronUpdateAvailable).toBe(false);
    expect(body.electronLatestVersion).toBeNull();
  });

  test('surfaces an available desktop update with its download URL', async () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    process.env.OP_ELECTRON_VERSION = '0.11.2';
    process.env.OP_ELECTRON_LATEST_VERSION = '0.11.3';
    process.env.OP_ELECTRON_LATEST_URL = 'https://github.com/itlackey/openpalm/releases/tag/v0.11.3';
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as VersionsBody;
    expect(body.electronUpdateAvailable).toBe(true);
    expect(body.electronLatestVersion).toBe('0.11.3');
    expect(body.electronLatestUrl).toContain('releases/tag/v0.11.3');
  });

  test('returns unitTags from Docker Hub and platformLatest from npm', async () => {
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as VersionsBody;
    // Assistant is always present; its Docker Hub tags are mocked.
    expect(body.unitTags.assistant).toEqual(['v0.12.5', 'v0.12.4']);
    // platformLatest comes from the mocked npm packument.
    expect(body.platformLatest).toBe('0.12.5');
    // The assistant service carries the latest tag from Docker Hub.
    expect(body.services.find((s) => s.id === 'assistant')?.latestVersion).toBe('0.12.5');
  });

  test('serves cached data on a second call without hitting upstreams', async () => {
    const fetchSpy = mockFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await GET(makeGetEvent());
    const callsAfterFirst = fetchSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Second call — cache hit, no new upstream fetches.
    await GET(makeGetEvent());
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);
  });
});
