import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

vi.mock('$lib/chat/chat-state.svelte.js', () => ({
  chat: {
    byEndpoint: new Map([
      ['default', {
        sessions: [
          { id: 'sess-1', title: 'First session', updatedAt: Date.now() - 60_000 },
          { id: 'sess-2', title: 'Second session', updatedAt: Date.now() - 120_000 },
        ],
        sessionsLoading: false,
        sessionsLoaded: true,
        sessionsError: '',
      }],
    ]),
    activeSessionId: 'sess-1',
    sending: false,
    loadSessions: vi.fn().mockResolvedValue(undefined),
    openSession: vi.fn().mockResolvedValue(undefined),
    startNewSession: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('$lib/endpoints-state.svelte.js', () => ({
  endpointsService: {
    active: { id: 'default', label: 'Local assistant', url: 'http://127.0.0.1:3800', isDefault: true },
  },
}));

import SessionList from './SessionList.svelte';

describe('SessionList', () => {
  test('renders the new session action below the session list', () => {
    render(SessionList);

    const labels = Array.from(document.querySelectorAll<HTMLElement>('.session-body .item-label'))
      .map((el) => el.textContent?.trim() ?? '');

    expect(labels[0]).toContain('First session');
    expect(labels[1]).toContain('Second session');
    expect(labels.at(-1)).toBe('New session');
  });
});
