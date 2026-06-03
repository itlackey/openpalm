/**
 * SessionPicker component tests.
 *
 * 470-line dropdown with role="menu" / role="menuitemradio".
 * Mocks the chat and endpoint singletons to provide controlled state.
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

  test('trigger has aria-haspopup="menu"', async () => {
    render(SessionPicker);
    await expect.element(page.getByRole('button', { name: 'Sessions' })).toHaveAttribute('aria-haspopup', 'menu');
  });

  test('menu is not visible before trigger is clicked', async () => {
    render(SessionPicker);
    await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
  });
});

describe('SessionPicker — open/close', () => {
  test('clicking trigger opens the menu', async () => {
    render(SessionPicker);
    await page.getByRole('button', { name: 'Sessions' }).click();
    await expect.element(page.getByRole('menu')).toBeVisible();
  });

  test('trigger shows aria-expanded=true when open', async () => {
    render(SessionPicker);
    await page.getByRole('button', { name: 'Sessions' }).click();
    await expect.element(page.getByRole('button', { name: 'Sessions' })).toHaveAttribute('aria-expanded', 'true');
  });

  test('pressing Escape closes the menu', async () => {
    render(SessionPicker);
    await page.getByRole('button', { name: 'Sessions' }).click();
    await expect.element(page.getByRole('menu')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
  });
});

describe('SessionPicker — session list', () => {
  test('session items have role="menuitemradio"', async () => {
    render(SessionPicker);
    await page.getByRole('button', { name: 'Sessions' }).click();
    const items = page.getByRole('menuitemradio');
    await expect.element(items.first()).toBeVisible();
  });

  test('"New session" menu action is present', async () => {
    render(SessionPicker);
    await page.getByRole('button', { name: 'Sessions' }).click();
    await expect.element(page.getByRole('menuitem', { name: /new session/i })).toBeVisible();
  });
});
