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

vi.mock('$lib/voice/earcon.js', () => ({
  playAck: vi.fn(),
}));

vi.mock('$lib/api.js', () => ({
  abortChatTurn: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSessionMessages: vi.fn(),
  listSessions: vi.fn(),
  renameSession: vi.fn(),
  sendChatMessage: vi.fn(),
  startChatMessageTurn: vi.fn(),
  replyChatPermission: vi.fn(),
  replyChatQuestion: vi.fn(),
  rejectChatQuestion: vi.fn(),
}));

const persistedSessions = new Map<string, string>();
const cursorStore = {
  getLastSessionId: vi.fn(async (connectionId: string) => persistedSessions.get(connectionId) ?? null),
  setLastSessionId: vi.fn(async (connectionId: string, sessionId: string | null) => {
    if (sessionId === null) persistedSessions.delete(connectionId);
    else persistedSessions.set(connectionId, sessionId);
  }),
};

vi.mock('$lib/connections/boot.js', () => ({
  getConnectionStore: () => cursorStore,
}));

// Mock the SSE consumer so chat-state tests don't open network sockets.
// `subscribeSessionEvents` is the only export we care about here — the real
// behavior is exercised in session-events.vitest.ts.
type CapturedHandlers = import('./session-events.js').SessionEventHandlers;
const sseCaptured: { handlers: CapturedHandlers | null; unsub: ReturnType<typeof vi.fn> } = {
  handlers: null,
  unsub: vi.fn(),
};
const sseSubscriptions: CapturedHandlers[] = [];
vi.mock('./session-events.js', () => ({
  subscribeSessionEvents: vi.fn((handlers: CapturedHandlers) => {
    sseCaptured.handlers = handlers;
    sseSubscriptions.push(handlers);
    return sseCaptured.unsub;
  }),
}));

import * as api from '$lib/api.js';
import * as voice from '$lib/voice/voice-state.svelte.js';
import * as earcon from '$lib/voice/earcon.js';
import * as sse from './session-events.js';
import type { SessionSummary, ChatMessage } from '$lib/types.js';
import type { ToolStripEntry } from '$lib/chat/tool-strip.js';
import {
	activationBlockReason,
	beginConnectionActivation,
	emitConnectionActivated
} from '$lib/connection-events.js';
import { chat } from './chat-state.svelte.js';

