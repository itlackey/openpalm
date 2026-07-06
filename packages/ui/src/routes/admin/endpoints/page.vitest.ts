/**
 * Phase 2 (#486) — /admin/endpoints is a redirect alias to /connections for
 * the 0.13.0 release (plan ui-runtime-modes-plan.md Phase 2 step 5: chat
 * links move to /connections and the old route redirects there; the alias is
 * removed when Phase 4 turns /admin/* into 404s).
 *
 * ALL RED until the implementation lands: routes/admin/endpoints/+page.ts
 * does not exist yet (the route currently renders the management UI from
 * +page.svelte directly). The redirect contract pinned here is a universal
 * load in +page.ts throwing SvelteKit's redirect() — the same convention as
 * the existing root redirect (src/routes/+page.ts → /splash).
 *
 * The module is loaded through a computed-specifier dynamic import so
 * svelte-check stays clean while the suite is red.
 */
import { describe, expect, test } from 'vitest';

type PageLoadModule = { load: (event: unknown) => unknown };

async function loadPageModule(): Promise<PageLoadModule> {
  const specifier = './+page.js';
  return (await import(/* @vite-ignore */ specifier)) as PageLoadModule;
}

function makeLoadEvent(): unknown {
  const url = new URL('http://127.0.0.1:3880/admin/endpoints');
  return {
    url,
    params: {},
    route: { id: '/admin/endpoints' },
    fetch: globalThis.fetch,
    data: {},
    depends: () => {},
    parent: async () => ({}),
    untrack: <T>(fn: () => T) => fn(),
  };
}

describe('/admin/endpoints → /connections redirect alias (plan Phase 2 step 5)', () => {
  test('exports a load function', async () => {
    const mod = await loadPageModule();
    expect(typeof mod.load).toBe('function');
  });

  test('load() throws a 3xx redirect to /connections', async () => {
    const { load } = await loadPageModule();
    try {
      await load(makeLoadEvent());
      throw new Error('expected the load to throw a redirect');
    } catch (e) {
      // SvelteKit redirect() throws a { status, location } object.
      const redirect = e as { status?: number; location?: string };
      expect(redirect.location).toBe('/connections');
      expect(redirect.status).toBeGreaterThanOrEqual(300);
      expect(redirect.status).toBeLessThan(400);
    }
  });
});
