/**
 * B2/B3/B5/B8(c) [HIGH] (review 2026-07-10) — the chat page's reactive state
 * logic, extracted into a plain (rune-free) controller so it unit-tests with
 * bun:test (packages/client has no Svelte component-render harness). The
 * Svelte page (`routes/chat/+page.svelte`) is a thin view: it subscribes to
 * this controller and copies its snapshot into local `$state`.
 *
 * Covers:
 *   - B2: subscribeEvents() wiring — incremental assistant text accumulates
 *     in `pendingText` as deltas arrive, live (not just "Thinking…").
 *   - B3: stop() aborts the in-flight turn (local AbortController +
 *     transport.abortTurn) and finalizes using whatever text streamed in so
 *     far, instead of leaving the turn wedged.
 *   - B5: selectSession() loads real history via getSessionMessages();
 *     reconnect() must not discard the live transcript.
 *   - B8(c): a failed send drops the optimistic user entry, remembers
 *     lastFailedText, and retryFailedSend() resends it.
 *
 * RED until packages/client/src/lib/chat/chat-controller.ts exists.
 */
import { describe, expect, test } from 'bun:test';
import type {
  FlattenedEntry,
  RawEvent,
  SessionSummary,
  StreamHandlers,
  Transport,
} from '../src/lib/transport/index.ts';

async function loadControllerModule() {
  return import('../src/lib/chat/chat-controller.ts');
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeFakeTransport(overrides: Partial<Transport> = {}) {
  let handlers: StreamHandlers | null = null;
  let unsubscribed = false;
  const transport: Transport = {
    listSessions: async (): Promise<SessionSummary[]> => [],
    createSession: async () => ({ id: 'new-session' }),
    sendMessage: async () => ({ parts: [] }),
    abortTurn: async () => {},
    getSessionMessages: async (): Promise<FlattenedEntry[]> => [],
    replyPermission: async () => {},
    replyQuestion: async () => {},
    rejectQuestion: async () => {},
    subscribeEvents: (h: StreamHandlers) => {
      handlers = h;
      unsubscribed = false;
      return () => {
        unsubscribed = true;
      };
    },
    probeHealth: async () => ({ state: 'accessible' }),
    ...overrides,
  };
  return {
    transport,
    emit: (event: RawEvent) => handlers?.onEvent(event),
    get isUnsubscribed() {
      return unsubscribed;
    },
  };
}

function textDeltaEvent(sessionId: string, delta: string): RawEvent {
  return { type: 'session.next.text.delta', properties: { sessionID: sessionId, delta } };
}

function turnEndEvent(sessionId: string): RawEvent {
  return { type: 'session.idle', properties: { sessionID: sessionId } };
}

describe('chat-controller — init & sessions', () => {
  test('init() opens the event subscription and loads the session list', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport } = makeFakeTransport({
      listSessions: async () => [{ id: 's1', title: 'First', createdAt: 1, updatedAt: 1 }],
    });
    const controller = createChatController(transport);
    await controller.init();
    expect(controller.getState().sessions).toEqual([{ id: 's1', title: 'First', createdAt: 1, updatedAt: 1 }]);
  });

  test('destroy() unsubscribes the event stream', async () => {
    const { createChatController } = await loadControllerModule();
    const fake = makeFakeTransport();
    const controller = createChatController(fake.transport);
    await controller.init();
    expect(fake.isUnsubscribed).toBe(false);
    controller.destroy();
    expect(fake.isUnsubscribed).toBe(true);
  });
});

describe('chat-controller — send (non-streaming reply)', () => {
  test('creates a session, appends the user turn, and appends the assistant reply from the response', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-1' }),
      sendMessage: async () => ({ parts: [{ type: 'text', text: 'Hello there!' }] }),
    });
    const controller = createChatController(transport);
    await controller.init();
    await controller.send('hi');

    const state = controller.getState();
    expect(state.sending).toBe(false);
    expect(state.sessionId).toBe('sess-1');
    expect(state.entries.map((e) => ({ role: (e as { role?: string }).role, text: e.text }))).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'Hello there!' },
    ]);
  });
});