const mocked = {
  abortChatTurn: vi.mocked(api.abortChatTurn),
  createSession: vi.mocked(api.createSession),
  deleteSession: vi.mocked(api.deleteSession),
  getSessionMessages: vi.mocked(api.getSessionMessages),
  listSessions: vi.mocked(api.listSessions),
  renameSession: vi.mocked(api.renameSession),
  sendChatMessage: vi.mocked(api.sendChatMessage),
  subscribeSessionEvents: vi.mocked(sse.subscribeSessionEvents),
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
  mocked.abortChatTurn.mockReset();
  mocked.createSession.mockReset();
  mocked.deleteSession.mockReset();
  mocked.getSessionMessages.mockReset();
  mocked.listSessions.mockReset();
	mocked.renameSession.mockReset();
	mocked.sendChatMessage.mockReset();
	vi.mocked(voice.speakText).mockReset();
	vi.mocked(earcon.playAck).mockReset();
	voice.voiceState.ttsSupported = false;
	voice.voiceState.ttsAutoEnabled = false;
	sseCaptured.handlers = null;
	sseSubscriptions.length = 0;
	sseCaptured.unsub.mockReset();
  mocked.subscribeSessionEvents.mockClear();
	persistedSessions.clear();
	cursorStore.getLastSessionId.mockClear();
	cursorStore.setLastSessionId.mockClear();
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

    // Switch back to alpha — always re-fetches by design (no stale-cache bug).
    // Set up the 3rd listSessions call and the getSessionMessages call for s1.
    mocked.listSessions.mockResolvedValueOnce([session('s2', 2000), session('s1', 1000)]);
    const userMsg: ChatMessage = {
      id: 'm1',
      role: 'user',
      text: 'hi',
      timestamp: 1500,
    };
    mocked.getSessionMessages.mockResolvedValueOnce([userMsg]);
    await chat.onEndpointChanged('alpha');

    expect(chat.activeEndpointId).toBe('alpha');
    expect(chat.activeSessionId).toBe('s1'); // previously-selected s1 is still in the list
    expect(chat.entries).toEqual([userMsg]);
  });

  it('blocks endpoint switch when a message is in flight', async () => {
    chat.sending = true;
    await chat.onEndpointChanged('alpha');
    expect(chat.error).toMatch(/Wait for the current reply/i);
    expect(mocked.listSessions).not.toHaveBeenCalled();
    expect(chat.activeEndpointId).toBe('default');
  });

	it('propagates a refused chat handoff as an activation failure', async () => {
		mocked.listSessions.mockRejectedValueOnce(new Error('offline'));

		await expect(emitConnectionActivated('alpha')).rejects.toThrow(/refused/i);
		expect(chat.activeEndpointId).toBe('alpha');
	});

	it('repairs a disconnected stream without treating same-endpoint route re-entry as a switch', async () => {
		mocked.listSessions.mockResolvedValueOnce([session('s1', 1000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		sseCaptured.handlers?.onConnect?.();
		expect(chat.liveConnected).toBe(true);

		sseCaptured.handlers?.onDisconnect?.(new Error('route transition'));
		chat.sending = true;
		await chat.onEndpointChanged('alpha');

		expect(chat.error).toBe('');
		expect(chat.activeEndpointId).toBe('alpha');
		expect(chat.activeSessionId).toBe('s1');
		expect(mocked.listSessions).toHaveBeenCalledTimes(1);
		expect(sseCaptured.unsub).toHaveBeenCalledOnce();
		expect(mocked.subscribeSessionEvents).toHaveBeenCalledTimes(2);
	});

  it('leaves activeSessionId null when the endpoint has zero sessions', async () => {
		persistedSessions.set('empty', 'deleted-session');
    mocked.listSessions.mockResolvedValueOnce([]);
    await chat.onEndpointChanged('empty');
    expect(chat.activeSessionId).toBeNull();
    expect(mocked.getSessionMessages).not.toHaveBeenCalled();
		expect(persistedSessions.has('empty')).toBe(false);
  });

	it('restores a persisted session only when the successful list contains it', async () => {
		persistedSessions.set('alpha', 'remembered');
		mocked.listSessions.mockResolvedValueOnce([
			session('newest', 2000),
			session('remembered', 1000),
		]);
		mocked.getSessionMessages.mockResolvedValueOnce([
			{ id: 'm1', role: 'assistant', text: 'remembered reply', timestamp: 1 },
		]);

		await chat.onEndpointChanged('alpha');

		expect(chat.activeSessionId).toBe('remembered');
		expect(mocked.getSessionMessages).toHaveBeenCalledWith('remembered');
		expect(chat.entries).toMatchObject([{ text: 'remembered reply' }]);
	});

	it('prefers a valid current in-memory session over the persisted cursor', async () => {
		chat.setActiveSessionId('current', 'alpha');
		persistedSessions.set('alpha', 'remembered');
		mocked.listSessions.mockResolvedValueOnce([
			session('remembered', 2000),
			session('current', 1000),
		]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);

		await chat.onEndpointChanged('alpha');

		expect(chat.activeSessionId).toBe('current');
		expect(mocked.getSessionMessages).toHaveBeenCalledWith('current');
		expect(persistedSessions.get('alpha')).toBe('current');
	});

	it('falls back from a stale cursor to newest and repairs it after messages load', async () => {
		persistedSessions.set('alpha', 'deleted');
		mocked.listSessions.mockResolvedValueOnce([session('newest', 2000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);

		await chat.onEndpointChanged('alpha');

		expect(chat.activeSessionId).toBe('newest');
		expect(persistedSessions.get('alpha')).toBe('newest');
		expect(cursorStore.setLastSessionId).toHaveBeenCalledWith('alpha', 'newest');
	});

	it('preserves the prior cursor when listing sessions fails', async () => {
		persistedSessions.set('alpha', 'remembered');
		mocked.listSessions.mockRejectedValueOnce(new Error('offline'));

		await chat.onEndpointChanged('alpha');

		expect(persistedSessions.get('alpha')).toBe('remembered');
		expect(cursorStore.setLastSessionId).not.toHaveBeenCalled();
		expect(mocked.getSessionMessages).not.toHaveBeenCalled();
		expect(chat.byEndpoint.get('alpha')?.sessionsLoaded).toBe(false);
	});

	it('preserves the rendered transcript and cursor when the active endpoint becomes unreachable', async () => {
		mocked.listSessions.mockResolvedValueOnce([session('remembered', 1000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([
			{ id: 'message-1', role: 'assistant', text: 'keep this visible', timestamp: 1 },
		]);
		await chat.onEndpointChanged('alpha');
		mocked.listSessions.mockRejectedValueOnce(new Error('offline'));

		await chat.onEndpointChanged('alpha');

		expect(chat.activeSessionId).toBe('remembered');
		expect(chat.entries).toMatchObject([{ text: 'keep this visible' }]);
		expect(persistedSessions.get('alpha')).toBe('remembered');
	});

	it('does not let a late endpoint load replace the newer endpoint state or cursor', async () => {
		let releaseAlpha: ((sessions: SessionSummary[]) => void) | undefined;
		mocked.listSessions
			.mockImplementationOnce(() => new Promise<SessionSummary[]>((resolve) => {
				releaseAlpha = resolve;
			}))
			.mockResolvedValueOnce([session('beta-session', 2000)]);
		mocked.getSessionMessages.mockImplementation(async (id) => [{
			id: `${id}-message`,
			role: 'assistant',
			text: id,
			timestamp: 1,
		}]);

		const alpha = chat.onEndpointChanged('alpha');
		await Promise.resolve();
		await chat.onEndpointChanged('beta');
		releaseAlpha?.([session('alpha-session', 1000)]);
		await alpha;

		expect(chat.activeEndpointId).toBe('beta');
		expect(chat.activeSessionId).toBe('beta-session');
		expect(chat.entries).toMatchObject([{ text: 'beta-session' }]);
		expect(persistedSessions.get('beta')).toBe('beta-session');
		expect(persistedSessions.has('alpha')).toBe(false);
		expect(mocked.getSessionMessages).not.toHaveBeenCalledWith('alpha-session');
	});

	it('a successful refresh falls back when the current and persisted session are stale', async () => {
		chat.activeEndpointId = 'alpha';
		chat.setActiveSessionId('deleted', 'alpha');
		persistedSessions.set('alpha', 'deleted');
		mocked.listSessions.mockResolvedValueOnce([session('newest', 2000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);

		await chat.loadSessions();

		expect(chat.activeSessionId).toBe('newest');
		expect(mocked.getSessionMessages).toHaveBeenCalledWith('newest');
		expect(persistedSessions.get('alpha')).toBe('newest');
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
		expect(persistedSessions.get('alpha')).toBe('new-1');
  });

	it('does not publish a late creation after a newer endpoint wins', async () => {
		mocked.listSessions.mockResolvedValueOnce([session('alpha-session', 1000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');

		let releaseCreate: ((value: { id: string }) => void) | undefined;
		mocked.createSession.mockImplementationOnce(() => new Promise((resolve) => {
			releaseCreate = resolve;
		}));
		const creating = chat.startNewSession();

		mocked.listSessions.mockResolvedValueOnce([session('beta-session', 2000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([
			{ id: 'beta-message', role: 'assistant', text: 'beta', timestamp: 2 },
		]);
		await chat.onEndpointChanged('beta');
		releaseCreate?.({ id: 'late-new' });
		await creating;

		expect(chat.activeEndpointId).toBe('beta');
		expect(chat.activeSessionId).toBe('beta-session');
		expect(chat.entries).toMatchObject([{ text: 'beta' }]);
		expect(persistedSessions.get('beta')).toBe('beta-session');
		expect(persistedSessions.get('alpha')).toBe('alpha-session');
	});
});

describe('setActiveSessionId', () => {
	it('updates the requested endpoint cursor without changing the active endpoint', () => {
		chat.activeEndpointId = 'beta';

		chat.setActiveSessionId('alpha-session', 'alpha');

		expect(chat.activeEndpointId).toBe('beta');
		expect(chat.byEndpoint.get('alpha')?.activeSessionId).toBe('alpha-session');
		expect(chat.activeSessionId).toBeNull();
	});

	it('can explicitly align a direct Advanced entry before storing its cursor', () => {
		chat.activeEndpointId = 'old';

		chat.alignActiveEndpoint('remote');
		chat.setActiveSessionId('remote-session', 'remote');

		expect(chat.activeEndpointId).toBe('remote');
		expect(chat.activeSessionId).toBe('remote-session');
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
		expect(persistedSessions.get('alpha')).toBe('s1');
  });

	it('counts an empty successful message list as an opened session', async () => {
		persistedSessions.set('alpha', 'prior');
		chat.activeEndpointId = 'alpha';
		mocked.getSessionMessages.mockResolvedValueOnce([]);

		await chat.openSession('empty-session');

		expect(chat.entries).toEqual([]);
		expect(persistedSessions.get('alpha')).toBe('empty-session');
	});

	it('preserves the prior cursor when messages fail to load', async () => {
		persistedSessions.set('alpha', 'prior');
		chat.activeEndpointId = 'alpha';
		mocked.getSessionMessages.mockRejectedValueOnce(new Error('offline'));

		await chat.openSession('requested');

		expect(persistedSessions.get('alpha')).toBe('prior');
		expect(cursorStore.setLastSessionId).not.toHaveBeenCalled();
	});

	it('keeps loading and cursor owned by the newest overlapping session open', async () => {
		persistedSessions.set('alpha', 'prior');
		chat.activeEndpointId = 'alpha';
		let releaseSlow: ((messages: ChatMessage[]) => void) | undefined;
		let releaseFast: ((messages: ChatMessage[]) => void) | undefined;
		mocked.getSessionMessages.mockImplementation((id) => new Promise((resolve) => {
			if (id === 'slow') releaseSlow = resolve;
			else releaseFast = resolve;
		}));

		const slow = chat.openSession('slow');
		const fast = chat.openSession('fast');
		releaseSlow?.([{ id: 'slow-message', role: 'assistant', text: 'slow', timestamp: 1 }]);
		await slow;

		expect(chat.entriesLoading).toBe(true);
		expect(persistedSessions.get('alpha')).toBe('prior');

		releaseFast?.([{ id: 'fast-message', role: 'assistant', text: 'fast', timestamp: 2 }]);
		await fast;

		expect(chat.entriesLoading).toBe(false);
		expect(chat.activeSessionId).toBe('fast');
		expect(chat.entries).toMatchObject([{ text: 'fast' }]);
		expect(persistedSessions.get('alpha')).toBe('fast');
	});
});

describe('session management', () => {
	it('renames only the requested connection session', async () => {
		mocked.listSessions.mockResolvedValueOnce([session('alpha-1', 1000, 'Old title')]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		chat.setActiveSessionId('beta-1', 'beta');
		mocked.renameSession.mockResolvedValueOnce(undefined);

		await expect(chat.renameSession('alpha-1', '  New title  ')).resolves.toBe(true);

		expect(mocked.renameSession).toHaveBeenCalledWith('alpha-1', 'New title');
		expect(chat.byEndpoint.get('alpha')?.sessions[0].title).toBe('New title');
		expect(chat.byEndpoint.get('beta')?.activeSessionId).toBe('beta-1');
	});

	it('deletes an inactive session without changing the active conversation', async () => {
		mocked.listSessions.mockResolvedValueOnce([
			session('active', 2000),
			session('inactive', 1000),
		]);
		mocked.getSessionMessages.mockResolvedValueOnce([
			{ id: 'message-1', role: 'user', text: 'keep me', timestamp: 1 },
		]);
		await chat.onEndpointChanged('alpha');
		mocked.deleteSession.mockResolvedValueOnce(undefined);

		await expect(chat.deleteSession('inactive')).resolves.toBe(true);

		expect(chat.activeSessionId).toBe('active');
		expect(chat.byEndpoint.get('alpha')?.sessions.map((item) => item.id)).toEqual(['active']);
		expect(chat.entries).toMatchObject([{ text: 'keep me' }]);
	});

	it('deleting the active session opens the newest remaining conversation', async () => {
		mocked.listSessions.mockResolvedValueOnce([
			session('active', 2000),
			session('next', 1000),
		]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		mocked.deleteSession.mockResolvedValueOnce(undefined);
		mocked.getSessionMessages.mockResolvedValueOnce([
			{ id: 'next-message', role: 'assistant', text: 'next conversation', timestamp: 2 },
		]);

		await expect(chat.deleteSession('active')).resolves.toBe(true);

		expect(chat.activeSessionId).toBe('next');
		expect(mocked.getSessionMessages).toHaveBeenLastCalledWith('next');
		expect(chat.entries).toMatchObject([{ text: 'next conversation' }]);
	});

	it('deleting the only active session clears the conversation', async () => {
		mocked.listSessions.mockResolvedValueOnce([session('only', 1000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([
			{ id: 'message-1', role: 'user', text: 'remove me', timestamp: 1 },
		]);
		await chat.onEndpointChanged('alpha');
		mocked.deleteSession.mockResolvedValueOnce(undefined);

		await expect(chat.deleteSession('only')).resolves.toBe(true);

		expect(chat.activeSessionId).toBeNull();
		expect(chat.entries).toEqual([]);
		expect(persistedSessions.has('alpha')).toBe(false);
	});

	it('blocks rename and delete while a turn is running', async () => {
		chat.sending = true;

		await expect(chat.renameSession('session-1', 'New title')).resolves.toBe(false);
		await expect(chat.deleteSession('session-1')).resolves.toBe(false);

		expect(mocked.renameSession).not.toHaveBeenCalled();
		expect(mocked.deleteSession).not.toHaveBeenCalled();
		expect(chat.error).toContain('current reply');
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
    if (first.type || second.type) {
      throw new Error('expected plain chat messages');
    }
    expect(first.text).toBe('ping');
		expect(second.text).toBe('pong');
	});

	it('serializes immediate sends on an empty endpoint through one created session', async () => {
		mocked.listSessions.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('empty');
		mocked.createSession.mockResolvedValue({ id: 'fresh' });
		mocked.sendChatMessage
			.mockResolvedValueOnce({ parts: [{ type: 'text', text: 'first reply' }] })
			.mockResolvedValueOnce({ parts: [{ type: 'text', text: 'second reply' }] });

		await Promise.all([chat.send('first'), chat.send('second')]);

		expect(mocked.createSession).toHaveBeenCalledTimes(1);
		expect(mocked.sendChatMessage.mock.calls).toEqual([
			['fresh', 'first'],
			['fresh', 'second'],
		]);
		expect(chat.entries.filter((entry): entry is ChatMessage => !entry.type).map((entry) => entry.text)).toEqual([
			'first',
			'first reply',
			'second',
			'second reply',
		]);
	});

	it('blocks an endpoint switch while the first send creates its session', async () => {
		mocked.listSessions.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		let releaseCreate: ((value: { id: string }) => void) | undefined;
		mocked.createSession.mockImplementationOnce(() => new Promise((resolve) => {
			releaseCreate = resolve;
		}));
		mocked.sendChatMessage.mockResolvedValueOnce({
			parts: [{ type: 'text', text: 'alpha reply' }],
		});

		const sending = chat.send('stay on alpha');
		while (!releaseCreate) await Promise.resolve();
		expect(chat.connectionActivationBlockReason()).toMatch(/current reply/i);
		expect(activationBlockReason()).toMatch(/current reply/i);
		await expect(chat.onEndpointChanged('beta')).resolves.toBe(false);
		expect(chat.activeEndpointId).toBe('alpha');

		releaseCreate({ id: 'alpha-session' });
		await sending;

		expect(mocked.createSession).toHaveBeenCalledTimes(1);
		expect(mocked.sendChatMessage).toHaveBeenCalledTimes(1);
		expect(mocked.sendChatMessage).toHaveBeenCalledWith('alpha-session', 'stay on alpha');
		expect(chat.activeEndpointId).toBe('alpha');
		expect(chat.connectionActivationBlockReason()).toBeNull();
	});

	it('rejects a send synchronously once activation has started', async () => {
		mocked.listSessions.mockResolvedValueOnce([session('alpha-session', 1000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		const releaseActivation = beginConnectionActivation();

		try {
			const attempted = chat.send('must not reach the old assistant');
			expect(mocked.sendChatMessage).not.toHaveBeenCalled();
			expect(chat.activeEndpointId).toBe('alpha');
			expect(chat.activeSessionId).toBe('alpha-session');
			expect(chat.entries).toEqual([]);
			expect(chat.error).toMatch(/connection.*switch/i);
			expect(chat.lastFailedText).toBe('must not reach the old assistant');
			await attempted;
			expect(mocked.sendChatMessage).not.toHaveBeenCalled();
		} finally {
			releaseActivation();
		}
	});

	it('plays the ack earcon and speaks the full reply on the non-streaming path when auto-TTS is enabled', async () => {
		voice.voiceState.ttsSupported = true;
		voice.voiceState.ttsAutoEnabled = true;
		mocked.listSessions.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');

		mocked.createSession.mockResolvedValueOnce({ id: 'fresh' });
		mocked.sendChatMessage.mockResolvedValueOnce({
			parts: [{ type: 'text', text: 'Here is the answer.' }],
		});

		await chat.send('Please help.');

		// The ack is the earcon — never a spoken phrase. The first speakText
		// in a turn is reply text.
		expect(vi.mocked(earcon.playAck)).toHaveBeenCalledTimes(1);
		// Nothing streamed, so the whole reply is spoken at finalize — text
		// only, no options (the LLM speech-prep plumbing is gone).
		expect(vi.mocked(voice.speakText)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(voice.speakText)).toHaveBeenNthCalledWith(1, 'Here is the answer.');
	});

	it('speaks completed sentences as they stream and only the remainder at turn end', async () => {
		voice.voiceState.ttsSupported = true;
		voice.voiceState.ttsAutoEnabled = true;
		mocked.listSessions.mockResolvedValueOnce([session('sess1', 1000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		sseCaptured.handlers?.onConnect?.();

		vi.mocked(api.startChatMessageTurn).mockResolvedValueOnce(undefined);

		const sendPromise = chat.send('tell me a story');
		await new Promise<void>((r) => setTimeout(r, 0));

		sseCaptured.handlers?.onEvent?.({
			type: 'message.part.delta',
			properties: { sessionID: 'sess1', delta: 'The first sentence is finished here. And then ' },
		});
		// The completed sentence is spoken immediately (the ack is the earcon,
		// so the first speakText is the first reply chunk).
		expect(vi.mocked(earcon.playAck)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(voice.speakText)).toHaveBeenNthCalledWith(
			1,
			'The first sentence is finished here.'
		);

		sseCaptured.handlers?.onEvent?.({
			type: 'message.part.delta',
			properties: { sessionID: 'sess1', delta: 'the tail arrives without punctuation' },
		});
		sseCaptured.handlers?.onEvent?.({
			type: 'session.idle',
			properties: { sessionID: 'sess1' },
		});
		await sendPromise;

		// finalizeTurn speaks only the unspoken remainder — never the full
		// reply again.
		expect(vi.mocked(voice.speakText)).toHaveBeenNthCalledWith(
			2,
			'And then the tail arrives without punctuation'
		);
		expect(vi.mocked(voice.speakText)).toHaveBeenCalledTimes(2);

		const assistantEntry = chat.entries.find(
			(e) => !e.type && (e as ChatMessage).role === 'assistant'
		) as ChatMessage | undefined;
		expect(assistantEntry?.text).toBe(
			'The first sentence is finished here. And then the tail arrives without punctuation'
		);
	});

	it('does not run the sentence streamer when auto-TTS is off', async () => {
		mocked.listSessions.mockResolvedValueOnce([session('sess1', 1000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		sseCaptured.handlers?.onConnect?.();

		vi.mocked(api.startChatMessageTurn).mockResolvedValueOnce(undefined);

		const sendPromise = chat.send('tell me a story');
		await new Promise<void>((r) => setTimeout(r, 0));

		sseCaptured.handlers?.onEvent?.({
			type: 'message.part.delta',
			properties: { sessionID: 'sess1', delta: 'A whole completed sentence right here. ' },
		});
		sseCaptured.handlers?.onEvent?.({
			type: 'session.idle',
			properties: { sessionID: 'sess1' },
		});
		await sendPromise;

		expect(vi.mocked(voice.speakText)).not.toHaveBeenCalled();
		// The toggle governs all audible feedback — the earcon stays silent too.
		expect(vi.mocked(earcon.playAck)).not.toHaveBeenCalled();
	});

	it('is rejected when already sending', async () => {
    chat.sending = true;
    await chat.send('hello');
    expect(mocked.sendChatMessage).not.toHaveBeenCalled();
  });

	it('removes the optimistic user entry and offers retry when the request is explicitly rejected', async () => {
		mocked.listSessions.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');

		mocked.createSession.mockResolvedValueOnce({ id: 'fresh' });
		mocked.sendChatMessage.mockRejectedValueOnce(
			Object.assign(new Error('rejected'), { status: 400 })
		);

		await chat.send('will fail');

		// The turn never reached the assistant — no optimistic user entry left behind.
		expect(chat.entries).toEqual([]);
		expect(chat.lastFailedText).toBe('will fail');
		expect(chat.error).toBeTruthy();
	});

	it('clears lastFailedText on the next successful send', async () => {
		mocked.listSessions.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');

		mocked.createSession.mockResolvedValueOnce({ id: 'fresh' });
		mocked.sendChatMessage.mockRejectedValueOnce(
			Object.assign(new Error('rejected'), { status: 400 })
		);
		await chat.send('will fail');
		expect(chat.lastFailedText).toBe('will fail');

		mocked.sendChatMessage.mockResolvedValueOnce({
			parts: [{ type: 'text', text: 'pong' }],
		});
		await chat.send('will fail');

		expect(chat.lastFailedText).toBe('');
		expect(chat.entries.length).toBe(2); // user + assistant, no leftover failed entry
	});

	it('preserves the initiating request and observed tool when the stream disconnects', async () => {
		mocked.listSessions.mockResolvedValueOnce([session('sess1', 1000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		sseCaptured.handlers?.onConnect?.();
		vi.mocked(api.startChatMessageTurn).mockResolvedValueOnce(undefined);

		const sendPromise = chat.send('publish the release');
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		sseCaptured.handlers?.onEvent?.({
			type: 'session.next.tool.completed',
			properties: { sessionID: 'sess1', callID: 'publish-1', tool: 'bash', output: 'published' },
		});
		sseCaptured.handlers?.onEvent?.({
			type: 'session.next.tool.called',
			properties: { sessionID: 'sess1', callID: 'verify-1', tool: 'read' },
		});
		sseCaptured.handlers?.onDisconnect?.(new Error('network lost'));
		await sendPromise;

		const userEntry = chat.entries.find(
			(entry): entry is ChatMessage => !entry.type && entry.role === 'user'
		);
		const toolGroup = chat.entries.find((entry) => entry.type === 'tool-group');
		expect(userEntry?.text).toBe('publish the release');
		expect(toolGroup?.toolStates).toMatchObject([
			{ id: 'publish-1', tool: 'bash', status: 'succeeded' },
			{ id: 'verify-1', tool: 'read', status: 'uncertain' },
		]);
		expect(chat.lastFailedText).toBe('');
		expect(chat.error).toContain('may have run');
	});

	it('preserves an ambiguously failed non-streaming request without offering blind retry', async () => {
		mocked.listSessions.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		mocked.createSession.mockResolvedValueOnce({ id: 'fresh' });
		mocked.sendChatMessage.mockRejectedValueOnce(new TypeError('network lost'));

		await chat.send('create the record');

		const userEntry = chat.entries.find(
			(entry): entry is ChatMessage => !entry.type && entry.role === 'user'
		);
		expect(userEntry?.text).toBe('create the record');
		expect(chat.lastFailedText).toBe('');
		expect(chat.error).toContain('may have run');
	});

	// finalizeTurn decision: an empty reply collapses to '(no response)' and
	// must NOT be spoken even with auto-TTS on (only the earcon ack fires).
	// This is the same guard the streaming path uses, shared via finalizeTurn.
	it('renders (no response) and speaks nothing for an empty non-streaming reply', async () => {
		voice.voiceState.ttsSupported = true;
		voice.voiceState.ttsAutoEnabled = true;
		mocked.listSessions.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');

		mocked.createSession.mockResolvedValueOnce({ id: 'fresh' });
		mocked.sendChatMessage.mockResolvedValueOnce({ parts: [] });

		await chat.send('anything');

		const assistantEntry = chat.entries.find(
			(e) => !e.type && (e as ChatMessage).role === 'assistant'
		) as ChatMessage | undefined;
		expect(assistantEntry?.text).toBe('(no response)');

		// Only the earcon ack fires; the '(no response)' reply is suppressed
		// and speakText is never called for an ack.
		expect(vi.mocked(earcon.playAck)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(voice.speakText)).not.toHaveBeenCalled();
	});
});

describe('stopTurn', () => {
	it('is a no-op when nothing is sending', async () => {
		expect(chat.sending).toBe(false);
		await chat.stopTurn();
		expect(mocked.abortChatTurn).not.toHaveBeenCalled();
		expect(chat.entries).toEqual([]);
	});

	it('finalizes partial streamed text unspoken and resolves the pending send', async () => {
		voice.voiceState.ttsSupported = true;
		voice.voiceState.ttsAutoEnabled = true;
		mocked.listSessions.mockResolvedValueOnce([session('sess1', 1000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		sseCaptured.handlers?.onConnect?.();

		mocked.abortChatTurn.mockResolvedValueOnce(undefined);
		vi.mocked(api.startChatMessageTurn).mockResolvedValueOnce(undefined);

		const sendPromise = chat.send('tell me a long story');
		await new Promise<void>((r) => setTimeout(r, 0));

		sseCaptured.handlers?.onEvent?.({
			type: 'message.part.delta',
			properties: { sessionID: 'sess1', delta: 'Once upon a time' },
		});
		expect(chat.pendingAssistantText).toBe('Once upon a time');

		await chat.stopTurn();
		// Never throws / rejects — a user-initiated stop is not an error.
		await expect(sendPromise).resolves.toBeUndefined();

		expect(mocked.abortChatTurn).toHaveBeenCalledWith('sess1');
		expect(chat.sending).toBe(false);

		const assistantEntry = chat.entries.find(
			(e) => !e.type && (e as ChatMessage).role === 'assistant'
		) as ChatMessage | undefined;
		expect(assistantEntry?.text).toBe('Once upon a time');

		// Only the earcon ack fired — the partial reply is never sent to TTS.
		expect(vi.mocked(earcon.playAck)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(voice.speakText)).not.toHaveBeenCalled();
	});

	it('appends a "Stopped." note and drops no assistant entry when nothing streamed yet', async () => {
		mocked.listSessions.mockResolvedValueOnce([session('sess1', 1000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		sseCaptured.handlers?.onConnect?.();

		mocked.abortChatTurn.mockResolvedValueOnce(undefined);
		vi.mocked(api.startChatMessageTurn).mockResolvedValueOnce(undefined);

		const sendPromise = chat.send('hello');
		await new Promise<void>((r) => setTimeout(r, 0));

		expect(chat.pendingAssistantText).toBe('');
		await chat.stopTurn();
		await expect(sendPromise).resolves.toBeUndefined();

		expect(chat.sending).toBe(false);
		const assistantEntries = chat.entries.filter(
			(e) => !e.type && (e as ChatMessage).role === 'assistant'
		);
		expect(assistantEntries.length).toBe(0);

		const note = chat.entries.find((e) => (e as { type?: string }).type === 'note') as
			| { type: 'note'; label: string; text: string }
			| undefined;
		expect(note?.label).toBe('Stopped');
		expect(note?.text).toBe('Stopped.');
	});

	it('preserves observed tool activity as stopped when the user stops the turn', async () => {
		mocked.listSessions.mockResolvedValueOnce([session('sess1', 1000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		sseCaptured.handlers?.onConnect?.();
		mocked.abortChatTurn.mockResolvedValueOnce(undefined);
		vi.mocked(api.startChatMessageTurn).mockResolvedValueOnce(undefined);

		const sendPromise = chat.send('start the operation');
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		sseCaptured.handlers?.onEvent?.({
			type: 'session.next.tool.called',
			properties: { sessionID: 'sess1', callID: 'operation-1', tool: 'bash' },
		});
		await chat.stopTurn();
		await sendPromise;

		const toolGroup = chat.entries.find((entry) => entry.type === 'tool-group');
		expect(toolGroup?.toolStates).toMatchObject([
			{ id: 'operation-1', status: 'stopped' },
		]);
	});

	it('finishes locally even when the upstream abort call fails', async () => {
		mocked.listSessions.mockResolvedValueOnce([session('sess1', 1000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		sseCaptured.handlers?.onConnect?.();

		mocked.abortChatTurn.mockRejectedValueOnce(new Error('endpoint unreachable'));
		vi.mocked(api.startChatMessageTurn).mockResolvedValueOnce(undefined);

		const sendPromise = chat.send('hello');
		await new Promise<void>((r) => setTimeout(r, 0));

		await chat.stopTurn();
		await expect(sendPromise).resolves.toBeUndefined();
		expect(chat.sending).toBe(false);
	});

	it('ignores a late turn-end SSE event for the already-stopped turn', async () => {
		mocked.listSessions.mockResolvedValueOnce([session('sess1', 1000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		sseCaptured.handlers?.onConnect?.();

		mocked.abortChatTurn.mockResolvedValueOnce(undefined);
		vi.mocked(api.startChatMessageTurn).mockResolvedValueOnce(undefined);

		const sendPromise = chat.send('hello');
		await new Promise<void>((r) => setTimeout(r, 0));

		await chat.stopTurn();
		await sendPromise;
		const entriesAfterStop = [...chat.entries];

		// A turn-end event that arrives after the stop must be a no-op: the
		// null-guard at the top of _onLiveEvent bails out once _pendingTurn
		// has been cleared by stopTurn().
		sseCaptured.handlers?.onEvent?.({
			type: 'session.idle',
			properties: { sessionID: 'sess1' },
		});

		expect(chat.entries).toEqual(entriesAfterStop);
	});
});

describe('sendUtterance', () => {
	it('barge-in during a streaming turn stops it (partial finalized unspoken) and sends the utterance', async () => {
		voice.voiceState.ttsSupported = true;
		voice.voiceState.ttsAutoEnabled = true;
		mocked.listSessions.mockResolvedValueOnce([session('sess1', 1000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		sseCaptured.handlers?.onConnect?.();

		mocked.abortChatTurn.mockResolvedValueOnce(undefined);
		vi.mocked(api.startChatMessageTurn).mockResolvedValue(undefined);

		const firstSend = chat.send('tell me a long story');
		await new Promise<void>((r) => setTimeout(r, 0));
		expect(chat.sending).toBe(true);

		sseCaptured.handlers?.onEvent?.({
			type: 'message.part.delta',
			properties: {
				sessionID: 'sess1',
				delta: 'The first sentence is done. And the rest is coming',
			},
		});
		// Streamed TTS spoke the completed sentence (the ack is the earcon,
		// so call 1 is the first reply chunk).
		expect(vi.mocked(voice.speakText)).toHaveBeenNthCalledWith(
			1,
			'The first sentence is done.'
		);

		// Barge-in: the user speaks while the reply is still generating.
		const bargePromise = chat.sendUtterance('actually do this instead');
		await expect(firstSend).resolves.toBeUndefined();

		// Wait for the second turn to register, then finish it over SSE.
		while (vi.mocked(api.startChatMessageTurn).mock.calls.length < 2) {
			await new Promise<void>((r) => setTimeout(r, 0));
		}
		sseCaptured.handlers?.onEvent?.({
			type: 'message.part.delta',
			properties: { sessionID: 'sess1', delta: 'New reply.' },
		});
		sseCaptured.handlers?.onEvent?.({
			type: 'session.idle',
			properties: { sessionID: 'sess1' },
		});
		await bargePromise;

		// The interrupted turn was aborted upstream and TTS was halted.
		expect(mocked.abortChatTurn).toHaveBeenCalledWith('sess1');
		expect(vi.mocked(voice.stopSpeaking)).toHaveBeenCalled();

		// The utterance was NOT lost — it went out as the second turn.
		expect(vi.mocked(api.startChatMessageTurn)).toHaveBeenNthCalledWith(
			2,
			'sess1',
			'actually do this instead'
		);

		// Transcript order: user, partial assistant, barge-in user, new assistant.
		const texts = chat.entries
			.filter((e): e is ChatMessage => !e.type)
			.map((e) => `${e.role}:${e.text}`);
		expect(texts).toEqual([
			'user:tell me a long story',
			'assistant:The first sentence is done. And the rest is coming',
			'user:actually do this instead',
			'assistant:New reply.',
		]);

		// The interrupted reply's unspoken remainder is never sent to TTS.
		const spoken = vi.mocked(voice.speakText).mock.calls.map((c) => c[0]);
		expect(spoken.some((t) => String(t).includes('And the rest is coming'))).toBe(false);
		expect(chat.sending).toBe(false);
	});

	it('sends normally (no stop) when nothing is in flight', async () => {
		mocked.listSessions.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');

		mocked.createSession.mockResolvedValueOnce({ id: 'fresh' });
		mocked.sendChatMessage.mockResolvedValueOnce({
			parts: [{ type: 'text', text: 'pong' }],
		});

		await chat.sendUtterance('ping');

		expect(mocked.abortChatTurn).not.toHaveBeenCalled();
		expect(mocked.sendChatMessage).toHaveBeenCalledWith('fresh', 'ping');
		expect(chat.entries.length).toBe(2); // user + assistant
	});

	it('routes the utterance as the answer (no stop) when a question is pending', async () => {
		chat.sending = true;
		chat.pendingQuestion = {
			requestID: 'q1',
			questions: [{ question: 'Proceed?', header: '', options: [] }],
			status: 'pending',
			answers: [''],
			message: '',
		};
		vi.mocked(api.replyChatQuestion).mockResolvedValueOnce(undefined);

		await chat.sendUtterance('yes please');

		expect(mocked.abortChatTurn).not.toHaveBeenCalled();
		expect(vi.mocked(api.replyChatQuestion)).toHaveBeenCalledWith('q1', [['yes please']]);
		chat.sending = false;
	});

	it('surfaces a retry instead of silently dropping the utterance when sending never clears', async () => {
		mocked.listSessions.mockResolvedValueOnce([session('sess1', 1000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		// No onConnect(): the non-SSE fallback path has no pending-turn promise
		// for stopTurn() to resolve, so `sending` stays true past the wait loop.
		mocked.sendChatMessage.mockReturnValueOnce(new Promise(() => {}));
		mocked.abortChatTurn.mockResolvedValueOnce(undefined);

		void chat.send('slow question');
		await new Promise<void>((r) => setTimeout(r, 0));
		expect(chat.sending).toBe(true);

		await chat.sendUtterance('barge in text');

		expect(chat.lastFailedText).toBe('barge in text');
		expect(chat.error).toContain('retry');
		// The utterance was not silently forwarded into send()'s no-op guard.
		expect(mocked.sendChatMessage).toHaveBeenCalledTimes(1);
		expect(vi.mocked(api.startChatMessageTurn)).not.toHaveBeenCalled();
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

describe('tool grouping — finalized turn', () => {
  it('attaches tool states to the assistant entry via SSE events during the turn', async () => {
    mocked.listSessions.mockResolvedValueOnce([session('sess1', 1000)]);
    mocked.getSessionMessages.mockResolvedValueOnce([]);
    await chat.onEndpointChanged('alpha');

    // Mark SSE connected so chat.send() uses the SSE path.
    sseCaptured.handlers?.onConnect?.();
    expect(chat.liveConnected).toBe(true);

    // startChatMessageTurn resolves immediately (fire-and-forget internally).
    vi.mocked(api.startChatMessageTurn).mockResolvedValueOnce(undefined);

    // Run send() and interleave SSE events after the turn is registered.
    // We drive the events inside a microtask after send() begins waiting.
    const sendPromise = chat.send('run some tools');

    // Yield to let send() register _pendingTurn (startChatMessageTurn is async
    // but resolves quickly; one macrotask is enough).
    await new Promise<void>((r) => setTimeout(r, 0));

    // Two tool completions over SSE (session.next.tool.completed format).
    sseCaptured.handlers?.onEvent?.({
      type: 'session.next.tool.completed',
      properties: { sessionID: 'sess1', callID: 'c1', tool: 'bash', output: 'ok' },
    });
    sseCaptured.handlers?.onEvent?.({
      type: 'session.next.tool.completed',
      properties: { sessionID: 'sess1', callID: 'c2', tool: 'read', output: 'content' },
    });

    // Text delta then turn end.
    sseCaptured.handlers?.onEvent?.({
      type: 'message.part.delta',
      properties: { sessionID: 'sess1', delta: 'Done!' },
    });
    sseCaptured.handlers?.onEvent?.({
      type: 'session.idle',
      properties: { sessionID: 'sess1' },
    });

    await sendPromise;

    // 1 user entry + 1 assistant entry — no separate tool entries.
    const assistantEntries = chat.entries.filter(
      (e) => !e.type && (e as ChatMessage).role === 'assistant'
    );
    expect(assistantEntries.length).toBe(1);

    const assistantEntry = assistantEntries[0] as ChatMessage;
    expect(assistantEntry.toolStates).toBeDefined();
    expect(assistantEntry.toolStates?.length).toBe(2);
    expect(assistantEntry.toolStates?.[0].id).toBe('c1');
    expect(assistantEntry.toolStates?.[1].id).toBe('c2');
		const userEntry = chat.entries.find(
			(entry): entry is ChatMessage => !entry.type && entry.role === 'user'
		);
		expect(chat.toolLog.map((tool) => tool.turnKey)).toEqual([
			userEntry?.id,
			userEntry?.id,
		]);

    // No standalone tool-group entries in the transcript.
    const toolEntries = chat.entries.filter(
      (e) =>
        (e as { type?: string }).type === 'tool' ||
        (e as { type?: string }).type === 'tool-group'
    );
    expect(toolEntries.length).toBe(0);

    // pendingToolStates must be cleared after finalization.
    expect(chat.pendingToolStates.length).toBe(0);
  });

  it('assistant entry has no toolStates when no tools fired during the turn', async () => {
    mocked.listSessions.mockResolvedValueOnce([]);
    await chat.onEndpointChanged('alpha');

    mocked.createSession.mockResolvedValueOnce({ id: 'sess2' });
    await chat.startNewSession();

    mocked.sendChatMessage.mockResolvedValueOnce({
      parts: [{ type: 'text', text: 'Simple answer.' }],
    });

    await chat.send('hello');

    const assistantEntry = chat.entries.find(
      (e) => !e.type && (e as ChatMessage).role === 'assistant'
    ) as ChatMessage | undefined;
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry?.toolStates).toBeUndefined();
  });
});

describe('tool grouping — session reload (getSessionMessages)', () => {
  it('groups tools into the assistant message toolStates on reload', async () => {
    const toolState: ToolStripEntry = {
      id: 'c1',
      kind: 'tool',
      tool: 'bash',
      status: 'completed',
      title: 'bash',
      detail: '',
      output: 'result',
      error: '',
      updatedAt: 1000,
    };
    const assistantMsg: ChatMessage = {
      id: 'msg1',
      role: 'assistant',
      text: 'Done.',
      timestamp: 2000,
      toolStates: [toolState],
    };
    mocked.listSessions.mockResolvedValueOnce([{ id: 's1', title: '', createdAt: 1, updatedAt: 2 }]);
    mocked.getSessionMessages.mockResolvedValueOnce([assistantMsg]);
    await chat.onEndpointChanged('alpha');

    expect(chat.entries.length).toBe(1);
    const entry = chat.entries[0] as ChatMessage;
    expect(entry.role).toBe('assistant');
    expect(entry.toolStates).toBeDefined();
    expect(entry.toolStates?.[0].id).toBe('c1');
  });
});

describe('live SSE updates', () => {
  it('subscribes to session events when an endpoint is activated', async () => {
    mocked.listSessions.mockResolvedValueOnce([]);
    await chat.onEndpointChanged('alpha');
    expect(mocked.subscribeSessionEvents).toHaveBeenCalledTimes(1);
    expect(sseCaptured.handlers).not.toBeNull();
  });

  it('tears down the prior subscription on endpoint switch', async () => {
    mocked.listSessions.mockResolvedValueOnce([]);
    await chat.onEndpointChanged('alpha');
    const firstUnsub = sseCaptured.unsub;
    expect(firstUnsub).not.toHaveBeenCalled();

    mocked.listSessions.mockResolvedValueOnce([]);
    await chat.onEndpointChanged('beta');
    expect(firstUnsub).toHaveBeenCalledTimes(1);
    expect(mocked.subscribeSessionEvents).toHaveBeenCalledTimes(2);
  });

	it('ignores events from an endpoint subscription replaced by a newer switch', async () => {
		mocked.listSessions.mockResolvedValueOnce([session('alpha-session', 1000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		const alphaHandlers = sseSubscriptions[0];

		mocked.listSessions.mockResolvedValueOnce([session('beta-session', 2000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('beta');
		alphaHandlers.onCreated('late-alpha-session');

		expect(chat.activeEndpointId).toBe('beta');
		expect(chat.byEndpoint.get('beta')?.sessions.map((item) => item.id)).toEqual([
			'beta-session',
		]);
	});

  it('reset() tears down the subscription and clears liveConnected', async () => {
    mocked.listSessions.mockResolvedValueOnce([]);
    await chat.onEndpointChanged('alpha');
    sseCaptured.handlers?.onConnect?.();
    expect(chat.liveConnected).toBe(true);

    chat.reset();
    expect(sseCaptured.unsub).toHaveBeenCalled();
    expect(chat.liveConnected).toBe(false);
  });

  it('session.created prepends to the active endpoint session list', async () => {
    mocked.listSessions.mockResolvedValueOnce([session('s1', 1000)]);
    mocked.getSessionMessages.mockResolvedValueOnce([]);
    await chat.onEndpointChanged('alpha');
    expect(chat.byEndpoint.get('alpha')?.sessions.map((s) => s.id)).toEqual(['s1']);

    sseCaptured.handlers?.onCreated('new-1');
    const sessions = chat.byEndpoint.get('alpha')?.sessions ?? [];
    expect(sessions.map((s) => s.id)).toEqual(['new-1', 's1']);
    // Does NOT auto-switch to the new session.
    expect(chat.activeSessionId).toBe('s1');
  });

  it('session.created is idempotent when the id is already present', async () => {
    mocked.listSessions.mockResolvedValueOnce([session('s1', 1000)]);
    mocked.getSessionMessages.mockResolvedValueOnce([]);
    await chat.onEndpointChanged('alpha');
    sseCaptured.handlers?.onCreated('s1');
    const sessions = chat.byEndpoint.get('alpha')?.sessions ?? [];
    expect(sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('session.updated patches title + updatedAt and re-sorts the list', async () => {
    mocked.listSessions.mockResolvedValueOnce([
      session('s2', 2000),
      session('s1', 1000),
    ]);
    mocked.getSessionMessages.mockResolvedValueOnce([]);
    await chat.onEndpointChanged('alpha');

    sseCaptured.handlers?.onUpdated('s1', { title: 'Renamed', updatedAt: 9999 });
    const sessions = chat.byEndpoint.get('alpha')?.sessions ?? [];
    expect(sessions[0].id).toBe('s1');
    expect(sessions[0].title).toBe('Renamed');
    expect(sessions[0].updatedAt).toBe(9999);
  });

	it('does not let a stale list erase a created event or resurrect a deleted session', async () => {
		mocked.listSessions.mockResolvedValueOnce([session('old', 1000)]);
		mocked.getSessionMessages.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');
		expect(persistedSessions.get('alpha')).toBe('old');

		let releaseList: ((sessions: SessionSummary[]) => void) | undefined;
		mocked.listSessions.mockImplementationOnce(() => new Promise((resolve) => {
			releaseList = resolve;
		}));
		mocked.listSessions.mockResolvedValueOnce([session('new', 2000)]);
		const refresh = chat.loadSessions();
		await Promise.resolve();
		sseCaptured.handlers?.onCreated('new');
		mocked.getSessionMessages.mockResolvedValueOnce([
			{ id: 'new-message', role: 'assistant', text: 'new transcript', timestamp: 2 },
		]);
		sseCaptured.handlers?.onDeleted('old');
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		releaseList?.([session('old', 1000)]);
		await refresh;

		expect(chat.byEndpoint.get('alpha')?.sessions.map((item) => item.id)).toEqual(['new']);
		expect(chat.activeSessionId).toBe('new');
		expect(chat.entries).toMatchObject([{ text: 'new transcript' }]);
		expect(persistedSessions.get('alpha')).toBe('new');
		expect(mocked.getSessionMessages).toHaveBeenCalledTimes(2);
	});

	it('retries session resolution when deletion arrives while reading the persisted cursor', async () => {
		persistedSessions.set('alpha', 'old');
		mocked.listSessions
			.mockResolvedValueOnce([session('old', 2000), session('new', 1000)])
			.mockResolvedValueOnce([session('new', 1000)]);
		let releaseCursor: ((value: string | null) => void) | undefined;
		cursorStore.getLastSessionId.mockImplementationOnce(() => new Promise((resolve) => {
			releaseCursor = resolve;
		}));
		mocked.getSessionMessages.mockResolvedValueOnce([
			{ id: 'new-message', role: 'assistant', text: 'new transcript', timestamp: 2 },
		]);

		const loading = chat.onEndpointChanged('alpha');
		while (!releaseCursor) await Promise.resolve();
		sseCaptured.handlers?.onDeleted('old');
		releaseCursor('old');
		await loading;

		expect(mocked.listSessions).toHaveBeenCalledTimes(2);
		expect(mocked.getSessionMessages).toHaveBeenCalledWith('new');
		expect(chat.activeSessionId).toBe('new');
		expect(chat.entries).toMatchObject([{ text: 'new transcript' }]);
		expect(persistedSessions.get('alpha')).toBe('new');
	});

	it('retries an empty list when a created event arrives while clearing its cursor', async () => {
		mocked.listSessions
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([session('new', 1000)]);
		let releaseCursorWrite: (() => void) | undefined;
		cursorStore.setLastSessionId.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				releaseCursorWrite = resolve;
			});
		});
		mocked.getSessionMessages.mockResolvedValueOnce([
			{ id: 'new-message', role: 'assistant', text: 'created transcript', timestamp: 2 },
		]);

		const loading = chat.onEndpointChanged('alpha');
		while (!releaseCursorWrite) await Promise.resolve();
		sseCaptured.handlers?.onCreated('new');
		releaseCursorWrite();
		await loading;

		expect(mocked.listSessions).toHaveBeenCalledTimes(2);
		expect(chat.activeSessionId).toBe('new');
		expect(chat.entries).toMatchObject([{ text: 'created transcript' }]);
		expect(persistedSessions.get('alpha')).toBe('new');
	});

  it('session.deleted of an inactive session just removes it', async () => {
    mocked.listSessions.mockResolvedValueOnce([
      session('s2', 2000),
      session('s1', 1000),
    ]);
    mocked.getSessionMessages.mockResolvedValueOnce([]);
    await chat.onEndpointChanged('alpha');
    expect(chat.activeSessionId).toBe('s2');

    sseCaptured.handlers?.onDeleted('s1');
    expect(chat.byEndpoint.get('alpha')?.sessions.map((s) => s.id)).toEqual(['s2']);
    expect(chat.activeSessionId).toBe('s2');
  });

  it('session.deleted of the active session falls back to the newest remaining', async () => {
    mocked.listSessions.mockResolvedValueOnce([
      session('s2', 2000),
      session('s1', 1000),
    ]);
    mocked.getSessionMessages.mockResolvedValueOnce([]); // initial pick (s2)
    await chat.onEndpointChanged('alpha');
    expect(chat.activeSessionId).toBe('s2');

    const newMsgs: ChatMessage[] = [
      { id: 'fallback', role: 'user', text: 'on s1', timestamp: 1 },
    ];
    mocked.getSessionMessages.mockResolvedValueOnce(newMsgs);
    await sseCaptured.handlers?.onDeleted('s2');
    expect(chat.activeSessionId).toBe('s1');
    expect(chat.entries).toEqual(newMsgs);
  });

  it('liveConnected mirrors onConnect / onDisconnect', async () => {
    mocked.listSessions.mockResolvedValueOnce([]);
    await chat.onEndpointChanged('alpha');
    expect(chat.liveConnected).toBe(false);
    sseCaptured.handlers?.onConnect?.();
    expect(chat.liveConnected).toBe(true);
    sseCaptured.handlers?.onDisconnect?.(new Error('boom'));
    expect(chat.liveConnected).toBe(false);
  });
});
