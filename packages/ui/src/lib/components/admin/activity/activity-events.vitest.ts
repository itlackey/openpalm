/**
 * Unit tests for the pure activity-event mappers extracted from ActivityTab.
 * Covers severity/classification (permission/question/error) and the
 * `session.next.tool.*` parsing, plus session-id / title / detail derivation.
 */
import { describe, expect, test } from 'vitest';
import type { OpenCodeSessionEventPayload } from '$lib/chat/session-events.js';
import {
  eventSessionId,
  summarizeEvent,
  eventTitle,
  eventDetail,
  toToolStripEntry,
} from './activity-events.js';

function ev(
  type: string,
  properties?: Record<string, unknown>,
): OpenCodeSessionEventPayload {
  return { type, properties } as OpenCodeSessionEventPayload;
}

describe('eventSessionId', () => {
  test('prefers top-level sessionID', () => {
    expect(eventSessionId(ev('x', { sessionID: 'sess-1' }))).toBe('sess-1');
  });

  test('falls back to info.id', () => {
    expect(eventSessionId(ev('x', { info: { id: 'sess-2' } }))).toBe('sess-2');
  });

  test('returns empty string when neither present', () => {
    expect(eventSessionId(ev('x', {}))).toBe('');
    expect(eventSessionId(ev('x'))).toBe('');
  });
});

describe('summarizeEvent classification', () => {
  test('permission.asked → high permission', () => {
    const summary = summarizeEvent(
      ev('permission.asked', { sessionID: 's', permission: 'bash: rm -rf' }),
    );
    expect(summary).toEqual({
      kind: 'permission',
      severity: 'high',
      title: 'Approval needed',
      detail: 'bash: rm -rf',
      sessionId: 's',
    });
  });

  test('permission.asked without string permission uses fallback detail', () => {
    const summary = summarizeEvent(ev('permission.asked', { sessionID: 's' }));
    expect(summary?.kind).toBe('permission');
    expect(summary?.detail).toBe('Assistant is waiting for a permission decision.');
  });

  test('question.asked → high question with pluralised count', () => {
    const one = summarizeEvent(ev('question.asked', { questions: [{}] }));
    expect(one).toMatchObject({
      kind: 'question',
      severity: 'high',
      detail: '1 question waiting for an answer.',
    });
    const many = summarizeEvent(ev('question.asked', { questions: [{}, {}, {}] }));
    expect(many?.detail).toBe('3 questions waiting for an answer.');
  });

  test('session.error → high error', () => {
    const summary = summarizeEvent(ev('session.error', { error: 'boom' }));
    expect(summary).toMatchObject({ kind: 'error', severity: 'high', detail: 'boom' });
  });

  test('session.deleted → medium info', () => {
    expect(summarizeEvent(ev('session.deleted', {}))).toMatchObject({
      kind: 'info',
      severity: 'medium',
    });
  });

  test('session.created → low info', () => {
    expect(summarizeEvent(ev('session.created', {}))).toMatchObject({
      kind: 'info',
      severity: 'low',
    });
  });

  test('unrecognised event → null', () => {
    expect(summarizeEvent(ev('session.updated', {}))).toBeNull();
    expect(summarizeEvent(ev('message.part.updated', { part: { type: 'text' } }))).toBeNull();
  });
});

describe('summarizeEvent session.next.tool.* parsing', () => {
  test('.failed → high error with tool name and progress', () => {
    const summary = summarizeEvent(
      ev('session.next.tool.failed', { tool: 'bash', progress: 'exit 1' }),
    );
    expect(summary).toMatchObject({
      kind: 'error',
      severity: 'high',
      title: 'Tool failed: bash',
      detail: 'exit 1',
    });
  });

  test('.called → medium info, uses message when progress absent', () => {
    const summary = summarizeEvent(
      ev('session.next.tool.called', { tool: 'read', message: 'reading file' }),
    );
    expect(summary).toMatchObject({
      kind: 'info',
      severity: 'medium',
      title: 'Tool running: read',
      detail: 'reading file',
    });
  });

  test('.completed → low info', () => {
    const summary = summarizeEvent(ev('session.next.tool.completed', { tool: 'grep' }));
    expect(summary).toMatchObject({
      kind: 'info',
      severity: 'low',
      title: 'Tool finished: grep',
    });
  });

  test('unknown tool sub-type → null', () => {
    expect(summarizeEvent(ev('session.next.tool.progress', { tool: 'x' }))).toBeNull();
  });
});

describe('summarizeEvent message.part.updated tool error', () => {
  test('tool part in error state → high error', () => {
    const summary = summarizeEvent(
      ev('message.part.updated', {
        part: { tool: 'write', state: { status: 'error', error: 'disk full' } },
      }),
    );
    expect(summary).toMatchObject({
      kind: 'error',
      severity: 'high',
      title: 'Tool failed: write',
      detail: 'disk full',
    });
  });

  test('tool part not in error state → null', () => {
    expect(
      summarizeEvent(
        ev('message.part.updated', { part: { tool: 'write', state: { status: 'running' } } }),
      ),
    ).toBeNull();
  });
});

describe('eventTitle', () => {
  test('prefers info.title', () => {
    expect(eventTitle(ev('session.updated', { info: { title: 'My session' } }))).toBe('My session');
  });

  test('falls back to summary title', () => {
    expect(eventTitle(ev('permission.asked', { sessionID: 's' }))).toBe('Approval needed');
  });

  test('falls back to session slice', () => {
    expect(eventTitle(ev('session.updated', { sessionID: 'abcdef012345' }))).toBe('Session abcdef01');
  });

  test('falls back to generic label when nothing available', () => {
    expect(eventTitle(ev('session.updated', {}))).toBe('Assistant event');
  });
});

describe('eventDetail', () => {
  test('uses summary detail when present', () => {
    expect(eventDetail(ev('session.error', { error: 'boom' }))).toBe('boom');
  });

  test('session.next.tool.* without summary formats tool: progress', () => {
    expect(
      eventDetail(ev('session.next.tool.progress', { tool: 'bash', progress: 'step 2' })),
    ).toBe('bash: step 2');
  });

  test('message.part.updated non-error formats tool + status', () => {
    expect(
      eventDetail(ev('message.part.updated', { part: { tool: 'read', state: { status: 'completed' } } })),
    ).toBe('read completed');
  });

  test('session.updated → metadata changed', () => {
    expect(eventDetail(ev('session.updated', {}))).toBe('Session metadata changed.');
  });

  test('no properties → empty string', () => {
    expect(eventDetail(ev('unknown.type'))).toBe('');
  });
});

describe('toToolStripEntry', () => {
  test('returns null without a session id', () => {
    expect(toToolStripEntry(ev('session.next.tool.called', { tool: 'bash' }))).toBeNull();
  });

  test('maps a tool update to a tool strip entry', () => {
    const entry = toToolStripEntry(
      ev('session.next.tool.called', { sessionID: 's', tool: 'bash', callID: 'c1' }),
    );
    expect(entry).toMatchObject({ id: 'c1', kind: 'tool', tool: 'bash', status: 'running' });
  });

  test('maps a step update to a step strip entry', () => {
    const entry = toToolStripEntry(
      ev('session.next.step.started', { sessionID: 's', stepID: 'step-1', title: 'Working' }),
    );
    expect(entry).toMatchObject({ id: 'step-1', kind: 'step', tool: 'step', status: 'running' });
  });
});
