import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

const mocks = vi.hoisted(() => {
  const chat = {
    byEndpoint: new Map<string, unknown>(),
    activeSessionId: 'sess-1' as string | null,
    sending: false,
    loadSessions: vi.fn().mockResolvedValue(undefined),
    openSession: vi.fn().mockResolvedValue(undefined),
    startNewSession: vi.fn().mockResolvedValue('new-session'),
    renameSession: vi.fn().mockResolvedValue(true),
    deleteSession: vi.fn().mockResolvedValue(true),
  };
  return {
    chat,
    goto: vi.fn().mockResolvedValue(undefined),
    appPage: { url: new URL('http://localhost/chat') },
  };
});

vi.mock('$lib/chat/chat-state.svelte.js', () => ({ chat: mocks.chat }));
vi.mock('$app/navigation', () => ({ goto: mocks.goto }));
vi.mock('$app/state', () => ({ page: mocks.appPage }));

vi.mock('$lib/endpoints-state.svelte.js', () => ({
  endpointsService: {
    active: { id: 'default', label: 'Local assistant', url: 'http://127.0.0.1:3800', isDefault: true },
  },
}));

import SessionList from './SessionList.svelte';

function session(id: string, title: string, updatedAt = Date.now()) {
  return { id, title, createdAt: updatedAt - 1000, updatedAt };
}

function seedSessions(sessions = [
  session('sess-1', 'First conversation'),
  session('sess-2', 'Second conversation', Date.now() - 60_000),
]): void {
  mocks.chat.byEndpoint = new Map([
    ['default', {
      sessions,
      sessionsLoading: false,
      sessionsLoaded: true,
      sessionsError: '',
      activeSessionId: mocks.chat.activeSessionId,
    }],
  ]);
}

beforeEach(() => {
  mocks.chat.activeSessionId = 'sess-1';
  mocks.chat.sending = false;
  mocks.chat.loadSessions.mockClear();
  mocks.chat.openSession.mockReset().mockResolvedValue(undefined);
  mocks.chat.startNewSession.mockReset().mockResolvedValue('new-session');
  mocks.chat.renameSession.mockReset().mockResolvedValue(true);
  mocks.chat.deleteSession.mockReset().mockResolvedValue(true);
  mocks.goto.mockReset().mockResolvedValue(undefined);
  mocks.appPage.url = new URL('http://localhost/chat');
  seedSessions();
});

describe('SessionList', () => {
  test('uses the conversation copy and renders the new action below the list', async () => {
    render(SessionList);

    await expect.element(page.getByRole('group', { name: 'Conversations' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'New conversation' })).toBeVisible();
  });

  test('filters a long list from a sticky search control', async () => {
    seedSessions(Array.from({ length: 60 }, (_, index) =>
      session(`sess-${index}`, index === 57 ? 'Needle planning' : `Conversation ${index}`)
    ));
    render(SessionList);

    const search = page.getByRole('searchbox', { name: 'Search conversations' });
    await expect.element(search).toBeVisible();
    expect(document.querySelector('.session-search')).toHaveClass('sticky');

    await userEvent.type(search, 'needle');

    await expect.element(page.getByRole('button', { name: /Resume conversation: Needle planning/ })).toBeVisible();
    await expect.element(page.getByRole('button', { name: /Resume conversation: Conversation 1/ })).not.toBeInTheDocument();
  });

  test('gives Show all a 44px target', async () => {
    seedSessions(Array.from({ length: 51 }, (_, index) =>
      session(`sess-${index}`, `Conversation ${index}`)
    ));
    render(SessionList);

    const showAll = page.getByRole('button', { name: 'Show 1 more conversations' });
    await expect.element(showAll).toBeVisible();
    expect((showAll.element() as HTMLButtonElement).getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  });

  test('selects a session and updates the canonical simple-mode URL', async () => {
    render(SessionList);

    await page.getByRole('button', { name: /Resume conversation: Second conversation/ }).click();

    expect(mocks.chat.openSession).toHaveBeenCalledWith('sess-2');
    expect(mocks.goto).toHaveBeenCalledWith('/chat?session=sess-2&assistant=default');
  });

  test('keeps advanced mode when selecting a session', async () => {
    mocks.appPage.url = new URL('http://localhost/advanced?session=sess-1');
    render(SessionList);

    await page.getByRole('button', { name: /Resume conversation: Second conversation/ }).click();

    expect(mocks.goto).toHaveBeenCalledWith('/advanced?session=sess-2&assistant=default');
  });

  test('starts a conversation and puts its identity in the URL', async () => {
    render(SessionList);

    await page.getByRole('button', { name: 'New conversation' }).click();

    expect(mocks.chat.startNewSession).toHaveBeenCalledOnce();
    expect(mocks.goto).toHaveBeenCalledWith('/chat?session=new-session&assistant=default');
  });

  test('renames a conversation only after an explicit save', async () => {
    render(SessionList);

    await page.getByRole('button', { name: 'More actions for First conversation' }).click();
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Conversation name' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Project launch');
    expect(mocks.chat.renameSession).not.toHaveBeenCalled();

    await page.getByRole('button', { name: 'Save name' }).click();

    expect(mocks.chat.renameSession).toHaveBeenCalledWith('sess-1', 'Project launch');
  });

  test('requires confirmation before deleting and routes an active fallback', async () => {
    mocks.chat.deleteSession.mockImplementationOnce(async () => {
      mocks.chat.activeSessionId = 'sess-2';
      return true;
    });
    render(SessionList);

    await page.getByRole('button', { name: 'More actions for First conversation' }).click();
    await page.getByRole('button', { name: 'Delete conversation', exact: true }).click();
    await expect.element(
      page.getByRole('alertdialog', { name: 'Delete First conversation?' }),
    ).toBeVisible();
    expect(mocks.chat.deleteSession).not.toHaveBeenCalled();

    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete conversation' }).click();

    expect(mocks.chat.deleteSession).toHaveBeenCalledWith('sess-1');
    expect(mocks.goto).toHaveBeenCalledWith('/chat?session=sess-2&assistant=default');
  });
});
