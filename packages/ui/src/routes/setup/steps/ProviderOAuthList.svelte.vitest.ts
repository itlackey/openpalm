/**
 * ProviderOAuthList — empty-state disambiguation (W1a).
 *
 * An empty filtered-providers list used to always render "Nothing more to
 * add — you're all connected.", even when it was empty because the catalog
 * never loaded (OpenCode unreachable) rather than because everything really
 * was connected. `opencodeAvailable` (set only once the catalog genuinely
 * loaded — see setup-state.svelte.ts's checkOpenCodeAndInit) is the signal
 * used to tell the two apart.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ProviderOAuthList from './ProviderOAuthList.svelte';
import { setupState } from '$lib/setup/setup-state.svelte.js';

afterEach(() => {
  setupState.reset();
  vi.unstubAllGlobals();
});

describe('ProviderOAuthList — empty state', () => {
  test('an unreachable OpenCode is reported as unreachable, with a retry — not "all connected"', async () => {
    setupState.opencodeAvailable = false;
    setupState.opencodeProviders = [];

    render(ProviderOAuthList);

    await expect.element(page.getByText(/can't reach the sign-in service/i)).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect.element(page.getByText(/all connected/i)).not.toBeInTheDocument();
  });

  test('a genuinely empty catalog (everything already connected) still says so', async () => {
    setupState.opencodeAvailable = true;
    setupState.opencodeProviders = [];

    render(ProviderOAuthList);

    await expect.element(page.getByText(/all connected/i)).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  test('retry re-runs OpenCode discovery', async () => {
    setupState.opencodeAvailable = false;
    setupState.opencodeProviders = [];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false }), {
      status: 503, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(ProviderOAuthList);
    await page.getByRole('button', { name: 'Retry' }).click();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/setup/opencode/ensure', expect.anything(),
    ));
  });
});
