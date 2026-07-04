/**
 * ProvidersPanel component regression tests.
 *
 * Guards the raw-error-text bug (removed pageState.error display):
 *  - When available=false: shows the human-readable "assistant not reachable" message
 *  - Never shows raw "fetch failed" or "[object Object]" strings
 *  - When available=true: shows provider list, not the unavailable message
 */
import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ProvidersPanel from './ProvidersPanel.svelte';

const unavailableResponse = {
  available: false,
  providers: [],
  defaultModels: {},
  allowlistActive: false,
  providerCountLabel: '',
  stats: { total: 0, connected: 0, configured: 0, disabled: 0 },
};

const availableResponse = {
  available: true,
  providers: [
    { id: 'openai', name: 'OpenAI', connected: true, enabled: true, credentialType: 'api', models: [] },
  ],
  defaultModels: {},
  allowlistActive: false,
  providerCountLabel: '1 provider',
  stats: { total: 1, connected: 1, configured: 1, disabled: 0 },
};

function mockFetch(body: object, ok = true) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  }));
}

describe('ProvidersPanel — assistant unavailable', () => {
  test('shows human-readable unavailability message when available=false', async () => {
    mockFetch(unavailableResponse);
    render(ProvidersPanel);

    await expect.element(
      page.getByText(/The assistant \(OpenCode server\) is not reachable/i),
      { timeout: 5000 }
    ).toBeVisible();
  });

  test('never shows raw "fetch failed" string', async () => {
    mockFetch(unavailableResponse);
    render(ProvidersPanel);

    await expect.element(page.getByText(/fetch failed/i)).not.toBeInTheDocument();
  });

  test('never shows "[object Object]" string', async () => {
    mockFetch(unavailableResponse);
    render(ProvidersPanel);

    await expect.element(page.getByText(/\[object Object\]/i)).not.toBeInTheDocument();
  });
});

describe('ProvidersPanel — assistant available', () => {
  test('shows provider name when available=true', async () => {
    mockFetch(availableResponse);
    render(ProvidersPanel);

    await expect.element(page.getByText(/OpenAI/i), { timeout: 5000 }).toBeVisible();
    await expect.element(
      page.getByText(/The assistant \(OpenCode server\) is not reachable/i)
    ).not.toBeInTheDocument();
  });
});

describe('ProvidersPanel — disconnect confirmation', () => {
  test('Disconnect shows an in-DOM confirm dialog instead of native confirm()', async () => {
    // If the code still used window.confirm, this stub would throw when called.
    const confirmSpy = vi.fn(() => {
      throw new Error('native confirm() must not be used');
    });
    vi.stubGlobal('confirm', confirmSpy);
    mockFetch(availableResponse);
    render(ProvidersPanel);

    await page.getByRole('button', { name: 'Disconnect' }).click();

    await expect.element(
      page.getByText(/Stored credentials will be removed/i),
      { timeout: 5000 }
    ).toBeVisible();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  test('Cancel dismisses the confirm dialog without disconnecting', async () => {
    mockFetch(availableResponse);
    render(ProvidersPanel);

    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect.element(
      page.getByText(/Stored credentials will be removed/i),
      { timeout: 5000 }
    ).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect.element(
      page.getByText(/Stored credentials will be removed/i)
    ).not.toBeInTheDocument();
  });
});
