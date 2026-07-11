/**
 * B4 [HIGH] / B9 [MEDIUM] (review 2026-07-10, transport half) — pure
 * extraction of tool-permission asks, structured questions, and live tool
 * updates from raw OpenCode SSE events, ported from
 * packages/ui/src/lib/chat/oc-events.ts (extractPermissionAsk/
 * extractQuestionAsk/extractToolUpdate). The UI stage (chat-controller.ts)
 * layers these on top of transport.subscribeEvents() the same way it already
 * does extractTextDelta/isTurnEnd (§B2), so a permission-gated tool call or a
 * structured question no longer wedges the turn for 150s with no reply path,
 * and long tool-running turns are no longer an opaque wait.
 *
 * RED until src/lib/transport/index.ts exports extractPermissionAsk,
 * extractQuestionAsk, and extractToolUpdate.
 */
import { describe, expect, test } from 'bun:test';
import type { RawEvent } from '../src/lib/transport/index.ts';

async function loadTransportModule() {
  return import('../src/lib/transport/index.ts');
}

describe('extractPermissionAsk (§B4)', () => {
  test('extracts a permission.asked event for the matching session', async () => {
    const { extractPermissionAsk } = await loadTransportModule();
    const event: RawEvent = {
      type: 'permission.asked',
      properties: {
        sessionID: 'sess-1',
        id: 'perm-1',
        permission: 'bash',
        patterns: ['rm -rf *'],
        always: ['ls *'],
        tool: { callID: 'call-1' },
        metadata: 'remove build artifacts',
      },
    };
    expect(extractPermissionAsk(event, 'sess-1')).toEqual({
      requestID: 'perm-1',
      permission: 'bash',
      patterns: ['rm -rf *'],
      always: ['ls *'],
      tool: 'call-1',
      detail: 'remove build artifacts',
    });
  });

  test('returns null for a different session, a different event type, or a missing id', async () => {
    const { extractPermissionAsk } = await loadTransportModule();
    expect(
      extractPermissionAsk(
        { type: 'permission.asked', properties: { sessionID: 'other', id: 'p1' } },
        'sess-1'
      )
    ).toBeNull();
    expect(
      extractPermissionAsk({ type: 'session.idle', properties: { sessionID: 'sess-1' } }, 'sess-1')
    ).toBeNull();
    expect(
      extractPermissionAsk({ type: 'permission.asked', properties: { sessionID: 'sess-1' } }, 'sess-1')
    ).toBeNull();
  });
});

describe('extractQuestionAsk (§B4)', () => {
  test('extracts a question.asked event with options', async () => {
    const { extractQuestionAsk } = await loadTransportModule();
    const event: RawEvent = {
      type: 'question.asked',
      properties: {
        sessionID: 'sess-1',
        id: 'q-1',
        questions: [
          {
            question: 'Which environment?',
            header: 'deploy target',
            options: [{ label: 'staging', description: '' }, { label: 'prod', description: 'live traffic' }],
          },
        ],
      },
    };
    expect(extractQuestionAsk(event, 'sess-1')).toEqual({
      requestID: 'q-1',
      questions: [
        {
          question: 'Which environment?',
          header: 'deploy target',
          options: [
            { label: 'staging', description: '' },
            { label: 'prod', description: 'live traffic' },
          ],
        },
      ],
    });
  });

  test('returns null when there are no questions, wrong session, or wrong type', async () => {
    const { extractQuestionAsk } = await loadTransportModule();
    expect(
      extractQuestionAsk(
        { type: 'question.asked', properties: { sessionID: 'sess-1', id: 'q1', questions: [] } },
        'sess-1'
      )
    ).toBeNull();
    expect(
      extractQuestionAsk(
        { type: 'question.asked', properties: { sessionID: 'other', id: 'q1', questions: [{}] } },
        'sess-1'
      )
    ).toBeNull();
  });
});

describe('extractToolUpdate (§B9)', () => {
  test('extracts a message.part.updated tool snapshot', async () => {
    const { extractToolUpdate } = await loadTransportModule();
    const event: RawEvent = {
      type: 'message.part.updated',
      properties: {
        sessionID: 'sess-1',
        part: {
          type: 'tool',
          callID: 'call-9',
          tool: 'bash',
          state: { status: 'running', title: 'Running command', input: 'ls -la' },
        },
      },
    };
    expect(extractToolUpdate(event, 'sess-1')).toEqual({
      callID: 'call-9',
      tool: 'bash',
      status: 'running',
      title: 'Running command',
      detail: 'ls -la',
      output: undefined,
      error: undefined,
    });
  });

  test('extracts a session.next.tool.* lifecycle event', async () => {
    const { extractToolUpdate } = await loadTransportModule();
    const event: RawEvent = {
      type: 'session.next.tool.completed',
      properties: { sessionID: 'sess-1', callID: 'call-9', tool: 'bash', output: 'done' },
    };
    expect(extractToolUpdate(event, 'sess-1')).toMatchObject({
      callID: 'call-9',
      tool: 'bash',
      status: 'completed',
      output: 'done',
    });
  });

  test('returns null for an unrelated event or session', async () => {
    const { extractToolUpdate } = await loadTransportModule();
    expect(
      extractToolUpdate({ type: 'session.idle', properties: { sessionID: 'sess-1' } }, 'sess-1')
    ).toBeNull();
    expect(
      extractToolUpdate(
        {
          type: 'message.part.updated',
          properties: { sessionID: 'other', part: { type: 'tool', callID: 'x' } },
        },
        'sess-1'
      )
    ).toBeNull();
  });
});
