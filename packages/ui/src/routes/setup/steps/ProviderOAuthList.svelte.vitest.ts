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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function showActiveOAuth(method: 'auto' | 'code'): void {
  setupState.opencodeAvailable = true;
  setupState.opencodeProviders = [{ id: 'openai', name: 'OpenAI' }];
  setupState.opencodeAuth = { openai: [{ type: 'oauth', label: 'OAuth' }] };
  setupState.providerState = {
    openai: {
      selected: true,
      verified: false,
      verifying: false,
      error: false,
      apiKey: '',
      baseUrl: '',
      models: [],
      ollamaMode: null,
      oauthPolling: true,
      oauthMethod: method,
      oauthUrl: 'https://provider.test/authorize',
      oauthInstructions: 'Complete authorization with the provider.',
    },
  };
}

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

describe('ProviderOAuthList - OAuth mode UI', () => {
  test('browser-auto flow shows polling without an authorization-code input', async () => {
    showActiveOAuth('auto');

    render(ProviderOAuthList);

    await expect.element(page.getByText(/waiting for authorization/i)).toBeVisible();
    await expect.element(page.getByRole('textbox', { name: /authorization code/i })).not.toBeInTheDocument();
  });

  test('code flow stays visible and submits through the setup store', async () => {
    showActiveOAuth('code');
    const submit = vi.spyOn(setupState, 'submitOpenCodeOAuthCode').mockResolvedValue();

    render(ProviderOAuthList);
    const input = page.getByRole('textbox', { name: 'OpenAI authorization code' });
    await expect.element(input).toBeVisible();
    await expect.element(page.getByText(/waiting for authorization/i)).not.toBeInTheDocument();

    await input.fill('provider-code');
    await page.getByRole('button', { name: 'Submit code' }).click();

    expect(submit).toHaveBeenCalledWith('openai', 0, 'provider-code');
    await expect.element(input).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });
});
