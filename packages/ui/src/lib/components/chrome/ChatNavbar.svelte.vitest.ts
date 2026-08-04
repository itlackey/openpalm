import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

const mocks = vi.hoisted(() => {
  const appPage = { url: new URL('http://localhost/advanced?session=session-1') };
  const chat = {
    activeSessionId: 'session-1' as string | null,
    liveConnected: true,
    sending: false,
    toolLog: [] as unknown[],
    byEndpoint: new Map([
      ['assistant-1', {
        sessions: [
          { id: 'session-1', title: 'Current conversation', updatedAt: Date.now() },
        ],
        sessionsLoading: false,
        sessionsLoaded: true,
        sessionsError: '',
        activeSessionId: 'session-1',
      }],
    ]),
    loadSessions: vi.fn().mockResolvedValue(undefined),
    openSession: vi.fn().mockResolvedValue(undefined),
    startNewSession: vi.fn().mockResolvedValue('new-session'),
    renameSession: vi.fn().mockResolvedValue(true),
    deleteSession: vi.fn().mockResolvedValue(true),
  };
  const endpointsService = {
    active: {
      id: 'assistant-1',
      label: 'Workshop assistant',
      url: 'http://127.0.0.1:3800',
      isDefault: true,
    },
    activeId: 'assistant-1',
    endpoints: [
      {
        id: 'assistant-1',
        label: 'Workshop assistant',
        url: 'http://127.0.0.1:3800',
        isDefault: true,
      },
    ],
    loading: false,
    error: '',
    load: vi.fn().mockResolvedValue(undefined),
    activate: vi.fn().mockResolvedValue(undefined),
  };
  const buildConversationPath = vi.fn(
    (_pathname: string, sessionId: string | null, assistantId: string | null) =>
      `/advanced?session=${sessionId}&assistant=${assistantId}`,
  );
  const goto = vi.fn().mockResolvedValue(undefined);
  // Captures the component's afterNavigate callback so tests can simulate a
  // navigation (the drawer must auto-close on navigation — #473).
  const afterNavigateCallbacks: Array<() => void> = [];
  const afterNavigate = vi.fn((cb: () => void) => {
    afterNavigateCallbacks.push(cb);
  });
  return { appPage, buildConversationPath, chat, endpointsService, goto, afterNavigate, afterNavigateCallbacks };
});

vi.mock('$app/state', () => ({ page: mocks.appPage }));
vi.mock('$app/navigation', () => ({ goto: mocks.goto, afterNavigate: mocks.afterNavigate }));
vi.mock('$lib/chat/chat-state.svelte.js', () => ({ chat: mocks.chat }));
vi.mock('$lib/endpoints-state.svelte.js', () => ({ endpointsService: mocks.endpointsService }));
vi.mock('$lib/advanced-mode-state.svelte.js', () => ({
  advancedModeService: {
    enabled: true,
    init: vi.fn(),
    setEnabled: vi.fn(),
  },
}));
vi.mock('$lib/runtime-context.svelte.js', () => ({
  getRuntimeContext: () => ({
    routes: { chat: '/chat', host: '/host' },
    uiVersion: '0.13.0-beta.10',
  }),
  hasCapability: (_context: unknown, capability: string) => capability === 'host:stack:read',
}));
vi.mock('$lib/chat/navigation.js', () => ({
  buildAdvancedPath: (sessionId: string | null) => `/advanced?session=${sessionId}`,
  buildChatPath: (sessionId: string | null) => `/chat?session=${sessionId}`,
  buildConversationPath: mocks.buildConversationPath,
  buildReturnToPath: (destination: string, returnTo: string) =>
    `${destination}${destination.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(returnTo)}`,
  currentChatSessionId: () => mocks.chat.activeSessionId,
}));

import ChatNavbar from './ChatNavbar.svelte';

async function closeDrawer(name: string): Promise<void> {
  await expect.element(page.getByRole('dialog', { name })).toBeVisible();
  await page.getByRole('button', { name: /^Close/ }).click();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
}

beforeEach(() => {
  mocks.appPage.url = new URL('http://localhost/advanced?session=session-1');
  mocks.chat.toolLog = [];
  mocks.buildConversationPath.mockClear();
  mocks.goto.mockClear();
});

