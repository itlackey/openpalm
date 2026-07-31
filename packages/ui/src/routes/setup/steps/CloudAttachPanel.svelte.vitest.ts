/**
 * CloudAttachPanel — the "found on this computer" branch is reachable (W4).
 *
 * `credentialCount`/`cloudProviders` used to be hardcoded to 0/[], making the
 * `#btn-host-import` branch statically unreachable regardless of real host
 * detection — the setup recommendation copy told users to click a button
 * that could never render. `credentialCount` now reads the store's real
 * `hostProviderCount` (from GET /api/setup/host-status).
 */
import { afterEach, describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import CloudAttachPanel from './CloudAttachPanel.svelte';
import { setupState } from '$lib/setup/setup-state.svelte.js';

afterEach(() => {
  setupState.reset();
});

describe('CloudAttachPanel — host-account detection', () => {
  test('a detected host account shows the "Use this account" button', async () => {
    setupState.hostProviderCount = 1;

    render(CloudAttachPanel);

    await expect.element(page.getByText(/we found an ai account on this computer/i)).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Use this account' })).toBeVisible();
  });

  test('clicking it triggers the real host import', async () => {
    setupState.hostProviderCount = 1;

    render(CloudAttachPanel);
    await page.getByRole('button', { name: 'Use this account' }).click();

    await expect.element(page.getByText(/connecting your ai account/i)).toBeVisible();
  });

  test('no detected host account goes straight to sign-in, with no dead button', async () => {
    setupState.hostProviderCount = 0;

    render(CloudAttachPanel);

    await expect.element(page.getByText(/sign in to your ai service/i)).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Use this account' })).not.toBeInTheDocument();
  });
});
