/**
 * B4 [HIGH] / B9 [MEDIUM] (review 2026-07-10) — the chat-controller half of
 * "surface PermissionCard/QuestionCard in the client chat" and "port ToolLog
 * visibility". Before this, a permission-gated tool call or a structured
 * question wedged the turn for 150s with no reply path (extractPermissionAsk/
 * extractQuestionAsk were extracted onto the transport in the transport-asks
 * lane, but nothing in the controller consumed them), and long tool-running
 * turns were an opaque, uninterruptible wait with no visibility into what the
 * assistant was doing (extractToolUpdate went unconsumed too).
 *
 * RED until chat-controller.ts:
 *   - tracks `pendingPermission`/`pendingQuestion`/`pendingToolStates` on
 *     ChatControllerState, populated from the corresponding oc-events-style
 *     extractors during an in-flight turn,
 *   - exposes `answerPermission()`, `setQuestionAnswer()`, `answerQuestion()`,
 *     and `rejectQuestion()` that POST via the transport and update status,
 *   - clears all three pending-render fields when a turn finalizes (success,
 *     stop, or error) so a stale ask never survives into the next turn.
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
    sendMessage: async () => new Promise(() => {}), // never resolves — finalization comes from the stream
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

function permissionAskedEvent(sessionId: string, requestID: string): RawEvent {
  return {
    type: 'permission.asked',
    properties: { sessionID: sessionId, id: requestID, permission: 'bash', tool: { callID: 'call-1' } },
  };
}

function questionAskedEvent(sessionId: string, requestID: string): RawEvent {
  return {
    type: 'question.asked',
    properties: {
      sessionID: sessionId,
      id: requestID,
      questions: [{ question: 'Which env?', header: '', options: [{ label: 'staging' }, { label: 'prod' }] }],
    },
  };
}

function toolUpdatedEvent(sessionId: string, callID: string, status: string): RawEvent {
  return {
    type: 'message.part.updated',
    properties: { sessionID: sessionId, part: { type: 'tool', callID, tool: 'bash', state: { status } } },
  };
}

async function startTurn(controller: { send(text: string): Promise<void> }): Promise<void> {
  void controller.send('hi');
  await Promise.resolve();
  await Promise.resolve();
}

describe('chat-controller — B4 permission asks', () => {
  test('a permission.asked event during a turn populates pendingPermission', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport, emit } = makeFakeTransport({ createSession: async () => ({ id: 'sess-p1' }) });
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);

    emit(permissionAskedEvent('sess-p1', 'perm-1'));
    const state = controller.getState();
    expect(state.pendingPermission).toMatchObject({ requestID: 'perm-1', permission: 'bash', status: 'pending' });
  });

  test('answerPermission() replies via the transport and marks the ask resolved', async () => {
    const { createChatController } = await loadControllerModule();
    let repliedWith: string | null = null;
    const { transport, emit } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-p2' }),
      replyPermission: async (_id, reply) => {
        repliedWith = reply;
      },
    });
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);
    emit(permissionAskedEvent('sess-p2', 'perm-2'));

    await controller.answerPermission('once');
    expect(repliedWith).toBe('once');
    expect(controller.getState().pendingPermission).toMatchObject({ status: 'resolved', decision: 'once' });
  });

  test('a permission error from the transport marks the ask errored, not resolved', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport, emit } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-p3' }),
      replyPermission: async () => {
        throw new Error('gone');
      },
    });
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);
    emit(permissionAskedEvent('sess-p3', 'perm-3'));

    await controller.answerPermission('reject');
    expect(controller.getState().pendingPermission).toMatchObject({ status: 'error' });
  });
});

describe('chat-controller — B4 structured questions', () => {
  test('a question.asked event during a turn populates pendingQuestion with blank answers', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport, emit } = makeFakeTransport({ createSession: async () => ({ id: 'sess-q1' }) });
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);

    emit(questionAskedEvent('sess-q1', 'q-1'));
    const state = controller.getState();
    expect(state.pendingQuestion).toMatchObject({ requestID: 'q-1', status: 'pending', answers: [''] });
  });

  test('setQuestionAnswer() records a draft answer at the given index', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport, emit } = makeFakeTransport({ createSession: async () => ({ id: 'sess-q2' }) });
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);
    emit(questionAskedEvent('sess-q2', 'q-2'));

    controller.setQuestionAnswer(0, 'staging');
    expect(controller.getState().pendingQuestion?.answers).toEqual(['staging']);
  });

  test('answerQuestion() replies via the transport and marks the ask answered', async () => {
    const { createChatController } = await loadControllerModule();
    let repliedAnswers: string[][] | null = null;
    const { transport, emit } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-q3' }),
      replyQuestion: async (_id, answers) => {
        repliedAnswers = answers;
      },
    });
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);
    emit(questionAskedEvent('sess-q3', 'q-3'));
    controller.setQuestionAnswer(0, 'prod');

    await controller.answerQuestion();
    expect(repliedAnswers).toEqual([['prod']]);
    expect(controller.getState().pendingQuestion).toMatchObject({ status: 'answered' });
  });

  test('rejectQuestion() rejects via the transport and marks the ask rejected', async () => {
    const { createChatController } = await loadControllerModule();
    let rejectedId: string | null = null;
    const { transport, emit } = makeFakeTransport({
      createSession: async () => ({ id: 'sess-q4' }),
      rejectQuestion: async (id) => {
        rejectedId = id;
      },
    });
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);
    emit(questionAskedEvent('sess-q4', 'q-4'));

    await controller.rejectQuestion();
    expect(rejectedId).toBe('q-4');
    expect(controller.getState().pendingQuestion).toMatchObject({ status: 'rejected' });
  });
});

describe('chat-controller — B9 live tool states', () => {
  test('a tool update during a turn appears in pendingToolStates, upserted by id', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport, emit } = makeFakeTransport({ createSession: async () => ({ id: 'sess-t1' }) });
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);

    emit(toolUpdatedEvent('sess-t1', 'call-1', 'running'));
    expect(controller.getState().pendingToolStates).toMatchObject([{ id: 'call-1', status: 'running' }]);

    emit(toolUpdatedEvent('sess-t1', 'call-1', 'completed'));
    const state = controller.getState();
    expect(state.pendingToolStates.length).toBe(1);
    expect(state.pendingToolStates[0]).toMatchObject({ id: 'call-1', status: 'completed' });
  });

  test('finalizing a turn attaches captured tool states to the assistant entry and clears pendingToolStates', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport, emit } = makeFakeTransport({ createSession: async () => ({ id: 'sess-t2' }) });
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);

    emit(toolUpdatedEvent('sess-t2', 'call-2', 'completed'));
    emit({ type: 'session.next.text.delta', properties: { sessionID: 'sess-t2', delta: 'done' } });
    emit({ type: 'session.idle', properties: { sessionID: 'sess-t2' } });

    const state = controller.getState();
    expect(state.pendingToolStates).toEqual([]);
    const assistantEntry = state.entries.at(-1) as { toolStates?: unknown };
    expect(assistantEntry.toolStates).toMatchObject([{ id: 'call-2', status: 'completed' }]);
  });

  test('stop() clears any pending permission/question/tool state', async () => {
    const { createChatController } = await loadControllerModule();
    const { transport, emit } = makeFakeTransport({ createSession: async () => ({ id: 'sess-t3' }) });
    const controller = createChatController(transport);
    await controller.init();
    await startTurn(controller);
    emit(permissionAskedEvent('sess-t3', 'perm-x'));
    emit(toolUpdatedEvent('sess-t3', 'call-x', 'running'));

    await controller.stop();
    const state = controller.getState();
    expect(state.pendingPermission).toBeNull();
    expect(state.pendingToolStates).toEqual([]);
  });
});
