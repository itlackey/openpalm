import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

const mocks = vi.hoisted(() => {
  let selectedProfile = 'addon.voice.cuda';
  return {
    get selectedProfile() { return selectedProfile; },
    reset: () => { selectedProfile = 'addon.voice.cuda'; },
    fetchAddonCredentials: vi.fn(async () => []),
    fetchAddons: vi.fn(async () => ({
      addons: [{ name: 'voice', enabled: true, available: true }],
      voice: {
        profiles: [
          { id: 'addon.voice.cpu', services: ['voice'], label: 'CPU', available: true },
          { id: 'addon.voice.cuda', services: ['voice-cuda'], label: 'NVIDIA (CUDA 12.1)', available: true },
        ],
        selectedProfile,
      },
    })),
    saveVoiceProfile: vi.fn(async (profile: string) => {
      selectedProfile = profile;
      return { ok: true, status: 200 };
    }),
  };
});

vi.mock('$lib/api.js', () => ({
  fetchAddons: mocks.fetchAddons,
  fetchAddonCredentials: mocks.fetchAddonCredentials,
  fetchRemoteAccessStatus: vi.fn(async () => ({ state: 'off', message: 'Remote access is off.' })),
  fetchSecretFile: vi.fn(),
  fetchSecretFiles: vi.fn(),
  saveAddonCredentials: vi.fn(),
  saveSecretFile: vi.fn(),
  saveVoiceProfile: mocks.saveVoiceProfile,
  toggleAddon: vi.fn(),
}));

vi.mock('$lib/voice/providers.js', () => ({
  refreshAdvertisedVoiceUrl: vi.fn(),
}));

import AddonsTab from './AddonsTab.svelte';

beforeEach(() => {
  mocks.reset();
  mocks.fetchAddonCredentials.mockClear();
  mocks.fetchAddons.mockClear();
  mocks.saveVoiceProfile.mockClear();
});

describe('AddonsTab deep links', () => {
  test('opens the Voice capability when requested by the host URL', async () => {
    render(AddonsTab, {
      onAuthError: vi.fn(),
      focusAddon: 'voice',
    });

    await expect.element(page.getByRole('dialog', { name: 'Voice settings' })).toBeVisible();
    expect(mocks.fetchAddonCredentials).toHaveBeenCalledWith('voice');
  });

  test('applies a hardware profile and resynchronizes to the server selection', async () => {
    render(AddonsTab, {
      onAuthError: vi.fn(),
      focusAddon: 'voice',
    });

    const dialog = page.getByRole('dialog', { name: 'Voice settings' });
    const profile = page.getByLabelText('Profile');
    const apply = dialog.getByRole('button', { name: 'Apply profile' });
    await expect.element(profile).toHaveValue('addon.voice.cuda');
    await profile.selectOptions('addon.voice.cpu');
    await expect.element(apply).toBeEnabled();
    await apply.click();

    expect(mocks.saveVoiceProfile).toHaveBeenCalledWith('addon.voice.cpu');
    expect(mocks.selectedProfile).toBe('addon.voice.cpu');
    await expect.element(profile).toHaveValue('addon.voice.cpu');
    await expect.element(apply).toBeDisabled();
  });
});
