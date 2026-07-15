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
  getSessionMessages: vi.fn(),
  listSessions: vi.fn(),
  sendChatMessage: vi.fn(),
  startChatMessageTurn: vi.fn(),
  replyChatPermission: vi.fn(),
  replyChatQuestion: vi.fn(),
  rejectChatQuestion: vi.fn(),
}));

// Mock the SSE consumer so chat-state tests don't open network sockets.
// `subscribeSessionEvents` is the only export we care about here — the real
// behavior is exercised in session-events.vitest.ts.
type CapturedHandlers = import('./session-events.js').SessionEventHandlers;
const sseCaptured: { handlers: CapturedHandlers | null; unsub: ReturnType<typeof vi.fn> } = {
  handlers: null,
  unsub: vi.fn(),
};
vi.mock('./session-events.js', () => ({
  subscribeSessionEvents: vi.fn((handlers: CapturedHandlers) => {
    sseCaptured.handlers = handlers;
    return sseCaptured.unsub;
  }),
}));

import * as api from '$lib/api.js';
import * as voice from '$lib/voice/voice-state.svelte.js';
import * as earcon from '$lib/voice/earcon.js';
import * as sse from './session-events.js';
import type { SessionSummary, ChatMessage } from '$lib/types.js';
import type { ToolStripEntry } from '$lib/chat/tool-strip.js';
import { chat } from './chat-state.svelte.js';

const mocked = {
  abortChatTurn: vi.mocked(api.abortChatTurn),
  createSession: vi.mocked(api.createSession),
  getSessionMessages: vi.mocked(api.getSessionMessages),
  listSessions: vi.mocked(api.listSessions),
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
  mocked.getSessionMessages.mockReset();
  mocked.listSessions.mockReset();
	mocked.sendChatMessage.mockReset();
	vi.mocked(voice.speakText).mockReset();
	vi.mocked(earcon.playAck).mockReset();
	voice.voiceState.ttsSupported = false;
	voice.voiceState.ttsAutoEnabled = false;
	sseCaptured.handlers = null;
	sseCaptured.unsub.mockReset();
	mocked.subscribeSessionEvents.mockClear();
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

	it('removes the optimistic user entry and records lastFailedText when the send fails', async () => {
		mocked.listSessions.mockResolvedValueOnce([]);
		await chat.onEndpointChanged('alpha');

		mocked.createSession.mockResolvedValueOnce({ id: 'fresh' });
		mocked.sendChatMessage.mockRejectedValueOnce(new Error('boom'));

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
		mocked.sendChatMessage.mockRejectedValueOnce(new Error('boom'));
		await chat.send('will fail');
		expect(chat.lastFailedText).toBe('will fail');

		mocked.sendChatMessage.mockResolvedValueOnce({
			parts: [{ type: 'text', text: 'pong' }],
		});
		await chat.send('will fail');

		expect(chat.lastFailedText).toBe('');
		expect(chat.entries.length).toBe(2); // user + assistant, no leftover failed entry
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