describe('ChatNavbar', () => {
  test('uses explicit context and mode targets in a consistent DOM order', async () => {
    const { container } = await render(ChatNavbar);
    const targets = Array.from(container.querySelectorAll<HTMLElement>('header a, header button'));

    expect(targets.map((target) => target.getAttribute('aria-label'))).toEqual([
      'OpenPalm - go to chat',
      'Assistant: Workshop assistant',
      'Conversation: Current conversation',
      'Chat',
      'Advanced',
      'Open settings',
      'Open host console',
    ]);
    expect(container.querySelector('.brand-version')?.textContent).toBe('v0.13.0-beta.10');
    for (const target of targets) {
      const rect = target.getBoundingClientRect();
      expect(rect.width).toBeGreaterThanOrEqual(44);
      expect(rect.height).toBeGreaterThanOrEqual(44);
    }
  });

  // The mocked URL above is /advanced, and the pickers render there because
  // ConversationFrame's default is on — /advanced used to opt out, which took
  // the drawer and the taller navbar with it.
  test('shows the assistant and conversation pickers on the advanced surface', async () => {
    const { container } = await render(ChatNavbar);

    expect(container.querySelector('[aria-label="Assistant: Workshop assistant"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Conversation: Current conversation"]')).not.toBeNull();
    // The taller conversation frame is what gives them room to sit in.
    expect(container.querySelector('header')?.classList.contains('conversation')).toBe(true);
  });

  test('drops the pickers and their drawer together when context is suppressed', async () => {
    const { container } = await render(ChatNavbar, { showConversationControls: false });

    expect(container.querySelector('[aria-label^="Assistant:"]')).toBeNull();
    expect(container.querySelector('[aria-label^="Conversation:"]')).toBeNull();
    // Leaving a trigger behind whose aria-controls names a dialog that was
    // never rendered would be worse than hiding both.
    expect(document.getElementById('chat-navbar-drawer')).toBeNull();
  });

  // `text-overflow` does nothing on a flex container, so the label needs its
  // own element — without it a long assistant name is cut off mid-glyph
  // instead of ellipsized.
  test('truncates a long picker label rather than clipping it', async () => {
    const { container } = await render(ChatNavbar);
    const label = container.querySelector<HTMLElement>('[aria-label^="Assistant:"] .label');

    expect(label, 'the picker label needs its own element to ellipsize').not.toBeNull();
    const style = getComputedStyle(label as HTMLElement);
    expect(style.textOverflow).toBe('ellipsis');
    expect(style.whiteSpace).toBe('nowrap');
    expect(style.overflow).toBe('hidden');
  });

  test('connects every drawer trigger to the one mutually exclusive dialog', async () => {
    await render(ChatNavbar);

    for (const name of [
      'Assistant: Workshop assistant',
      'Conversation: Current conversation',
    ]) {
      const trigger = page.getByRole('button', { name, exact: true });
      await expect.element(trigger).toHaveAttribute('aria-haspopup', 'dialog');
      await expect.element(trigger).toHaveAttribute('aria-controls', 'chat-navbar-drawer');
      await expect.element(trigger).toHaveAttribute('aria-expanded', 'false');
    }

    await page.getByRole('button', { name: 'Assistant: Workshop assistant' }).click();
    await expect.element(page.getByRole('dialog', { name: 'Switch assistant' })).toBeVisible();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await closeDrawer('Switch assistant');

    await page.getByRole('button', { name: 'Conversation: Current conversation' }).click();
    await expect.element(page.getByRole('dialog', { name: 'Conversations' })).toBeVisible();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  test('routes the single settings entry with conversation return context', async () => {
    await render(ChatNavbar);

    await expect.element(page.getByRole('link', { name: 'Open settings' })).toHaveAttribute(
      'href',
      '/connections?returnTo=%2Fadvanced%3Fsession%3Dsession-1%26assistant%3Dassistant-1',
    );
    await expect.element(page.getByRole('link', { name: 'Open host console' })).toHaveAttribute(
      'href',
      '/host?returnTo=%2Fadvanced%3Fsession%3Dsession-1%26assistant%3Dassistant-1',
    );
    expect(mocks.buildConversationPath).toHaveBeenCalledWith(
      '/advanced',
      'session-1',
      'assistant-1',
    );
  });

  test('closes an open drawer on navigation (#473 — no drawer lingering over the next page)', async () => {
    await render(ChatNavbar);

    await page.getByRole('button', { name: 'Conversation: Current conversation' }).click();
    await expect.element(page.getByRole('dialog', { name: 'Conversations' })).toBeVisible();

    // Simulate a navigation firing the registered afterNavigate callback(s).
    for (const cb of mocks.afterNavigateCallbacks) cb();
    await expect.poll(() => document.querySelectorAll('[role="dialog"]').length).toBe(0);
  });
});
