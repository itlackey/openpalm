/**
 * LogsTab component regression tests.
 *
 * Guards the logsLoaded state-ambiguity bug:
 *  - Before load: "Select a service..." (not "No log output")
 *  - After load with empty logs: "No log output..." (not "Select a service...")
 *  - After load with real logs: pre element contains the log text
 */
import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import LogsTab from './LogsTab.svelte';

vi.mock('$lib/api.js', () => ({
  fetchServiceLogs: vi.fn(),
  fetchAutomationLog: vi.fn(),
}));

import { fetchServiceLogs } from '$lib/api.js';

const defaultProps = {
  services: ['assistant', 'guardian'],
  automations: ['daily-summary'],
};

describe('LogsTab — initial state', () => {
  test('shows "Select a service" prompt before any load is triggered', async () => {
    await render(LogsTab, { props: defaultProps });
    await expect.element(page.getByText(/select a service/i)).toBeVisible();
    await expect.element(page.getByText(/no log output/i)).not.toBeInTheDocument();
  });
});

describe('LogsTab — after successful load', () => {
  test('shows "No log output" when load returns empty string', async () => {
    vi.mocked(fetchServiceLogs).mockResolvedValue({ ok: true, logs: '' });

    const { getByRole } = await render(LogsTab, { props: defaultProps });
    await getByRole('button', { name: /load service logs/i }).click();

    await expect.element(page.getByText(/no log output/i)).toBeVisible();
    await expect.element(page.getByText(/select a service/i)).not.toBeInTheDocument();
  });

  test('shows log content in pre element when logs are non-empty', async () => {
    vi.mocked(fetchServiceLogs).mockResolvedValue({ ok: true, logs: 'INFO: server started\nINFO: listening on :4096' });

    await render(LogsTab, { props: defaultProps });
    await page.getByRole('button', { name: /load service logs/i }).click();

    await expect.element(page.getByText(/INFO: server started/)).toBeVisible();
    await expect.element(page.getByText(/select a service/i)).not.toBeInTheDocument();
    await expect.element(page.getByText(/no log output/i)).not.toBeInTheDocument();
  });

  test('shows error message when fetch fails', async () => {
    vi.mocked(fetchServiceLogs).mockResolvedValue({ ok: false, logs: '', error: 'service not found' });

    await render(LogsTab, { props: defaultProps });
    await page.getByRole('button', { name: /load service logs/i }).click();

    await expect.element(page.getByText(/service not found/i)).toBeVisible();
  });
});
