/**
 * Route-level tests for GET /admin/versions/latest.
 *
 * Regression guard for the Docker Hub "latest tag" resolution: it MUST order by
 * last_updated (newest push first), not lexicographic -name. With -name, a tag
 * like "v0.12.9" sorts above "v0.12.33", and once a repo accumulates >100 tags
 * the newest stable release is paginated out of the first page entirely — the
 * UI then reports a stale latest (the bug that hid v0.12.33 behind v0.12.30).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetState } from '$lib/server/test-helpers.js';
import { GET } from './+server.js';

function makeGetEvent(token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    url: new URL('http://localhost/admin/versions/latest'),
    request: new Request('http://localhost/admin/versions/latest', {
      method: 'GET',
      headers: { cookie: `op_session=${token}`, 'x-request-id': 'req-latest' },
    }),
  } as Parameters<typeof GET>[0];
}

// Newest-first (as Docker Hub returns with ordering=last_updated). v0.12.9 is
// included to prove lexicographic ordering is NOT relied on for the max. Tags
// mix bare (post-0.12.41 cutover) and legacy `v`-prefixed forms — the resolver
// must read both and return the canonical bare version.
const HUB_TAGS = {
  results: [
    { name: '0.12.33' },
    { name: 'latest' },
    { name: 'v0.12.9' },
    { name: 'v0.12.30' },
    { name: 'sha-abc1234-amd64' },
    { name: '0.12.0-rc.8' },
  ],
};

beforeEach(() => {
  resetState('admin-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /admin/versions/latest', () => {
  test('rejects non-admin before any lookup', async () => {
    const res = await GET(makeGetEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('resolves the highest STABLE tag and queries last_updated ordering', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        calls.push(u);
        if (u.includes('hub.docker.com')) {
          return new Response(JSON.stringify(HUB_TAGS), { status: 200 });
        }
        // npm @openpalm/ui latest
        return new Response(JSON.stringify({ version: '0.12.33' }), { status: 200 });
      })
    );

    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versions: Record<string, string | null> };

    // Highest stable wins even though v0.12.9 is lexicographically larger;
    // returned bare regardless of the published tag's `v` prefix.
    expect(body.versions.OP_ASSISTANT_VERSION).toBe('0.12.33');

    // Regression guard: must order by last_updated, never lexicographic -name.
    const hubCall = calls.find((c) => c.includes('hub.docker.com'));
    expect(hubCall).toBeDefined();
    expect(hubCall).toContain('ordering=last_updated');
    expect(hubCall).not.toContain('ordering=-name');
  });
});
