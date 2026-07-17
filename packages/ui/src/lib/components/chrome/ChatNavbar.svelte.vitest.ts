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
  return { appPage, buildConversationPath, chat, endpointsService, goto };
});

vi.mock('$app/state', () => ({ page: mocks.appPage }));
vi.mock('$app/navigation', () => ({ goto: mocks.goto }));
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
  hasCapability: (capability: string) => capability === 'host:stack:read',
  runtimeContext: {
    routes: { chat: '/chat', host: '/host' },
  },
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
    const { container } = render(ChatNavbar);
    const targets = Array.from(container.querySelectorAll<HTMLElement>('header a, header button'));

    expect(targets.map((target) => target.getAttribute('aria-label'))).toEqual([
      'OpenPalm - go to chat',
      'Assistant: Workshop assistant',
      'Conversation: Current conversation',
      'Simple mode',
      'OpenCode mode',
      'Open settings',
    ]);
    for (const target of targets) {
      const rect = target.getBoundingClientRect();
      expect(rect.width).toBeGreaterThanOrEqual(44);
      expect(rect.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('connects every drawer trigger to the one mutually exclusive dialog', async () => {
    render(ChatNavbar);

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
    render(ChatNavbar);

    await expect.element(page.getByRole('link', { name: 'Open settings' })).toHaveAttribute(
      'href',
      '/connections?returnTo=%2Fadvanced%3Fsession%3Dsession-1%26assistant%3Dassistant-1',
    );
    expect(mocks.buildConversationPath).toHaveBeenCalledWith(
      '/advanced',
      'session-1',
      'assistant-1',
    );
  });
});
