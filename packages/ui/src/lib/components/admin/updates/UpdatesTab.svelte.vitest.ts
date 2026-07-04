/**
 * UpdatesTab component tests (Phase 6 rebuild).
 *
 * The Updates tab shows per-component rows with running/pin/available columns
 * and granular "Update <container>", "Update UI", "Update everything" buttons.
 * No auto/manual mode split. Errors appear in context.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

vi.mock('$lib/api.js', () => ({
  fetchVersions: vi.fn(),
  patchVersions: vi.fn(),
  applyChanges: vi.fn(),
  applyServiceUpdate: vi.fn(),
  downloadUiVersion: vi.fn(),
}));

import UpdatesTab from './UpdatesTab.svelte';
import {
  fetchVersions,
  patchVersions,
  applyChanges,
  applyServiceUpdate,
  downloadUiVersion,
} from '$lib/api.js';

const MOCK_COMPONENT_RUNNING = (version: string) => ({
  digest: `sha256:abc${version}`,
  tag: `openpalm/assistant:${version}`,
  plainVersion: version,
  healthStatus: 'healthy',
  containerState: 'running',
});

function makeVersionsResponse(opts: {
  runningVersion?: string;
  pinnedVersion?: string | null;
  availableVersion?: string | null;
} = {}) {
  const { runningVersion = '0.12.20', pinnedVersion = null, availableVersion = null } = opts;
  const info = {
    running: MOCK_COMPONENT_RUNNING(runningVersion),
    pinned: pinnedVersion,
    available: availableVersion,
  };
  return {
    components: {
      OP_ASSISTANT_VERSION: info,
      OP_GUARDIAN_VERSION: info,
      OP_PORTAL_VERSION: info,
      OP_VOICE_VERSION: info,
    },
    channel: 'latest' as const,
    platformVersion: '0.12.20',
    versions: {
      OP_ASSISTANT_VERSION: runningVersion,
      OP_GUARDIAN_VERSION: runningVersion,
      OP_PORTAL_VERSION: runningVersion,
      OP_VOICE_VERSION: runningVersion,
    },
    autoUpdate: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(fetchVersions).mockResolvedValue(makeVersionsResponse());
  vi.mocked(patchVersions).mockResolvedValue({ ok: true, versions: {} });
  vi.mocked(applyChanges).mockResolvedValue({
    ok: true,
    restarted: ['assistant', 'guardian'],
    failed: [],
    dockerAvailable: true,
    overallSuccess: true,
  });
  vi.mocked(applyServiceUpdate).mockResolvedValue({
    ok: true,
    restarted: ['assistant'],
    failed: [],
    dockerAvailable: true,
    overallSuccess: true,
  });
  vi.mocked(downloadUiVersion).mockResolvedValue({
    ok: true,
    tag: '0.12.22',
    restarting: false,
    pendingRestart: false,
  });
  window.openpalm = {
    launchOnLoginStatus: vi.fn().mockResolvedValue({ supported: false, enabled: false }),
    setLaunchOnLogin: vi.fn(),
  };
});

describe('UpdatesTab — header', () => {
  test('shows the control-plane version', async () => {
    render(UpdatesTab, { props: {} });
    // The version appears in the control-plane line (strong element)
    await expect.element(page.getByRole('strong').first()).toBeVisible();
    await expect.element(page.getByText('0.12.20').first()).toBeVisible();
  });

  test('shows "Update everything" button', async () => {
    render(UpdatesTab, { props: {} });
    await expect.element(page.getByRole('button', { name: /update everything/i })).toBeVisible();
  });

  test('shows "Update UI" button', async () => {
    render(UpdatesTab, { props: {} });
    await expect.element(page.getByRole('button', { name: /update ui/i })).toBeVisible();
  });
});

describe('UpdatesTab — component table', () => {
  test('shows a row for every component', async () => {
    render(UpdatesTab, { props: {} });
    await expect.element(page.getByText('Assistant')).toBeVisible();
    await expect.element(page.getByText('Guardian')).toBeVisible();
    await expect.element(page.getByText('Portal')).toBeVisible();
    await expect.element(page.getByText('Voice')).toBeVisible();
  });

  test('shows the running version for each component', async () => {
    render(UpdatesTab, { props: {} });
    // Running version appears in the table (may appear multiple times across rows)
    const cells = page.getByText('0.12.20');
    await expect.element(cells.first()).toBeVisible();
  });

  test('shows "latest (tracking)" for unpinned components', async () => {
    render(UpdatesTab, { props: {} });
    const chips = page.getByText(/latest \(tracking\)/i);
    await expect.element(chips.first()).toBeVisible();
  });

  test('shows pinned version when a pin is set', async () => {
    vi.mocked(fetchVersions).mockResolvedValue(makeVersionsResponse({ pinnedVersion: '0.11.0' }));
    render(UpdatesTab, { props: {} });
    await expect.element(page.getByText('0.11.0').first()).toBeVisible();
  });
});

describe('UpdatesTab — "Update everything" action', () => {
  test('calls applyChanges and shows success message', async () => {
    render(UpdatesTab, { props: {} });
    await page.getByRole('button', { name: /update everything/i }).click();

    await vi.waitFor(() => {
      expect(applyChanges).toHaveBeenCalledTimes(1);
    });

    await expect.element(page.getByText(/updated:/i)).toBeVisible();
  });

  test('shows error message in context when applyChanges fails', async () => {
    vi.mocked(applyChanges).mockResolvedValue({
      ok: false,
      restarted: [],
      failed: [{ service: 'assistant', reason: 'manifest unknown: openpalm/assistant:99.0.0' }],
      dockerAvailable: true,
      overallSuccess: false,
    });
    render(UpdatesTab, { props: {} });
    await page.getByRole('button', { name: /update everything/i }).click();

    await vi.waitFor(async () => {
      await expect.element(page.getByText(/manifest unknown/i)).toBeVisible();
    });
  });

  test('shows Docker-unavailable message in context', async () => {
    vi.mocked(applyChanges).mockResolvedValue({
      ok: false,
      restarted: [],
      failed: [],
      dockerAvailable: false,
      overallSuccess: false,
    });
    render(UpdatesTab, { props: {} });
    await page.getByRole('button', { name: /update everything/i }).click();

    await vi.waitFor(async () => {
      await expect.element(page.getByText(/docker is unavailable/i)).toBeVisible();
    });
  });
});

describe('UpdatesTab — per-component update action', () => {
  test('calls applyServiceUpdate for the correct service and shows success', async () => {
    render(UpdatesTab, { props: {} });

    // The Assistant row has aria-label="Update Assistant"
    await page.getByRole('button', { name: 'Update Assistant' }).click();

    await vi.waitFor(() => {
      expect(applyServiceUpdate).toHaveBeenCalledTimes(1);
    });
    // Should have called with 'assistant' (first row)
    expect(vi.mocked(applyServiceUpdate).mock.calls[0][0]).toBe('assistant');
  });

  test('shows in-row error when single-service update fails', async () => {
    vi.mocked(applyServiceUpdate).mockResolvedValue({
      ok: false,
      restarted: [],
      failed: [{ service: 'assistant', reason: 'pull access denied: openpalm/assistant' }],
      dockerAvailable: true,
      overallSuccess: false,
    });
    render(UpdatesTab, { props: {} });

    await page.getByRole('button', { name: 'Update Assistant' }).click();

    await vi.waitFor(async () => {
      await expect.element(page.getByText(/pull access denied/i)).toBeVisible();
    });
  });

  test('updating one service does not call applyChanges (scoped, §4)', async () => {
    render(UpdatesTab, { props: {} });
    await page.getByRole('button', { name: 'Update Assistant' }).click();

    await vi.waitFor(() => {
      expect(applyServiceUpdate).toHaveBeenCalledTimes(1);
    });
    expect(applyChanges).not.toHaveBeenCalled();
  });
});

describe('UpdatesTab — pin editing (inline, no splash — §4.1)', () => {
  test('clicking pin chip opens the inline editor', async () => {
    render(UpdatesTab, { props: {} });

    // Click the first pin chip
    const chips = page.getByTitle(/edit pin for/i);
    await chips.first().click();

    // Inline input should appear
    await expect.element(page.getByRole('textbox', { name: /pin version for assistant/i })).toBeVisible();
  });

  test('saving a pin calls patchVersions without triggering a splash', async () => {
    render(UpdatesTab, { props: {} });

    const chips = page.getByTitle(/edit pin for/i);
    await chips.first().click();

    const input = page.getByRole('textbox', { name: /pin version for assistant/i });
    await input.fill('0.12.18');

    const saveBtn = page.getByRole('button', { name: /save/i }).first();
    await saveBtn.click();

    await vi.waitFor(() => {
      expect(patchVersions).toHaveBeenCalledWith({ OP_ASSISTANT_VERSION: '0.12.18' });
    });
  });

  test('clicking Cancel cancels pin editing without saving', async () => {
    render(UpdatesTab, { props: {} });
    const chips = page.getByTitle(/edit pin for/i);
    await chips.first().click();

    const input = page.getByRole('textbox', { name: /pin version for assistant/i });
    await input.fill('0.11.0');

    const cancelBtn = page.getByRole('button', { name: /cancel/i }).first();
    await cancelBtn.click();

    // Input should be gone
    await expect.element(input).not.toBeInTheDocument();
    expect(patchVersions).not.toHaveBeenCalled();
  });

  test('clearing the pin input and saving sends "latest" (unpin)', async () => {
    vi.mocked(fetchVersions).mockResolvedValue(makeVersionsResponse({ pinnedVersion: '0.11.0' }));
    render(UpdatesTab, { props: {} });

    const chips = page.getByTitle(/edit pin for/i);
    await chips.first().click();

    const input = page.getByRole('textbox', { name: /pin version for assistant/i });
    await input.fill('');

    const saveBtn = page.getByRole('button', { name: /save/i }).first();
    await saveBtn.click();

    await vi.waitFor(() => {
      // Empty = unpin = "latest"
      expect(patchVersions).toHaveBeenCalledWith({ OP_ASSISTANT_VERSION: 'latest' });
    });
  });
});

describe('UpdatesTab — UI update', () => {
  test('clicking "Update UI" triggers downloadUiVersion', async () => {
    render(UpdatesTab, { props: {} });
    await page.getByRole('button', { name: /update ui/i }).click();

    await vi.waitFor(() => {
      expect(downloadUiVersion).toHaveBeenCalledTimes(1);
    });
  });

  test('a pendingRestart triggers the Electron harness restart', async () => {
    vi.mocked(downloadUiVersion).mockResolvedValue({
      ok: true,
      tag: '0.12.22',
      restarting: false,
      pendingRestart: true,
    });
    window.openpalm = {
      launchOnLoginStatus: vi.fn().mockResolvedValue({ supported: false, enabled: false }),
      setLaunchOnLogin: vi.fn(),
      restartUiServer: vi.fn().mockResolvedValue(true),
    };
    render(UpdatesTab, { props: {} });
    await page.getByRole('button', { name: /update ui/i }).click();

    await vi.waitFor(() => {
      expect(downloadUiVersion).toHaveBeenCalledTimes(1);
    });
    expect(window.openpalm?.restartUiServer).toHaveBeenCalledTimes(1);
  });
});

describe('UpdatesTab — load error', () => {
  test('surfaces a load error when the versions fetch fails', async () => {
    vi.mocked(fetchVersions).mockRejectedValue(new Error('network error'));
    render(UpdatesTab, { props: {} });
    await expect.element(page.getByText(/failed to load versions/i)).toBeVisible();
  });
});

describe('UpdatesTab — launch on login (Electron)', () => {
  test('shows the current launch-on-login state when Electron supports it', async () => {
    window.openpalm = {
      launchOnLoginStatus: vi.fn().mockResolvedValue({ supported: true, enabled: true }),
      setLaunchOnLogin: vi.fn(),
    };
    render(UpdatesTab, { props: {} });
    const toggle = page.getByRole('checkbox', { name: /start openpalm automatically when you sign in/i });
    await expect.element(toggle).toBeChecked();
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
  });
});
