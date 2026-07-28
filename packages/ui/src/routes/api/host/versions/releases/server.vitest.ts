/**
 * Route-level tests for GET /api/host/versions/releases.
 *
 * The releases endpoint returns only releases that carry Electron
 * installer assets (app-level releases). Container-image version pins live in
 * stack.env and are edited via /api/host/versions, not GitHub releases. Fetched
 * fresh per request (no server-side cache).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetState } from '$lib/server/test-helpers.js';
import { GET } from './+server.js';

const originalFetch = globalThis.fetch;

function makeGetEvent(token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    url: new URL('http://localhost/api/host/versions/releases'),
    request: new Request('http://localhost/api/host/versions/releases', {
      method: 'GET',
      headers: { cookie: `op_session=${token}`, 'x-request-id': 'req-releases-test' },
    }),
  } as Parameters<typeof GET>[0];
}

function githubResponse(releases: Array<{ tag_name: string; prerelease: boolean; published_at: string; assets: Array<{ name: string }> }>): Response {
  return new Response(JSON.stringify(releases), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_ENABLE_ADMIN = '1';
  resetState('admin-token');
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

describe('GET /api/host/versions/releases', () => {
  test('requires admin auth', async () => {
    const res = await GET(makeGetEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns only releases with Electron installer assets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(githubResponse([
      { tag_name: 'platform-0.12.5', prerelease: false, published_at: '2026-06-18T00:00:00Z', assets: [{ name: 'OpenPalm-0.12.5.dmg' }] },
      { tag_name: 'assistant-0.12.5', prerelease: false, published_at: '2026-06-18T00:00:00Z', assets: [] },
      { tag_name: 'guardian-0.12.7', prerelease: false, published_at: '2026-06-18T00:00:00Z', assets: [] },
    ])));

    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as { releases: { tag: string; hasElectronBuild: boolean }[] };
    expect(body.releases.map((r) => r.tag)).toEqual(['0.12.5']);
    expect(body.releases[0]?.hasElectronBuild).toBe(true);
  });

  test('follows pagination to standalone Electron releases', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          link: '<https://api.github.com/repos/itlackey/openpalm/releases?per_page=100&page=2>; rel="next"',
        },
      }))
      .mockResolvedValueOnce(githubResponse([
        { tag_name: 'electron-0.12.6', prerelease: false, published_at: '2026-06-19T00:00:00Z', assets: [{ name: 'OpenPalm-0.12.6.AppImage' }] },
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(makeGetEvent());
    const body = await res.json() as { releases: { tag: string }[] };
    expect(body.releases.map((release) => release.tag)).toEqual(['0.12.6']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('skips platform releases without Electron assets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(githubResponse([
      { tag_name: 'platform-0.12.4', prerelease: false, published_at: '2026-06-17T00:00:00Z', assets: [] },
      { tag_name: 'v0.12.3', prerelease: false, published_at: '2026-06-16T00:00:00Z', assets: [{ name: 'OpenPalm-0.12.3.dmg' }] },
    ])));

    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as { releases: { tag: string }[] };
    expect(body.releases.map((r) => r.tag)).toEqual(['0.12.3']);
  });

  test('deduplicates platform-* and legacy v* tags for the same semver', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(githubResponse([
      { tag_name: 'platform-0.12.5', prerelease: false, published_at: '2026-06-18T00:00:00Z', assets: [{ name: 'OpenPalm-0.12.5.dmg' }] },
      { tag_name: 'v0.12.5', prerelease: false, published_at: '2026-06-18T00:00:00Z', assets: [{ name: 'OpenPalm-0.12.5.dmg' }] },
    ])));

    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as { releases: { tag: string }[] };
    expect(body.releases).toHaveLength(1);
    expect(body.releases[0]?.tag).toBe('0.12.5');
  });

  test('returns empty list with error when GitHub API returns an error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('rate limited', { status: 403, headers: { 'content-type': 'text/plain' } }),
    ));

    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as { releases: unknown[]; error?: string };
    expect(body.releases).toEqual([]);
    expect(body.error).toBeDefined();
  });

  test('returns empty list with error on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as { releases: unknown[]; error?: string };
    expect(body.releases).toEqual([]);
    expect(body.error).toBeDefined();
  });
});
