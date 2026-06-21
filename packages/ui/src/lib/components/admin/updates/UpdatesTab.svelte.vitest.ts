/**
 * UpdatesTab component tests.
 *
 * The Versions tab self-fetches GET /admin/versions on mount, renders two
 * groups of plain text inputs (container image tags + npm package pins), and
 * applies changes via PATCH /admin/versions + POST /admin/update. The Electron
 * launch-on-login section uses the window.openpalm bridge directly.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

vi.mock('$lib/api.js', () => ({
  fetchVersions: vi.fn(),
  patchVersions: vi.fn(),
  applyChanges: vi.fn(),
  downloadUiVersion: vi.fn(),
}));

import UpdatesTab from './UpdatesTab.svelte';
import { fetchVersions, patchVersions, applyChanges } from '$lib/api.js';

const ALL_VERSIONS = {
  OP_ASSISTANT_VERSION: 'latest',
  OP_GUARDIAN_VERSION: 'latest',
  OP_PORTAL_VERSION: 'latest',
  OP_VOICE_VERSION: 'latest',
  OP_GUARDIAN_NPM_VERSION: '',
  OP_TOOL_OPENCODE_VERSION: '^1.17.0',
  OP_TOOL_AKM_VERSION: '^0.8.14',
  OP_TOOL_CLAUDE_CODE_VERSION: '^1.5.0',
  OP_TOOL_CODEX_VERSION: '^0.1.0',
};

beforeEach(() => {
  vi.mocked(fetchVersions).mockResolvedValue({ versions: { ...ALL_VERSIONS }, platformVersion: '0.12.20' });
  vi.mocked(patchVersions).mockResolvedValue({ ok: true, versions: { ...ALL_VERSIONS } });
  vi.mocked(applyChanges).mockResolvedValue({
    ok: true,
    restarted: ['assistant'],
    failed: [],
    dockerAvailable: true,
    overallSuccess: true,
  });
  // The component checks for the Electron bridge on mount.
  window.openpalm = {
    launchOnLoginStatus: vi.fn().mockResolvedValue({ supported: false, enabled: false }),
    setLaunchOnLogin: vi.fn(),
  };
});

describe('UpdatesTab — version sections', () => {
  test('shows the control-plane version from the endpoint', async () => {
    render(UpdatesTab, { props: {} });
    await expect.element(page.getByText('0.12.20')).toBeVisible();
  });

  test('renders a labelled input for every container image version', async () => {
    render(UpdatesTab, { props: {} });
    await expect.element(page.getByLabelText('Assistant', { exact: true })).toBeVisible();
    await expect.element(page.getByLabelText('Guardian', { exact: true })).toBeVisible();
    await expect.element(page.getByLabelText('Portal (Discord/Slack/API)', { exact: true })).toBeVisible();
    await expect.element(page.getByLabelText('Voice', { exact: true })).toBeVisible();
  });

  test('renders a labelled input for every npm package pin', async () => {
    render(UpdatesTab, { props: {} });
    await expect.element(page.getByLabelText('OpenCode')).toBeVisible();
    await expect.element(page.getByLabelText('AKM CLI')).toBeVisible();
    await expect.element(page.getByLabelText('Claude Code')).toBeVisible();
    await expect.element(page.getByLabelText('Codex')).toBeVisible();
    await expect.element(page.getByLabelText('Guardian package')).toBeVisible();
  });

  test('the Apply button is disabled until a value changes', async () => {
    render(UpdatesTab, { props: {} });
    const apply = page.getByRole('button', { name: /^apply$/i });
    await expect.element(apply).toBeDisabled();
  });
});

describe('UpdatesTab — apply', () => {
  test('patches only the changed version keys, then recreates the stack', async () => {
    render(UpdatesTab, { props: {} });

    const assistantInput = page.getByLabelText('Assistant', { exact: true });
    await expect.element(assistantInput).toBeVisible();
    // Replace the value with a concrete tag.
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
