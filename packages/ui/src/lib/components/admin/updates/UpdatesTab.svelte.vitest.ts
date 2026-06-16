import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import UpdatesTab from './UpdatesTab.svelte';

const launchOnLoginStatus = vi.fn<() => Promise<{ supported: boolean; enabled: boolean }>>();
const setLaunchOnLogin = vi.fn<(enabled: boolean) => Promise<{ supported: boolean; enabled: boolean }>>();

const defaultProps = {
  // Control plane (what the user opted into) = rc.4; the stack still runs the
  // stable 0.11.5 image — exactly the "services behind the control plane" case.
  currentImageTag: '0.11.5',
  platformVersion: '0.12.0-rc.4',
  services: [
    { id: 'assistant', label: 'Assistant', version: '0.11.5' },
    { id: 'guardian', label: 'Guardian', version: '0.11.5' },
    { id: 'portal', label: 'Chat (Discord/Slack)', version: '0.11.5' },
  ],
  harnessUpdateAvailable: false,
  selectedImageTag: '0.11.5',
  tagChangeLoading: false,
  anyDangerousLoading: false,
  tokenStored: true,
  upgradeLoading: false,
  inElectron: true,
  electronVersion: '0.12.0-rc.4',
  electronLatestVersion: null,
  electronLatestUrl: null,
  uiVersion: '0.12.0-rc.4',
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

describe('UpdatesTab control-plane version handling', () => {
  beforeEach(() => {
    // The version logic doesn't touch the Electron bridge, but onMount calls it.
    window.openpalm = {
      launchOnLoginStatus: vi.fn().mockResolvedValue({ supported: false, enabled: false }),
      setLaunchOnLogin: vi.fn(),
    };
  });

  test('reports the channel from the control plane (rc.4 ⇒ prerelease), not the stable stack tag', async () => {
    render(UpdatesTab, { props: defaultProps });
    // platformVersion 0.12.0-rc.4 ⇒ prerelease channel, even though the stack
    // image tag (0.11.5) is stable. The old code keyed off the stable tag and
    // wrongly said "stable".
    await expect.element(page.getByText(/you're on the/i)).toBeVisible();
    await expect.element(page.getByText(/prerelease/i).first()).toBeVisible();
  });

  test('renders every configured stack service', async () => {
    render(UpdatesTab, { props: defaultProps });
    await expect.element(page.getByText('Assistant', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Guardian', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Chat (Discord/Slack)', { exact: true })).toBeVisible();
  });

  test('a service behind the control plane shows update-available, never a green up-to-date', async () => {
    render(UpdatesTab, { props: defaultProps });
    // Assistant on 0.11.5 is behind the 0.12.0-rc.4 control plane → an
    // "Update available" affordance for it.
    await expect.element(page.getByText('Update to 0.12.0-rc.4').first()).toBeVisible();
    // ...and NO "Up to date" status badge anywhere (the misleading green ✅).
    expect(document.body.querySelector('[title="Up to date"]')).toBeNull();
  });

  test('the primary card prompts to update the services to the control-plane version', async () => {
    render(UpdatesTab, { props: defaultProps });
    await expect.element(
      page.getByText(/your services are on 0\.11\.5 — update to 0\.12\.0-rc\.4/i),
    ).toBeVisible();
  });

  test('when every service matches the control plane it reads up to date', async () => {
    render(UpdatesTab, {
      props: {
        ...defaultProps,
        services: [
          { id: 'assistant', label: 'Assistant', version: '0.12.0-rc.4' },
          { id: 'guardian', label: 'Guardian', version: '0.12.0-rc.4' },
        ],
      },
    });
    await expect.element(page.getByText(/you're up to date/i)).toBeVisible();
  });
});

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
