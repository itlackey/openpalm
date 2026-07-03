/**
 * Characterization tests for the native OpenCode /event interpreters.
 *
 * These pin the exact behavior of the shared event-parsing surface BEFORE it was
 * extracted from the two portals, so the move is provably behavior-preserving.
 * Every rich-UX renderer (Discord + Slack) reads the same native frames through
 * these helpers, so their contract is load-bearing.
 */
import { describe, expect, it } from 'bun:test';
import {
  asRaw,
  extractPermissionAsk,
  extractQuestionAsk,
  extractTextDelta,
  extractToolUpdate,
  isSessionError,
  isTurnEnd,
  partSnapshotType,
  statusName,
  TURN_IDLE_STATUSES,
} from './oc-events.ts';

const SID = 'ses_123';

describe('asRaw', () => {
  it('normalizes a well-formed event', () => {
    expect(asRaw({ type: 'x', properties: { a: 1 } })).toEqual({ type: 'x', properties: { a: 1 } });
  });

  it('defaults missing type to empty string and missing props to {}', () => {
    expect(asRaw({})).toEqual({ type: '', properties: {} });
    expect(asRaw(null)).toEqual({ type: '', properties: {} });
    expect(asRaw({ type: 42 })).toEqual({ type: '', properties: {} });
  });
});

describe('extractTextDelta', () => {
  it('reads delta then text from session.next.text.delta', () => {
    expect(extractTextDelta({ type: 'session.next.text.delta', properties: { sessionID: SID, delta: 'hi' } }, SID)).toBe('hi');
    expect(extractTextDelta({ type: 'session.next.text.delta', properties: { sessionID: SID, text: 'yo' } }, SID)).toBe('yo');
  });

  it('reads message.part.delta text', () => {
    expect(extractTextDelta({ type: 'message.part.delta', properties: { sessionID: SID, delta: 'chunk' } }, SID)).toBe('chunk');
  });

  it('ignores a different sessionID', () => {
    expect(extractTextDelta({ type: 'session.next.text.delta', properties: { sessionID: 'other', delta: 'hi' } }, SID)).toBeNull();
  });

  it('ignores non-text fields on message.part.delta', () => {
    expect(extractTextDelta({ type: 'message.part.delta', properties: { sessionID: SID, field: 'reasoning', delta: 'x' } }, SID)).toBeNull();
  });

  it('suppresses deltas from known reasoning parts', () => {
    const reasoning = new Set(['p1']);
    expect(extractTextDelta({ type: 'message.part.delta', properties: { sessionID: SID, partID: 'p1', delta: 'secret' } }, SID, reasoning)).toBeNull();
    expect(extractTextDelta({ type: 'message.part.delta', properties: { sessionID: SID, partID: 'p2', delta: 'ok' } }, SID, reasoning)).toBe('ok');
  });

  it('returns null for unrelated event types', () => {
    expect(extractTextDelta({ type: 'session.idle', properties: { sessionID: SID } }, SID)).toBeNull();
  });
});

describe('partSnapshotType', () => {
  it('reads part id + type from message.part.updated', () => {
    expect(partSnapshotType({ type: 'message.part.updated', properties: { part: { id: 'p1', type: 'reasoning' } } })).toEqual({ partID: 'p1', type: 'reasoning' });
  });

  it('returns null when not a part snapshot', () => {
    expect(partSnapshotType({ type: 'session.idle', properties: {} })).toBeNull();
    expect(partSnapshotType({ type: 'message.part.updated', properties: { part: { id: 'p1' } } })).toBeNull();
  });
});

describe('statusName', () => {
  it('reads a string status', () => {
    expect(statusName('idle')).toBe('idle');
  });
  it('reads a { type } status', () => {
    expect(statusName({ type: 'busy' })).toBe('busy');
  });
  it('returns undefined for anything else', () => {
    expect(statusName(42)).toBeUndefined();
    expect(statusName(null)).toBeUndefined();
  });
});

