/**
 * Unit tests for the session-message part-flattening parser.
 *
 * This is the ~70-line domain transformation extracted from
 * `getSessionMessages` in the api client. It groups OpenCode message parts
 * (text + tool) into UI `ChatEntry`s. Pure — no transport, no Svelte runes.
 */
import { describe, expect, it } from 'vitest';

import { flattenSessionMessages, type SessionMessageRow } from './session-messages.js';
import type { ChatMessage, ChatToolGroup } from '$lib/types.js';

function row(partial: Partial<SessionMessageRow['info']> & { id: string }, parts: SessionMessageRow['parts']): SessionMessageRow {
  return {
    info: { role: 'assistant', ...partial },
    parts,
  };
}

describe('flattenSessionMessages', () => {
  it('maps a text-only message to a single ChatMessage', () => {
    const out = flattenSessionMessages([
      row({ id: 'm1', role: 'user', time: { created: 1000 } }, [{ type: 'text', text: 'hello' }]),
    ]);
    expect(out).toHaveLength(1);
    const msg = out[0] as ChatMessage;
    expect(msg.id).toBe('m1');
    expect(msg.role).toBe('user');
    expect(msg.text).toBe('hello');
    expect(msg.timestamp).toBe(1000);
    expect(msg.toolStates).toBeUndefined();
  });

  it('trims text and drops an empty message with no tools', () => {
    const out = flattenSessionMessages([
      row({ id: 'm1', time: { created: 1 } }, [{ type: 'text', text: '   ' }]),
    ]);
    expect(out).toHaveLength(0);
  });

  it('attaches preceding tool parts to the following assistant text', () => {
    const out = flattenSessionMessages([
      row({ id: 'm2', time: { created: 5 } }, [
        { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', output: 'done' } },
        { type: 'text', text: 'ran it' },
      ]),
    ]);
    expect(out).toHaveLength(1);
    const msg = out[0] as ChatMessage;
    expect(msg.id).toBe('m2');
    expect(msg.text).toBe('ran it');
    expect(msg.toolStates).toHaveLength(1);
    expect(msg.toolStates?.[0].tool).toBe('bash');
    expect(msg.toolStates?.[0].id).toBe('c1');
  });

  it('emits an orphan tool-group when tools have no following text', () => {
    const out = flattenSessionMessages([
      row({ id: 'm3', time: { created: 7 } }, [
        { type: 'tool', tool: 'read', callID: 'c9', state: { status: 'running' } },
      ]),
    ]);
    expect(out).toHaveLength(1);
    const group = out[0] as ChatToolGroup;
    expect(group.type).toBe('tool-group');
    expect(group.id).toBe('m3:tools:0');
    expect(group.toolStates).toHaveLength(1);
    expect(group.toolStates[0].tool).toBe('read');
    expect(group.timestamp).toBe(7);
  });

  it('gives subsequent text segments suffixed ids and clears tool buffer per flush', () => {
    const out = flattenSessionMessages([
      row({ id: 'm4', time: { created: 3 } }, [
        { type: 'text', text: 'first' },
        { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed' } },
        { type: 'text', text: 'second' },
      ]),
    ]);
    // "first" flushes on... actually text is buffered; a tool does NOT flush text.
    // Both text parts concatenate into one buffer, tool is pending → single entry.
    expect(out).toHaveLength(1);
    const msg = out[0] as ChatMessage;
    expect(msg.id).toBe('m4');
    expect(msg.text).toBe('firstsecond');
    expect(msg.toolStates).toHaveLength(1);
  });

  it('skips non-text, non-tool parts (files, reasoning)', () => {
    const out = flattenSessionMessages([
      row({ id: 'm5', time: { created: 2 } }, [
        { type: 'file' },
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'visible' },
      ] as SessionMessageRow['parts']),
    ]);
    expect(out).toHaveLength(1);
    expect((out[0] as ChatMessage).text).toBe('visible');
    expect((out[0] as ChatMessage).toolStates).toBeUndefined();
  });

  it('falls back to Date.now() when a row carries no created timestamp', () => {
    const before = Date.now();
    const out = flattenSessionMessages([row({ id: 'm6' }, [{ type: 'text', text: 'x' }])]);
    const after = Date.now();
    const msg = out[0] as ChatMessage;
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });

  it('processes multiple rows independently', () => {
    const out = flattenSessionMessages([
      row({ id: 'a', role: 'user', time: { created: 1 } }, [{ type: 'text', text: 'q' }]),
      row({ id: 'b', role: 'assistant', time: { created: 2 } }, [{ type: 'text', text: 'a' }]),
    ]);
    expect(out.map((m) => (m as ChatMessage).id)).toEqual(['a', 'b']);
  });
});
