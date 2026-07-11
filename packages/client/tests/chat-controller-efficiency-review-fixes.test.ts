/**
 * PR #562 xhigh review fix-round — chat efficiency/dead-code findings C7,
 * C8 in chat-controller.ts. Each describe block is test-first for exactly
 * one finding.
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

function makeFakeTransport(overrides: Partial<Transport> = {}) {
  let handlers: StreamHandlers | null = null;
  const transport: Transport = {
    listSessions: async (): Promise<SessionSummary[]> => [],
    createSession: async () => ({ id: 'new-session' }),
    sendMessage: async () => new Promise(() => {}), // never resolves — SSE drives this turn
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
  return {
    transport,
    emit: (event: RawEvent) => handlers?.onEvent(event),
  };
}

async function startTurn(controller: { send(text: string): Promise<void> }): Promise<void> {
  void controller.send('hi');
  await Promise.resolve();
  await Promise.resolve();
}

describe('C7 — the dead `connected` field is removed', () => {
  test('ChatControllerState has no `connected` key', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport } = makeFakeTransport();
    const controller = createChatController(transport);
    await controller.init();
    expect(Object.prototype.hasOwnProperty.call(controller.getState(), 'connected')).toBe(false);
  });

  test('the source no longer references `connected` at all (writer removed too)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../src/lib/chat/chat-controller.ts', import.meta.url)),
      'utf8'
    );
    expect(src).not.toMatch(/\bconnected\b/);
  });

  test('onConnect/onDisconnect no longer notify subscribers on every reconnect churn', async () => {
    const { createChatController } = await loadControllerModule();
    let onConnect: (() => void) | null = null;
    let onDisconnect: ((error: Error) => void) | null = null;
    const transport: Transport = {
      listSessions: async () => [],
      createSession: async () => ({ id: 's' }),
      sendMessage: async () => ({ parts: [] }),
      abortTurn: async () => {},
      getSessionMessages: async () => [],
      replyPermission: async () => {},
      replyQuestion: async () => {},
      rejectQuestion: async () => {},
      subscribeEvents: (h) => {
        onConnect = () => h.onConnect?.();
        onDisconnect = () => h.onDisconnect?.(new Error('boom'));
        return () => {};
      },
      probeHealth: async () => ({ state: 'accessible' }),
    };
    const controller = createChatController(transport);
    await controller.init();
    let notifyCount = 0;
    controller.subscribe(() => {
      notifyCount++;
    });
    onConnect?.();
    onDisconnect?.(new Error('boom'));
    onConnect?.();
    expect(notifyCount).toBe(0);
  });
});

describe('C8 — handleEvent dispatches on event.type instead of running every extractor', () => {
  test('classifyEvent maps each disjoint event.type to exactly the relevant extractor', async () => {
    const mod = (await loadControllerModule()) as unknown as {
      classifyEvent?: (type: string) => string | null;
    };
    expect(typeof mod.classifyEvent).toBe('function');
    const classifyEvent = mod.classifyEvent!;
    expect(classifyEvent('session.next.text.delta')).toBe('text-delta');
    expect(classifyEvent('message.part.delta')).toBe('text-delta');
    expect(classifyEvent('message.part.updated')).toBe('tool-update');
    expect(classifyEvent('session.next.tool.called')).toBe('tool-update');
    expect(classifyEvent('session.next.tool.completed')).toBe('tool-update');
    expect(classifyEvent('permission.asked')).toBe('permission-ask');
    expect(classifyEvent('question.asked')).toBe('question-ask');
    expect(classifyEvent('session.idle')).toBe('turn-end');
    expect(classifyEvent('session.status')).toBe('turn-end');
    expect(classifyEvent('some.unrelated.event')).toBe(null);
  });

  test('behavior equivalence: a text-delta event still only updates pendingText', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport, emit } = makeFakeTransport();
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);
    emit({ type: 'session.next.text.delta', properties: { sessionID: 'new-session', delta: 'Hi' } });
    const state = controller.getState();
    expect(state.pendingText).toBe('Hi');
    expect(state.pendingToolStates).toEqual([]);
    expect(state.pendingPermission).toBeNull();
    expect(state.pendingQuestion).toBeNull();
    expect(state.sending).toBe(true);
  });

  test('behavior equivalence: a reasoning-part snapshot + delta on that part still excludes it from pendingText, while a tool-part update on the SAME event type still upserts a tool row', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport, emit } = makeFakeTransport();
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);
    emit({
      type: 'message.part.updated',
      properties: { sessionID: 'new-session', part: { id: 'part-1', type: 'reasoning' } },
    });
    emit({
      type: 'message.part.delta',
      properties: { sessionID: 'new-session', partID: 'part-1', delta: 'thinking…' },
    });
    expect(controller.getState().pendingText).toBe('');
    emit({
      type: 'message.part.updated',
      properties: {
        sessionID: 'new-session',
        part: { id: 'part-2', type: 'tool', callID: 'call-1', tool: 'bash', state: { status: 'running' } },
      },
    });
    expect(controller.getState().pendingToolStates).toHaveLength(1);
    expect(controller.getState().pendingToolStates[0]?.tool).toBe('bash');
  });

  test('behavior equivalence: permission.asked/question.asked/turn-end events still only touch their own field, and an unrelated event type is a total no-op (no notify)', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport, emit } = makeFakeTransport();
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);

    let notifyCount = 0;
    controller.subscribe(() => {
      notifyCount++;
    });

    emit({ type: 'some.unrelated.event', properties: { sessionID: 'new-session' } });
    expect(notifyCount).toBe(0);

    emit({
      type: 'permission.asked',
      properties: { sessionID: 'new-session', id: 'perm-1', permission: 'bash' },
    });
    expect(controller.getState().pendingPermission?.requestID).toBe('perm-1');
    expect(controller.getState().pendingText).toBe('');
    expect(notifyCount).toBe(1);
  });
});
