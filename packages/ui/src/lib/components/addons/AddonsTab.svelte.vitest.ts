import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

const mocks = vi.hoisted(() => ({
  fetchAddonCredentials: vi.fn(async () => []),
  fetchAddons: vi.fn(async () => ({
    addons: [{ name: 'voice', enabled: true, available: true }],
    voice: { profiles: [], selectedProfile: null },
  })),
}));

vi.mock('$lib/api.js', () => ({
  fetchAddons: mocks.fetchAddons,
  fetchAddonCredentials: mocks.fetchAddonCredentials,
  fetchSecretFile: vi.fn(),
  fetchSecretFiles: vi.fn(),
  saveAddonCredentials: vi.fn(),
  saveSecretFile: vi.fn(),
  saveVoiceProfile: vi.fn(),
  toggleAddon: vi.fn(),
}));

vi.mock('$lib/voice/providers.js', () => ({
  refreshAdvertisedVoiceUrl: vi.fn(),
}));

import AddonsTab from './AddonsTab.svelte';

describe('AddonsTab deep links', () => {
  test('opens the Voice capability when requested by the host URL', async () => {
    render(AddonsTab, {
      onAuthError: vi.fn(),
      focusAddon: 'voice',
    });

    await expect.element(page.getByRole('dialog', { name: 'Voice settings' })).toBeVisible();
    expect(mocks.fetchAddonCredentials).toHaveBeenCalledWith('voice');
  });
});
