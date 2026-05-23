/**
 * Unit tests for the per-endpoint chat state.
 *
 * Runs in the client/browser project because chat-state.svelte.ts uses
 * Svelte 5 runes ($state/$derived); only the Svelte preprocessor in the
 * client project can compile those.
 *
 * The api.ts module is mocked so tests never touch the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/voice/voice-state.svelte.js', () => ({
  voiceState: { ttsSupported: false, ttsAutoEnabled: false },
  speakText: vi.fn(),
  stopSpeaking: vi.fn(),
}));

vi.mock('$lib/api.js', () => ({
  createSession: vi.fn(),
  getSessionMessages: vi.fn(),
  listSessions: vi.fn(),
  sendChatMessage: vi.fn(),
}));

import * as api from '$lib/api.js';
import type { SessionSummary, ChatMessage } from '$lib/types.js';
import { chat } from './chat-state.svelte.js';

const mocked = {
  createSession: vi.mocked(api.createSession),
  getSessionMessages: vi.mocked(api.getSessionMessages),
  listSessions: vi.mocked(api.listSessions),
  sendChatMessage: vi.mocked(api.sendChatMessage),
};

function session(id: string, updatedAt: number, title = ''): SessionSummary {
  return { id, title, createdAt: updatedAt - 1000, updatedAt };
}

beforeEach(() => {
  // Reset the singleton — chat is a module-level instance.
  chat.reset();
  chat.activeEndpointId = 'default';
  chat.entries = [];
  chat.sending = false;
  chat.error = '';
  chat.entriesLoading = false;
  mocked.createSession.mockReset();
  mocked.getSessionMessages.mockReset();
  mocked.listSessions.mockReset();
  mocked.sendChatMessage.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('onEndpointChanged', () => {
  it('fetches sessions on first switch to an endpoint', async () => {
    mocked.listSessions.mockResolvedValueOnce([session('s1', 1000)]);
    mocked.getSessionMessages.mockResolvedValueOnce([]);

    await chat.onEndpointChanged('alpha');

    expect(mocked.listSessions).toHaveBeenCalledTimes(1);
    expect(chat.activeEndpointId).toBe('alpha');
    expect(chat.activeSessionId).toBe('s1');
    expect(chat.byEndpoint.get('alpha')?.sessionsLoaded).toBe(true);
  });

  it('restores the prior session when switching back to a cached endpoint', async () => {
    // First switch to alpha: load s1, s2; manually pick s2 to simulate user choice.
    mocked.listSessions.mockResolvedValueOnce([session('s2', 2000), session('s1', 1000)]);
    mocked.getSessionMessages.mockResolvedValueOnce([]);
    await chat.onEndpointChanged('alpha');
    expect(chat.activeSessionId).toBe('s2');

    // Pick s1 explicitly on alpha.
    mocked.getSessionMessages.mockResolvedValueOnce([]);
    await chat.openSession('s1');
    expect(chat.activeSessionId).toBe('s1');

    // Switch to beta (different list, only b1).
    mocked.listSessions.mockResolvedValueOnce([session('b1', 5000)]);
    mocked.getSessionMessages.mockResolvedValueOnce([]);
    await chat.onEndpointChanged('beta');
    expect(chat.activeSessionId).toBe('b1');

    // Switch back to alpha — should restore s1, not re-fetch the list, and
    // refetch messages for s1.
    const listCallsBefore = mocked.listSessions.mock.calls.length;
    const userMsg: ChatMessage = {
      id: 'm1',
      role: 'user',
      text: 'hi',
      timestamp: 1500,
    };
    mocked.getSessionMessages.mockResolvedValueOnce([userMsg]);
    await chat.onEndpointChanged('alpha');

    expect(chat.activeEndpointId).toBe('alpha');
    expect(chat.activeSessionId).toBe('s1');
    expect(mocked.listSessions.mock.calls.length).toBe(listCallsBefore);
    expect(chat.entries).toEqual([userMsg]);
  });

  it('blocks endpoint switch when a message is in flight', async () => {
    chat.sending = true;
    await chat.onEndpointChanged('alpha');
    expect(chat.error).toMatch(/Wait for the current reply/i);
    expect(mocked.listSessions).not.toHaveBeenCalled();
    expect(chat.activeEndpointId).toBe('default');
  });

  it('leaves activeSessionId null when the endpoint has zero sessions', async () => {
    mocked.listSessions.mockResolvedValueOnce([]);
    await chat.onEndpointChanged('empty');
    expect(chat.activeSessionId).toBeNull();
    expect(mocked.getSessionMessages).not.toHaveBeenCalled();
  });
});

describe('startNewSession', () => {
  it('creates a session, makes it active, and clears entries', async () => {
    // Seed alpha with one existing session.
    mocked.listSessions.mockResolvedValueOnce([session('s1', 1000)]);
    mocked.getSessionMessages.mockResolvedValueOnce([
      { id: 'm1', role: 'user', text: 'old', timestamp: 100 },
    ]);
    await chat.onEndpointChanged('alpha');
    expect(chat.entries.length).toBe(1);

    mocked.createSession.mockResolvedValueOnce({ id: 'new-1' });
    const id = await chat.startNewSession();

    expect(id).toBe('new-1');
    expect(chat.activeSessionId).toBe('new-1');
    expect(chat.entries).toEqual([]);
    // New session should be prepended.
    expect(chat.byEndpoint.get('alpha')?.sessions[0].id).toBe('new-1');
  });
});

describe('openSession', () => {
  it('fetches messages and populates entries', async () => {
    mocked.listSessions.mockResolvedValueOnce([session('s1', 1000), session('s2', 2000)]);
    mocked.getSessionMessages.mockResolvedValueOnce([]); // initial pick
    await chat.onEndpointChanged('alpha');

    const msgs: ChatMessage[] = [
      { id: 'a', role: 'user', text: 'hello', timestamp: 1 },
      { id: 'b', role: 'assistant', text: 'hi back', timestamp: 2 },
    ];
    mocked.getSessionMessages.mockResolvedValueOnce(msgs);
    await chat.openSession('s1');

    expect(chat.activeSessionId).toBe('s1');
    expect(chat.entries).toEqual(msgs);
  });
});

describe('send', () => {
  it('starts a new session when none is active before sending', async () => {
    // Endpoint with no sessions → activeSessionId stays null.
    mocked.listSessions.mockResolvedValueOnce([]);
    await chat.onEndpointChanged('empty');
    expect(chat.activeSessionId).toBeNull();

    mocked.createSession.mockResolvedValueOnce({ id: 'fresh' });
    mocked.sendChatMessage.mockResolvedValueOnce({
      parts: [{ type: 'text', text: 'pong' }],
    });

    await chat.send('ping');

    expect(mocked.createSession).toHaveBeenCalledTimes(1);
    expect(mocked.sendChatMessage).toHaveBeenCalledWith('fresh', 'ping');
    expect(chat.activeSessionId).toBe('fresh');
    expect(chat.entries.length).toBe(2); // user + assistant
    const [first, second] = chat.entries;
    if (first.type === 'divider' || second.type === 'divider') {
      throw new Error('expected message entries, got divider');
    }
    expect(first.text).toBe('ping');
    expect(second.text).toBe('pong');
  });

  it('is rejected when already sending', async () => {
    chat.sending = true;
    await chat.send('hello');
    expect(mocked.sendChatMessage).not.toHaveBeenCalled();
  });
});

describe('byEndpoint Map reactivity', () => {
  it('reassigns the Map (not mutating it in place) so $state fires', async () => {
    const initial = chat.byEndpoint;
    mocked.listSessions.mockResolvedValueOnce([session('s1', 1000)]);
    mocked.getSessionMessages.mockResolvedValueOnce([]);
    await chat.onEndpointChanged('alpha');
    // The Map reference should change after a write.
    expect(chat.byEndpoint).not.toBe(initial);
    expect(chat.byEndpoint.get('alpha')).toBeDefined();
  });
});
