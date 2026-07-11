/**
 * B12 [MEDIUM] (review 2026-07-10, controller half) — the chat-controller
 * calls a `ChatNotifier` (default: $lib/desktop-notifications.js's
 * notifyAssistantReply/notifyAssistantError) on turn completion/error, the
 * same two call sites as `git show 455d8728:packages/ui/src/lib/chat/
 * chat-state.svelte.ts` (`finalizeTurn()`'s notifyAssistantReply and
 * `send()`'s catch-block notifyAssistantError). The notifier is
 * dependency-injected (mirrors how `transport` already is) so this test
 * doesn't need module mocking.
 *
 * RED until createChatController() accepts and calls an injectable notifier.
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

function makeFakeTransport(overrides: Partial<Transport> = {}) {
  let handlers: StreamHandlers | null = null;
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
      return () => {};
    },
    probeHealth: async () => ({ state: 'accessible' }),
    ...overrides,
  };
  return { transport, emit: (event: RawEvent) => handlers?.onEvent(event) };
}

function makeFakeNotifier() {
  const replies: string[] = [];
  let errors = 0;
  return {
    notifier: {
      notifyReply: (text: string) => replies.push(text),
      notifyError: () => {
        errors += 1;
      },
    },
    replies,
    get errors() {
      return errors;
    },
  };
}

describe('chat-controller — B12 notifies on reply completion', () => {
  test('a successful non-streaming send() notifies with the reply text', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-n1' }),
      sendMessage: async () => ({ parts: [{ type: 'text', text: 'Hello there!' }] }),
    });
    const { notifier, replies } = makeFakeNotifier();
    const controller = createChatController(transport, notifier);
    await controller.init();
    await controller.send('hi');

    expect(replies).toEqual(['Hello there!']);
  });

  test('a streamed turn finalized via isTurnEnd notifies with the accumulated text', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport, emit } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-n2' }),
      sendMessage: async () => new Promise(() => {}),
    });
    const { notifier, replies } = makeFakeNotifier();
    const controller = createChatController(transport, notifier);
    await controller.init();
    void controller.send('stream please');
    await Promise.resolve();
    await Promise.resolve();

    emit({ type: 'session.next.text.delta', properties: { sessionID: 'sess-n2', delta: 'Hi!' } });
    emit({ type: 'session.idle', properties: { sessionID: 'sess-n2' } });

    expect(replies).toEqual(['Hi!']);
  });

  test('stop() with accumulated text notifies same as a normal completion', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport, emit } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-n3' }),
      sendMessage: async (_id, _text, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });
    const { notifier, replies } = makeFakeNotifier();
    const controller = createChatController(transport, notifier);
    await controller.init();
    void controller.send('long running');
    await Promise.resolve();
    await Promise.resolve();
    emit({ type: 'session.next.text.delta', properties: { sessionID: 'sess-n3', delta: 'partial' } });
    await controller.stop();

    expect(replies).toEqual(['partial']);
  });

  test('stop() with no accumulated text does NOT notify (nothing to announce)', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-n4' }),
      sendMessage: async (_id, _text, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });
    const { notifier, replies } = makeFakeNotifier();
    const controller = createChatController(transport, notifier);
    await controller.init();
    void controller.send('hi');
    await Promise.resolve();
    await Promise.resolve();
    await controller.stop();

    expect(replies).toEqual([]);
  });
});

describe('chat-controller — B12 notifies on send failure', () => {
  test('a failed send() calls notifyError exactly once', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-n6' }),
      sendMessage: async () => {
        throw new Error('network down');
      },
    });
    const fake = makeFakeNotifier();
    const controller = createChatController(transport, fake.notifier);
    await controller.init();
    await controller.send('will fail');

    expect(fake.errors).toBe(1);
  });
});
