/**
 * SessionPicker component tests.
 *
 * The trigger is controlled by ChatNavbar, which owns the one shared drawer.
 *
 * Tests use:
 *   - aria-expanded on the trigger as the canonical open/closed signal
 *   - the drawer dialog title to confirm open state
 *   - button text for list items (plain buttons, active = aria-current)
 */
import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

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

describe('SessionPicker', () => {
  test('renders a controlled conversation trigger', async () => {
    const onToggle = vi.fn();
    render(SessionPicker, { open: false, controls: 'conversation-drawer', onToggle });
    const trigger = page.getByRole('button', { name: 'Conversation' });

    await expect.element(trigger).toBeVisible();
    await expect.element(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await expect.element(trigger).toHaveAttribute('aria-controls', 'conversation-drawer');
    await expect.element(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();

    expect(onToggle).toHaveBeenCalledOnce();
  });

  test('reflects the shared drawer state', async () => {
    render(SessionPicker, {
      open: true,
      controls: 'conversation-drawer',
      onToggle: vi.fn(),
    });

    await expect.element(page.getByRole('button', { name: 'Conversation' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});
