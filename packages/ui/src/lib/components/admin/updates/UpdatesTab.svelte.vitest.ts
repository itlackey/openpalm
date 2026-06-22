/**
 * UpdatesTab component tests.
 *
 * The Versions tab has two modes:
 *  - Automatic (default): "Check for updates" → comparison table → "Update N components".
 *  - Manual: individual text inputs for every image tag / npm range, with an Apply button.
 *
 * The Electron launch-on-login section uses the window.openpalm bridge directly.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

vi.mock('$lib/api.js', () => ({
  fetchVersions: vi.fn(),
  fetchLatestVersions: vi.fn(),
  patchVersions: vi.fn(),
  applyChanges: vi.fn(),
  downloadUiVersion: vi.fn(),
}));

import UpdatesTab from './UpdatesTab.svelte';
import { fetchVersions, fetchLatestVersions, patchVersions, applyChanges } from '$lib/api.js';

const ALL_VERSIONS = {
  OP_ASSISTANT_VERSION: 'latest',
  OP_GUARDIAN_VERSION: 'latest',
  OP_PORTAL_VERSION: 'latest',
  OP_VOICE_VERSION: 'latest',
};

beforeEach(() => {
  // Reset mock call counts so tests don't bleed into each other.
  vi.clearAllMocks();

  vi.mocked(fetchVersions).mockResolvedValue({ versions: { ...ALL_VERSIONS }, platformVersion: '0.12.20', autoUpdate: true });
  vi.mocked(fetchLatestVersions).mockResolvedValue({
    versions: {
      OP_ASSISTANT_VERSION: '0.12.22',
      OP_GUARDIAN_VERSION: '0.12.22',
      OP_PORTAL_VERSION: '0.12.22',
      OP_VOICE_VERSION: '0.12.22',
    },
    errors: [],
    fetchedAt: '2026-06-21T00:00:00Z',
  });
  vi.mocked(patchVersions).mockResolvedValue({ ok: true, versions: { ...ALL_VERSIONS } });
  vi.mocked(applyChanges).mockResolvedValue({
    ok: true,
    restarted: ['assistant'],
    failed: [],
    dockerAvailable: true,
    overallSuccess: true,
  });
  window.openpalm = {
    launchOnLoginStatus: vi.fn().mockResolvedValue({ supported: false, enabled: false }),
    setLaunchOnLogin: vi.fn(),
  };
});

describe('UpdatesTab — header', () => {
  test('shows the control-plane version from the endpoint', async () => {
    render(UpdatesTab, { props: {} });
    await expect.element(page.getByText('0.12.20')).toBeVisible();
  });

  test('shows the Automatic / Manual mode toggle', async () => {
    render(UpdatesTab, { props: {} });
    await expect.element(page.getByRole('button', { name: 'Automatic' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Manual' })).toBeVisible();
  });
});

describe('UpdatesTab — automatic mode', () => {
  test('shows "Check for updates" button in auto mode', async () => {
    render(UpdatesTab, { props: {} });
    await expect.element(page.getByRole('button', { name: /check for updates/i })).toBeVisible();
  });

  test('calls fetchLatestVersions on check and reveals re-check button', async () => {
    render(UpdatesTab, { props: {} });
    await page.getByRole('button', { name: /check for updates/i }).click();

    await vi.waitFor(() => {
      expect(fetchLatestVersions).toHaveBeenCalledTimes(1);
    });

    // After a successful check, the "Re-check" button becomes visible.
    await expect.element(page.getByRole('button', { name: /re-check/i })).toBeVisible();
  });

  test('shows "Update N components" button after check finds updates', async () => {
    render(UpdatesTab, { props: {} });
    await page.getByRole('button', { name: /check for updates/i }).click();

    await vi.waitFor(async () => {
      await expect.element(page.getByRole('button', { name: /update \d+ component/i })).toBeVisible();
    });
  });

  test('calls patchVersions + applyChanges with the latest resolved versions', async () => {
    render(UpdatesTab, { props: {} });
    await page.getByRole('button', { name: /check for updates/i }).click();

    const updateBtn = page.getByRole('button', { name: /update \d+ component/i });
    await expect.element(updateBtn).toBeVisible();
    await updateBtn.click();

    await vi.waitFor(() => {
      expect(patchVersions).toHaveBeenCalledTimes(1);
    });
    expect(applyChanges).toHaveBeenCalledTimes(1);
    // The patch should include the latest versions returned by the mock
    const patchArg = vi.mocked(patchVersions).mock.calls[0][0];
    expect(patchArg['OP_ASSISTANT_VERSION']).toBe('0.12.22');
  });

  test('shows "up to date" when latest matches current', async () => {
    // Return latest == current for all keys
    vi.mocked(fetchLatestVersions).mockResolvedValue({
      versions: { ...ALL_VERSIONS },
      errors: [],
      fetchedAt: '2026-06-21T00:00:00Z',
    });
    render(UpdatesTab, { props: {} });
    await page.getByRole('button', { name: /check for updates/i }).click();

    await vi.waitFor(async () => {
      await expect.element(page.getByText(/everything is up to date/i)).toBeVisible();
    });
  });

  test('shows registry error messages when some checks fail', async () => {
    vi.mocked(fetchLatestVersions).mockResolvedValue({
      versions: { ...ALL_VERSIONS, OP_ASSISTANT_VERSION: null },
      errors: ['GitHub releases unavailable'],
      fetchedAt: '2026-06-21T00:00:00Z',
    });
    render(UpdatesTab, { props: {} });
    await page.getByRole('button', { name: /check for updates/i }).click();

    await vi.waitFor(async () => {
      await expect.element(page.getByText(/github releases unavailable/i)).toBeVisible();
    });
  });
});


describe('UpdatesTab — manual mode', () => {
  async function switchToManual() {
    await page.getByRole('button', { name: 'Manual' }).click();
  }

  test('renders a labelled input for every container image version in manual mode', async () => {
    render(UpdatesTab, { props: {} });
    await switchToManual();
    await expect.element(page.getByLabelText('Assistant', { exact: true })).toBeVisible();
    await expect.element(page.getByLabelText('Guardian', { exact: true })).toBeVisible();
    await expect.element(page.getByLabelText('Portal (Discord/Slack/API)', { exact: true })).toBeVisible();
    await expect.element(page.getByLabelText('Voice', { exact: true })).toBeVisible();
  });

  test('the Apply button is disabled until a value changes', async () => {
    render(UpdatesTab, { props: {} });
    await switchToManual();
    const apply = page.getByRole('button', { name: /^apply$/i });
    await expect.element(apply).toBeDisabled();
  });

  test('patches only the changed version keys, then recreates the stack', async () => {
    render(UpdatesTab, { props: {} });
    await switchToManual();

    const assistantInput = page.getByLabelText('Assistant', { exact: true });
    await expect.element(assistantInput).toBeVisible();
    await assistantInput.fill('v0.12.18');

    const apply = page.getByRole('button', { name: /^apply$/i });
    await expect.element(apply).toBeEnabled();
    await apply.click();

    await vi.waitFor(() => {
      expect(patchVersions).toHaveBeenCalledWith({ OP_ASSISTANT_VERSION: 'v0.12.18' });
    });
    expect(applyChanges).toHaveBeenCalledTimes(1);
    await expect.element(page.getByText(/versions applied/i)).toBeVisible();
  });

  test('surfaces a load error when the versions fetch fails', async () => {
    vi.mocked(fetchVersions).mockRejectedValue(new Error('boom'));
    render(UpdatesTab, { props: {} });
    await expect.element(page.getByText(/failed to load versions/i)).toBeVisible();
  });
});

describe('UpdatesTab — launch on login', () => {
  test('shows the current launch-on-login state when Electron supports it', async () => {
    window.openpalm = {
      launchOnLoginStatus: vi.fn().mockResolvedValue({ supported: true, enabled: true }),
      setLaunchOnLogin: vi.fn(),
    };
    render(UpdatesTab, { props: {} });
    const toggle = page.getByRole('checkbox', { name: /start openpalm automatically when you sign in/i });
    await expect.element(toggle).toBeChecked();
    await expect.element(page.getByText(/uses the native desktop login-item integration/i)).toBeVisible();
  });

  test('writes the updated launch-on-login value through the Electron bridge', async () => {
    const setLaunchOnLogin = vi.fn().mockResolvedValue({ supported: true, enabled: true });
    window.openpalm = {
      launchOnLoginStatus: vi.fn().mockResolvedValue({ supported: true, enabled: false }),
      setLaunchOnLogin,
    };
    render(UpdatesTab, { props: {} });
    const toggle = page.getByRole('checkbox', { name: /start openpalm automatically when you sign in/i });
    await toggle.click();
    expect(setLaunchOnLogin).toHaveBeenCalledWith(true);
    await expect.element(toggle).toBeChecked();
  });
});