describe('isTurnEnd', () => {
  it('true on session.idle for the session', () => {
    expect(isTurnEnd({ type: 'session.idle', properties: { sessionID: SID } }, SID)).toBe(true);
  });
  it('true on session.status reaching an idle status', () => {
    expect(isTurnEnd({ type: 'session.status', properties: { sessionID: SID, status: 'idle' } }, SID)).toBe(true);
    expect(isTurnEnd({ type: 'session.status', properties: { sessionID: SID, status: { type: 'idle' } } }, SID)).toBe(true);
  });
  it('false for a non-idle status or another session', () => {
    expect(isTurnEnd({ type: 'session.status', properties: { sessionID: SID, status: 'busy' } }, SID)).toBe(false);
    expect(isTurnEnd({ type: 'session.idle', properties: { sessionID: 'other' } }, SID)).toBe(false);
  });
  it('exposes idle statuses', () => {
    expect(TURN_IDLE_STATUSES.has('idle')).toBe(true);
  });
});

describe('extractToolUpdate', () => {
  it('reads a message.part.updated tool part', () => {
    const out = extractToolUpdate(
      { type: 'message.part.updated', properties: { sessionID: SID, part: { type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'running', title: 'run' } } } },
      SID,
    );
    expect(out).toEqual({ callID: 'c1', tool: 'bash', status: 'running', title: 'run', error: undefined });
  });

  it('reads the session.next.tool.* family', () => {
    expect(extractToolUpdate({ type: 'session.next.tool.called', properties: { sessionID: SID, callID: 'c2', tool: 'read' } }, SID)).toEqual({
      callID: 'c2',
      tool: 'read',
      status: 'running',
      title: undefined,
    });
  });

  it('ignores other sessions', () => {
    expect(extractToolUpdate({ type: 'message.part.updated', properties: { sessionID: 'other', part: { type: 'tool' } } }, SID)).toBeNull();
  });
});

describe('extractPermissionAsk', () => {
  it('reads a permission.asked event', () => {
    expect(extractPermissionAsk({ type: 'permission.asked', properties: { sessionID: SID, id: 'r1', permission: 'bash', patterns: ['ls', 42] } }, SID)).toEqual({
      requestID: 'r1',
      permission: 'bash',
      patterns: ['ls'],
    });
  });
  it('defaults permission to "tool" and patterns to []', () => {
    expect(extractPermissionAsk({ type: 'permission.asked', properties: { sessionID: SID, id: 'r2' } }, SID)).toEqual({ requestID: 'r2', permission: 'tool', patterns: [] });
  });
  it('null without id or for another session or wrong type', () => {
    expect(extractPermissionAsk({ type: 'permission.asked', properties: { sessionID: SID } }, SID)).toBeNull();
    expect(extractPermissionAsk({ type: 'permission.asked', properties: { sessionID: 'other', id: 'r' } }, SID)).toBeNull();
    expect(extractPermissionAsk({ type: 'session.idle', properties: { sessionID: SID, id: 'r' } }, SID)).toBeNull();
  });
});

describe('isSessionError', () => {
  it('true only on session.error for the session', () => {
    expect(isSessionError({ type: 'session.error', properties: { sessionID: SID } }, SID)).toBe(true);
    expect(isSessionError({ type: 'session.error', properties: { sessionID: 'other' } }, SID)).toBe(false);
    expect(isSessionError({ type: 'session.idle', properties: { sessionID: SID } }, SID)).toBe(false);
  });
});

describe('extractQuestionAsk', () => {
  it('reads questions with options', () => {
    const out = extractQuestionAsk(
      {
        type: 'question.asked',
        properties: {
          sessionID: SID,
          id: 'q1',
          questions: [
            {
              question: 'Pick one',
              header: 'Choice',
              options: [
                { label: 'A', description: 'first' },
                { label: 'B' },
                { description: 'no label' },
              ],
            },
          ],
        },
      },
      SID,
    );
    expect(out).toEqual({
      requestID: 'q1',
      questions: [
        {
          question: 'Pick one',
          header: 'Choice',
          options: [
            { label: 'A', description: 'first' },
            { label: 'B', description: '' },
          ],
        },
      ],
    });
  });

  it('null when there are no questions', () => {
    expect(extractQuestionAsk({ type: 'question.asked', properties: { sessionID: SID, id: 'q', questions: [] } }, SID)).toBeNull();
  });

  it('null for wrong type / session / missing id', () => {
    expect(extractQuestionAsk({ type: 'question.asked', properties: { sessionID: 'other', id: 'q', questions: [{ question: 'x' }] } }, SID)).toBeNull();
    expect(extractQuestionAsk({ type: 'session.idle', properties: { sessionID: SID, id: 'q' } }, SID)).toBeNull();
  });
});
