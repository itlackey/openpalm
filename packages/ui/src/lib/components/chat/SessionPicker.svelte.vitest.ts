/**
 * SessionPicker component tests.
 *
 * The trigger opens a Drawer (role="dialog") holding the SessionList. Mocks the
 * chat and endpoint singletons to provide controlled state.
 *
 * Tests use:
 *   - aria-expanded on the trigger as the canonical open/closed signal
 *   - the drawer dialog title to confirm open state
 *   - button text for list items (plain buttons, active = aria-current)
 */
import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { userEvent } from 'vitest/browser';

vi.mock('$lib/chat/chat-state.svelte.js', () => ({
  chat: {
    byEndpoint: new Map([
      ['default', {
        sessions: [
          { id: 'sess-1', title: 'First session', updatedAt: Date.now() - 60_000 },
          { id: 'sess-2', title: 'Second session', updatedAt: Date.now() - 3600_000 },
        ],
        sessionsLoading: false,
        sessionsLoaded: true,
        sessionsError: '',
        activeSessionId: 'sess-1',
      }],
    ]),
    activeSessionId: 'sess-1',
    activeEndpointId: 'default',
    sending: false,
    liveConnected: false,
    loadSessions: vi.fn().mockResolvedValue(undefined),
    openSession: vi.fn().mockResolvedValue(undefined),
    startNewSession: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('$lib/endpoints-state.svelte.js', () => ({
  endpointsService: {
    active: { id: 'default', label: 'Local assistant', url: 'http://127.0.0.1:3800', isDefault: true },
    activeId: 'default',
  },
}));

import SessionPicker from './SessionPicker.svelte';

describe('SessionPicker — renders', () => {
  test('renders the Sessions trigger button', async () => {
    render(SessionPicker);
    await expect.element(page.getByRole('button', { name: 'Sessions' })).toBeVisible();
  });

  test('trigger opens a dialog (aria-haspopup="dialog")', async () => {
    render(SessionPicker);
    await expect.element(page.getByRole('button', { name: 'Sessions' })).toHaveAttribute('aria-haspopup', 'dialog');
  });

  test('drawer is closed before the trigger is clicked', async () => {
    render(SessionPicker);
    await expect.element(page.getByRole('button', { name: 'Sessions' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('SessionPicker — open/close', () => {
  test('clicking the trigger opens the drawer', async () => {
    render(SessionPicker);
    await page.getByRole('button', { name: 'Sessions' }).click();
    await expect.element(page.getByRole('button', { name: 'Sessions' })).toHaveAttribute('aria-expanded', 'true');
    await expect.element(page.getByRole('dialog', { name: /sessions on local assistant/i })).toBeVisible();
  });

  test('pressing Escape closes the drawer', async () => {
    render(SessionPicker);
    await page.getByRole('button', { name: 'Sessions' }).click();
    await expect.element(page.getByRole('button', { name: 'Sessions' })).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Escape}');
    await expect.element(page.getByRole('button', { name: 'Sessions' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('SessionPicker — session list', () => {
  test('lists the existing sessions', async () => {
    render(SessionPicker);
    await page.getByRole('button', { name: 'Sessions' }).click();
    await expect.element(page.getByRole('button', { name: /first session/i })).toBeVisible();
    await expect.element(page.getByRole('button', { name: /second session/i })).toBeVisible();
  });

  test('"New session" action is present', async () => {
    render(SessionPicker);
    await page.getByRole('button', { name: 'Sessions' }).click();
    await expect.element(page.getByRole('button', { name: /new session/i })).toBeVisible();
  });
});
