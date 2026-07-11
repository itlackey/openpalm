/**
 * PR #562 xhigh review fix-round — chat-controller.ts findings F1, F3, F5,
 * F8, F9, F10, F12. Each describe block below is test-first for exactly one
 * finding; see the fix-round task's finding text for the file:line this was
 * read against (chat-controller.ts at the PR tip).
 *
 * RED until chat-controller.ts is patched for each finding respectively.
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

async function startTurn(controller: { send(text: string): Promise<void> }): Promise<void> {
  void controller.send('hi');
  await Promise.resolve();
  await Promise.resolve();
}

describe('F1 — selectSession()/newSession() cancel an in-flight turn', () => {
  test('selectSession() during an in-flight turn aborts it, does not append the stale reply into the NEW session, and leaves sending=false', async () => {
    const { createChatController } = await loadControllerModule();
    let abortedByCaller = false;
    const sendDeferred = deferred<unknown>();
    const { transport, emit } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-old' }),
      sendMessage: async (_id, _text, options) => {
        options?.signal?.addEventListener('abort', () => {
          abortedByCaller = true;
        });
        return sendDeferred.promise;
      },
      getSessionMessages: async (): Promise<FlattenedEntry[]> => [],
    });
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);
    emit(textDeltaEvent('sess-old', 'partial old reply'));
    expect(controller.getState().pendingText).toBe('partial old reply');

    // Switch sessions mid-stream (the New-chat / session-click path).
    await controller.selectSession('sess-new');
    expect(abortedByCaller, 'the old turn`s AbortController must be aborted on session switch').toBe(true);

    let state = controller.getState();
    expect(state.sessionId).toBe('sess-new');
    expect(state.sending).toBe(false);
    expect(state.pendingText).toBe('');
    expect(state.entries).toEqual([]);

    // The old turn's SSE deltas (still in flight on sess-old) must not land
    // in the new session's transcript, nor revive `sending`.
    emit(textDeltaEvent('sess-old', ' MORE STALE TEXT'));
    emit({ type: 'session.idle', properties: { sessionID: 'sess-old' } });
    state = controller.getState();
    expect(state.sending).toBe(false);
    expect(state.entries).toEqual([]);

    // The stale POST finally resolving must not mutate the new session either.
    sendDeferred.resolve({ parts: [{ type: 'text', text: 'STALE FINAL REPLY' }] });
    await Promise.resolve();
    await Promise.resolve();
    state = controller.getState();
    expect(state.entries).toEqual([]);
    expect(state.sessionId).toBe('sess-new');
  });

  test('newSession() during an in-flight turn aborts it and leaves a clean slate', async () => {
    const { createChatController } = await loadControllerModule();
    let aborted = false;
    const sendDeferred = deferred<unknown>();
    const { transport, emit } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-a' }),
      sendMessage: async (_id, _text, options) => {
        options?.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        return sendDeferred.promise;
      },
    });
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);
    emit(textDeltaEvent('sess-a', 'streaming...'));

    controller.newSession();
    expect(aborted).toBe(true);
    let state = controller.getState();
    expect(state.sessionId).toBeNull();
    expect(state.sending).toBe(false);
    expect(state.pendingText).toBe('');
    expect(state.entries).toEqual([]);

    emit({ type: 'session.idle', properties: { sessionID: 'sess-a' } });
    sendDeferred.resolve({ parts: [{ type: 'text', text: 'late reply' }] });
    await Promise.resolve();
    await Promise.resolve();
    state = controller.getState();
    expect(state.entries).toEqual([]);
    expect(state.sessionId).toBeNull();
  });
});

describe('F3 — send() applies a hard ceiling even when the caller AbortSignal is present', () => {
  test('a sendMessage that never settles and never gets its signal aborted is still cut off by the ceiling, clearing sending with an error', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-ceil' }),
      // Mimics real fetch: rejects only when ITS OWN passed-in signal aborts.
      sendMessage: (_id, _text, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }));
          });
        }),
    });
    const controller = createChatController(transport, undefined, { sendCeilingMs: 15 });
    await controller.init();
    await controller.send('will hang forever');

    const state = controller.getState();
    expect(state.sending).toBe(false);
    expect(state.error).toBeTruthy();
  });
});

describe('F5 — stop() finalizes locally even if abortTurn (the remote POST) hangs', () => {
  test('an abortTurn that never resolves still clears sending and adds the "Stopped." note', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport, emit } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-hang' }),
      sendMessage: async (_id, _text, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
      abortTurn: () => new Promise(() => {}), // never resolves
    });
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);
    emit(textDeltaEvent('sess-hang', ''));

    // stop() itself must resolve promptly despite abortTurn hanging forever.
    await controller.stop();

    const state = controller.getState();
    expect(state.sending).toBe(false);
    expect(state.entries.at(-1)).toMatchObject({ kind: 'note', text: 'Stopped.' });
  });
});

describe('F8 — finalizeTurn prefers streamed pendingText over an empty override', () => {
  test('an empty-string POST override with non-empty pendingText keeps the streamed reply, not the no-text placeholder', async () => {
    const { createChatController } = await loadControllerModule();
    const sendDeferred = deferred<unknown>();
    const { transport, emit } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-empty' }),
      sendMessage: async () => sendDeferred.promise,
    });
    const controller = createChatController(transport);
    await controller.init();
    const sendPromise = controller.send('hi');
    await Promise.resolve();
    await Promise.resolve();

    // Text streams in via SSE WHILE the turn is still in flight...
    emit(textDeltaEvent('sess-empty', 'Streamed reply text'));
    expect(controller.getState().pendingText).toBe('Streamed reply text');

    // ...then the POST resolves with an empty-string body (not undefined) —
    // BEFORE any session.idle SSE event — the exact case the `??` operator
    // in finalizeTurn misses (empty string is not nullish, so it used to win
    // over the already-accumulated pendingText).
    sendDeferred.resolve({ parts: [] });
    await sendPromise;

    const state = controller.getState();
    expect(state.entries.at(-1)).toMatchObject({ role: 'assistant', text: 'Streamed reply text' });
  });
});

describe('F9 — destroy() aborts an in-flight turn', () => {
  test('destroy() mid-turn aborts the in-flight sendMessage', async () => {
    const { createChatController } = await loadControllerModule();
    let aborted = false;
    const { transport } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-destroy' }),
      sendMessage: (_id, _text, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            aborted = true;
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);

    controller.destroy();
    expect(aborted, 'destroy() must abort the in-flight POST, not just unsubscribe events').toBe(true);
  });
});

describe('F10 — reasoning-part deltas are excluded from pendingText', () => {
  test('a message.part.delta carrying a reasoning partID is not appended to pendingText', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport, emit } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-reason' }),
      sendMessage: async () => new Promise(() => {}), // never resolves — the turn stays open
    });
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);

    // The part is first announced via message.part.updated as type
    // 'reasoning' (this is how the controller is expected to learn the
    // partID belongs to reasoning, mirroring 455d8728's partSnapshotType).
    emit({
      type: 'message.part.updated',
      properties: { sessionID: 'sess-reason', part: { id: 'part-think-1', type: 'reasoning' } },
    });
    // Then its delta arrives, tagged with that partID.
    emit({
      type: 'message.part.delta',
      properties: { sessionID: 'sess-reason', field: 'text', partID: 'part-think-1', delta: 'thinking...' },
    });
    expect(controller.getState().pendingText).toBe('');

    // A genuine text-part delta (different partID) still comes through.
    emit({
      type: 'message.part.delta',
      properties: { sessionID: 'sess-reason', field: 'text', partID: 'part-reply-1', delta: 'real reply' },
    });
    expect(controller.getState().pendingText).toBe('real reply');
  });
});

describe('F12 — callID-less tool updates upsert into ONE row, not a new row each time', () => {
  test('two lifecycle updates for the same callID-less tool land in a single pendingToolStates entry', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport, emit } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-tool' }),
      sendMessage: async () => new Promise(() => {}), // never resolves — the turn stays open
    });
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);

    // Both updates carry no callID (an OpenCode session.next.tool.* event
    // with none, or a message.part.updated tool part with no callID/id) —
    // must still be treated as ONE tool's lifecycle, not two rows.
    emit({
      type: 'session.next.tool.called',
      properties: { sessionID: 'sess-tool', tool: 'bash' },
    });
    expect(controller.getState().pendingToolStates.length).toBe(1);

    emit({
      type: 'session.next.tool.completed',
      properties: { sessionID: 'sess-tool', tool: 'bash' },
    });
    const state = controller.getState();
    expect(state.pendingToolStates.length).toBe(1);
    expect(state.pendingToolStates[0]).toMatchObject({ tool: 'bash', status: 'completed' });
  });
});