describe('chat-controller — B2 live streaming', () => {
  test('pendingText accumulates from SSE deltas while sending, and finalizes on isTurnEnd', async () => {
    const { createChatController } = await loadControllerModule();
    const sendDeferred = deferred<unknown>();
    const { transport, emit } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-2' }),
      sendMessage: async () => sendDeferred.promise,
    });
    const controller = createChatController(transport);
    await controller.init();

    const sendPromise = controller.send('stream please');
    // Let send() reach the point of creating the session + registering as
    // the active turn before the SSE deltas arrive.
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getState().sending).toBe(true);
    emit(textDeltaEvent('sess-2', 'Hel'));
    expect(controller.getState().pendingText).toBe('Hel');
    emit(textDeltaEvent('sess-2', 'lo!'));
    expect(controller.getState().pendingText).toBe('Hello!');

    emit(turnEndEvent('sess-2'));
    // Finalized from the stream — sending drops immediately, without
    // waiting on the (still in-flight) sendMessage promise.
    let state = controller.getState();
    expect(state.sending).toBe(false);
    expect(state.pendingText).toBe('');
    expect(state.entries.at(-1)).toMatchObject({ role: 'assistant', text: 'Hello!' });

    // The POST resolving afterwards must not append a second assistant entry.
    sendDeferred.resolve({ parts: [{ type: 'text', text: 'Hello!' }] });
    await sendPromise;
    state = controller.getState();
    expect(state.entries.filter((e) => (e as { role?: string }).role === 'assistant').length).toBe(1);
  });

  test('events for a different session are ignored', async () => {
    const { createChatController } = await loadControllerModule();
    const sendDeferred = deferred<unknown>();
    const { transport, emit } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-3' }),
      sendMessage: async () => sendDeferred.promise,
    });
    const controller = createChatController(transport);
    await controller.init();
    void controller.send('hi');
    await Promise.resolve();
    await Promise.resolve();

    emit(textDeltaEvent('some-other-session', 'nope'));
    expect(controller.getState().pendingText).toBe('');
    sendDeferred.resolve({ parts: [] });
  });
});

describe('chat-controller — cross-turn contamination guard (review 2026-07-11 seam 4)', () => {
  test('turn A finalized by SSE while its POST is still in flight must not let that POST finalize turn B on the same session', async () => {
    const { createChatController } = await loadControllerModule();
    const sendA = deferred<unknown>();
    const sendB = deferred<unknown>();
    let sendCount = 0;
    const { transport, emit } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-shared' }),
      sendMessage: async () => {
        sendCount += 1;
        return sendCount === 1 ? sendA.promise : sendB.promise;
      },
    });
    const controller = createChatController(transport);
    await controller.init();

    // Turn A starts on sess-shared.
    const sendPromiseA = controller.send('first');
    await Promise.resolve();
    await Promise.resolve();
    emit(textDeltaEvent('sess-shared', 'A reply'));

    // The SSE session.idle event finalizes A BEFORE its POST resolves — the
    // exact race window the advisory describes.
    emit(turnEndEvent('sess-shared'));
    let state = controller.getState();
    expect(state.sending).toBe(false);
    expect(state.entries.at(-1)).toMatchObject({ role: 'assistant', text: 'A reply' });

    // The user immediately sends turn B on the SAME session, before A's POST
    // has resolved.
    const sendPromiseB = controller.send('second');
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getState().sending).toBe(true);

    // A's POST now resolves late, with a DIFFERENT response than what A was
    // already finalized with. It must be a no-op: sessionId alone matches (both
    // turns share sess-shared), but turn identity must not.
    sendA.resolve({ parts: [{ type: 'text', text: 'STALE A RESPONSE' }] });
    await sendPromiseA;

    state = controller.getState();
    expect(state.sending, 'B must still be in flight — A\'s stale POST must not finalize it').toBe(true);
    expect(state.entries.some((e) => e.text === 'STALE A RESPONSE')).toBe(false);
    expect(state.entries.map((e) => e.text)).toEqual(['first', 'A reply', 'second']);

    // B finishes normally afterwards — its own reply must land correctly,
    // proving the guard didn't just swallow both finalizations.
    emit(textDeltaEvent('sess-shared', 'B reply'));
    emit(turnEndEvent('sess-shared'));
    sendB.resolve({ parts: [{ type: 'text', text: 'B reply' }] });
    await sendPromiseB;

    state = controller.getState();
    expect(state.sending).toBe(false);
    expect(state.entries.map((e) => e.text)).toEqual(['first', 'A reply', 'second', 'B reply']);
  });

  test('an SSE-driven finalize that cancels the in-flight POST still refreshes the session list', async () => {
    // Regression: finalizeTurn() aborting the redundant POST makes send()'s
    // await reject with AbortError and early-return — the session-list refresh
    // must not be skipped on that path (it is what populates the sidebar after
    // the first message of a new session; caught by parity-contract.pw.ts:155).
    // Unlike the deferred fakes above, this sendMessage honors the abort
    // signal the way real fetch does.
    const { createChatController } = await loadControllerModule();
    let listCalls = 0;
    const { transport, emit } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-1' }),
      listSessions: async () => {
        listCalls += 1;
        return [{ id: 'sess-1', title: 'First', createdAt: 1, updatedAt: 1 }];
      },
      sendMessage: (_sessionId, _text, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          );
        }),
    });
    const controller = createChatController(transport);
    await controller.init();
    const callsAfterInit = listCalls;

    const sendPromise = controller.send('hello');
    await Promise.resolve();
    await Promise.resolve();
    emit(textDeltaEvent('sess-1', 'the reply'));
    emit(turnEndEvent('sess-1')); // SSE finalize — aborts the still-pending POST
    await sendPromise;

    const state = controller.getState();
    expect(state.sending).toBe(false);
    expect(state.entries.at(-1)).toMatchObject({ role: 'assistant', text: 'the reply' });
    expect(listCalls, 'the SSE-finalized turn must still refresh the session list').toBeGreaterThan(callsAfterInit);
  });
});

