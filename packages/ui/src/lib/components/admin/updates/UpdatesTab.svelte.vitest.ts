import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import UpdatesTab from './UpdatesTab.svelte';

const launchOnLoginStatus = vi.fn<() => Promise<{ supported: boolean; enabled: boolean }>>();
const setLaunchOnLogin = vi.fn<(enabled: boolean) => Promise<{ supported: boolean; enabled: boolean }>>();

const defaultProps = {
  currentImageTag: '0.11.5-rc.1',
  selectedImageTag: '0.11.5-rc.1',
  tagChangeLoading: false,
  anyDangerousLoading: false,
  tokenStored: true,
  upgradeLoading: false,
  inElectron: true,
  electronVersion: '0.11.5-rc.1',
  electronLatestVersion: null,
  electronLatestUrl: null,
  uiVersion: '0.11.5-rc.1',
  uiVersions: [],
  uiVersionsLoading: false,
  selectedUiTag: '',
  uiDownloadLoading: false,
  uiDownloadReady: false,
  uiDownloadRestarting: false,
  releases: [],
  releasesLoading: false,
  onSetImageTag: vi.fn(),
  onSelectedImageTagChange: vi.fn(),
  onUpgradeStack: vi.fn(),
  onSelectedUiTagChange: vi.fn(),
  onDownloadUiVersion: vi.fn(),
  onRestartApp: vi.fn(),
  onRefreshReleases: vi.fn(),
};

describe('UpdatesTab launch-on-login', () => {
  beforeEach(() => {
    launchOnLoginStatus.mockReset();
    setLaunchOnLogin.mockReset();
    window.openpalm = {
      launchOnLoginStatus,
      setLaunchOnLogin,
    };
  });

  test('shows the current launch-on-login state when Electron supports it', async () => {
    launchOnLoginStatus.mockResolvedValue({ supported: true, enabled: true });

    render(UpdatesTab, { props: defaultProps });
    await page.getByText(/advanced options/i).click();

    const toggle = page.getByRole('checkbox', { name: /start openpalm automatically when you sign in/i });
    await expect.element(toggle).toBeChecked();
    await expect.element(page.getByText(/uses the native desktop login-item integration/i)).toBeVisible();
  });

  test('shows the unsupported-platform message when launch-on-login is unavailable', async () => {
    launchOnLoginStatus.mockResolvedValue({ supported: false, enabled: false });

    render(UpdatesTab, { props: defaultProps });
    await page.getByText(/advanced options/i).click();

    const toggle = page.getByRole('checkbox', { name: /start openpalm automatically when you sign in/i });
    await expect.element(toggle).toBeDisabled();
    await expect.element(page.getByText(/not wired on this platform yet/i)).toBeVisible();
  });

  test('writes the updated launch-on-login value through the Electron bridge', async () => {
    launchOnLoginStatus.mockResolvedValue({ supported: true, enabled: false });
    setLaunchOnLogin.mockResolvedValue({ supported: true, enabled: true });

    render(UpdatesTab, { props: defaultProps });
    await page.getByText(/advanced options/i).click();

    const toggle = page.getByRole('checkbox', { name: /start openpalm automatically when you sign in/i });
    await toggle.click();

    expect(setLaunchOnLogin).toHaveBeenCalledWith(true);
    await expect.element(toggle).toBeChecked();
  });
});