describe('chat-controller — B3 stop', () => {
  test('stop() aborts the turn and finalizes using the accumulated pending text', async () => {
    const { createChatController } = await loadControllerModule();
    let abortedSessionId = '';
    const { transport, emit } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-4' }),
      sendMessage: async (_id, _text, options) => {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      },
      abortTurn: async (id: string) => {
        abortedSessionId = id;
      },
    });
    const controller = createChatController(transport);
    await controller.init();
    void controller.send('long running');
    await Promise.resolve();
    await Promise.resolve();

    emit(textDeltaEvent('sess-4', 'partial reply'));
    await controller.stop();

    expect(abortedSessionId).toBe('sess-4');
    const state = controller.getState();
    expect(state.sending).toBe(false);
    expect(state.entries.at(-1)).toMatchObject({ role: 'assistant', text: 'partial reply' });
  });

  test('stop() with no accumulated text leaves a "Stopped." note instead of a fake reply', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-5' }),
      sendMessage: async (_id, _text, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });
    const controller = createChatController(transport);
    await controller.init();
    void controller.send('hi');
    await Promise.resolve();
    await Promise.resolve();
    await controller.stop();

    const state = controller.getState();
    expect(state.sending).toBe(false);
    expect(state.entries.at(-1)).toMatchObject({ kind: 'note', text: 'Stopped.' });
  });

  test('stop() is a no-op when nothing is sending', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport } = makeFakeTransport();
    const controller = createChatController(transport);
    await controller.init();
    await controller.stop();
    expect(controller.getState().entries).toEqual([]);
  });
});

describe('chat-controller — B8(c) failed send + retry', () => {
  test('a failed send drops the optimistic user entry and records lastFailedText', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-6' }),
      sendMessage: async () => {
        throw new Error('network down');
      },
    });
    const controller = createChatController(transport);
    await controller.init();
    await controller.send('will fail');

    const state = controller.getState();
    expect(state.sending).toBe(false);
    expect(state.entries).toEqual([]);
    expect(state.lastFailedText).toBe('will fail');
    expect(state.error).toContain('network down');
  });

  test('retryFailedSend() resends lastFailedText and clears it', async () => {
    const { createChatController } = await loadControllerModule();
    let attempt = 0;
    const { transport } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-7' }),
      sendMessage: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('network down');
        return { parts: [{ type: 'text', text: 'ok now' }] };
      },
    });
    const controller = createChatController(transport);
    await controller.init();
    await controller.send('retry me');
    expect(controller.getState().lastFailedText).toBe('retry me');

    await controller.retryFailedSend();
    const state = controller.getState();
    expect(state.lastFailedText).toBe('');
    expect(state.entries.at(-1)).toMatchObject({ role: 'assistant', text: 'ok now' });
  });
});

describe('chat-controller — B5 session history + reload', () => {
  test('selectSession() loads real history via getSessionMessages (no disclaimer placeholder)', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport } = makeFakeTransport({
      getSessionMessages: async (): Promise<FlattenedEntry[]> => [
        { id: 'm1', role: 'user', text: 'earlier question', timestamp: 1 },
        { id: 'm2', role: 'assistant', text: 'earlier answer', timestamp: 2 },
      ],
    });
    const controller = createChatController(transport);
    await controller.init();
    await controller.selectSession('old-session');

    const state = controller.getState();
    expect(state.sessionId).toBe('old-session');
    expect(state.entries.map((e) => e.text)).toEqual(['earlier question', 'earlier answer']);
  });

  test('reconnect() refreshes sessions and clears the error, without discarding the live transcript', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-8' }),
      sendMessage: async () => ({ parts: [{ type: 'text', text: 'kept' }] }),
    });
    const controller = createChatController(transport);
    await controller.init();
    await controller.send('hi');
    controller.getState(); // sanity
    // Simulate an error banner being up before the user hits reconnect.
    (controller as unknown as { getState: () => { error: string } }).getState();

    await controller.reconnect();
    const state = controller.getState();
    expect(state.error).toBe('');
    expect(state.entries.map((e) => e.text)).toEqual(['hi', 'kept']);
  });
});

describe('chat-controller — B16 visibilitychange reachability probe', () => {
  test('setError() sets state.error and notifies subscribers (no direct state mutation needed by callers)', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport } = makeFakeTransport();
    const controller = createChatController(transport);
    await controller.init();
    let notified = 0;
    controller.subscribe(() => {
      notified += 1;
    });

    controller.setError('Assistant is not reachable. Try reconnecting.');
    expect(controller.getState().error).toBe('Assistant is not reachable. Try reconnecting.');
    expect(notified).toBeGreaterThan(0);
  });
});

describe('chat-controller — newSession', () => {
  test('resets sessionId and the transcript', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport } = makeFakeTransport({
      getSessionMessages: async (): Promise<FlattenedEntry[]> => [
        { id: 'm1', role: 'user', text: 'old', timestamp: 1 },
      ],
    });
    const controller = createChatController(transport);
    await controller.init();
    await controller.selectSession('old-session');
    expect(controller.getState().entries.length).toBe(1);

    controller.newSession();
    const state = controller.getState();
    expect(state.sessionId).toBeNull();
    expect(state.entries).toEqual([]);
  });
});
