/**
 * B5 [HIGH] (review 2026-07-10 §B5, transport half) — session history: old
 * sessions must not open empty.
 *
 * `transport.getSessionMessages(sessionId)` GETs
 * `{base}/session/{id}/message` and flattens the raw OpenCode message rows
 * with a ported `flattenSessionMessages` (packages/ui
 * `src/lib/chat/session-messages.ts` + the tool-part mapping from
 * `src/lib/chat/tool-strip.ts` toolStripEntryFromSessionPart — the transport
 * module defines its own minimal `ToolStateSnapshot`/`SessionMessagePart`
 * shapes rather than importing packages/ui types, to keep this package
 * dependency-free per the house contract).
 *
 * New file — does not modify the shared tests/helpers/*.ts contract.
 */
import { describe, expect, test } from 'bun:test';
import { jsonResponse, recordingFetch } from './helpers/mocks.ts';

async function loadTransportModule() {
  return import('../src/lib/transport/index.ts');
}

const BASE = 'http://gw.example:8443';

describe('flattenSessionMessages (ported from packages/ui session-messages.ts, B5)', () => {
  test('flattens a plain text row into one message entry', async () => {
    const { flattenSessionMessages } = await loadTransportModule();
    const entries = flattenSessionMessages([
      {
        info: { id: 'msg_1', role: 'assistant', time: { created: 100 } },
        parts: [{ type: 'text', text: 'hello there' }],
      },
    ]);
    expect(entries).toEqual([
      { id: 'msg_1', role: 'assistant', text: 'hello there', timestamp: 100 },
    ]);
  });

  test('drops an empty-text message with no tool activity', async () => {
    const { flattenSessionMessages } = await loadTransportModule();
    const entries = flattenSessionMessages([
      { info: { id: 'msg_1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: '   ' }] },
    ]);
    expect(entries).toEqual([]);
  });

  test('attaches tool states to the assistant text that follows them', async () => {
    const { flattenSessionMessages } = await loadTransportModule();
    const entries = flattenSessionMessages([
      {
        info: { id: 'msg_1', role: 'assistant', time: { created: 5 } },
        parts: [
          {
            type: 'tool',
            tool: 'bash',
            callID: 'call_1',
            state: { status: 'completed', title: 'Ran a command', output: 'done' },
          },
          { type: 'text', text: 'All set.' },
        ],
      },
    ]);
    expect(entries).toEqual([
      {
        id: 'msg_1',
        role: 'assistant',
        text: 'All set.',
        timestamp: 5,
        toolStates: [
          {
            id: 'call_1',
            tool: 'bash',
            status: 'completed',
            title: 'Ran a command',
            // Ported verbatim from packages/ui tool-strip.ts
            // toolStripEntryFromSessionPart(): `detail` falls back through
            // input/metadata/progress/output, so with no input/metadata/
            // progress it duplicates `output` here — that's the reference
            // behavior, not a bug in the port.
            detail: 'done',
            output: 'done',
            error: '',
            updatedAt: expect.any(Number),
          },
        ],
      },
    ]);
  });

  test('emits an orphan tool-group entry when tool parts have no following text', async () => {
    const { flattenSessionMessages } = await loadTransportModule();
    const entries = flattenSessionMessages([
      {
        info: { id: 'msg_1', role: 'assistant', time: { created: 5 } },
        parts: [{ type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'running' } }],
      },
    ]);
    expect(entries).toEqual([
      {
        id: 'msg_1:tools:0',
        type: 'tool-group',
        timestamp: 5,
        toolStates: [
          {
            id: 'call_1',
            tool: 'bash',
            status: 'running',
            title: 'bash',
            detail: '',
            output: '',
            error: '',
            updatedAt: expect.any(Number),
          },
        ],
      },
    ]);
  });

  test('concatenates text parts split across a tool interruption into one entry (single flush per row, matching the reference)', async () => {
    // The reference implementation only flushes once per row (after the
    // parts forEach loop, not per text/tool transition) — text before and
    // after an inline tool part join into one message with the tool state
    // attached, rather than splitting into two entries.
    const { flattenSessionMessages } = await loadTransportModule();
    const entries = flattenSessionMessages([
      {
        info: { id: 'msg_1', role: 'assistant', time: { created: 5 } },
        parts: [
          { type: 'text', text: 'first ' },
          { type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'completed' } },
          { type: 'text', text: 'second' },
        ],
      },
    ]);
    expect(entries.length).toBe(1);
    expect(entries[0].id).toBe('msg_1');
    expect((entries[0] as { text: string }).text).toBe('first second');
    expect((entries[0] as { toolStates?: unknown[] }).toolStates?.length).toBe(1);
  });

  test('falls back to Date.now() when a row carries no created timestamp', async () => {
    const { flattenSessionMessages } = await loadTransportModule();
    const before = Date.now();
    const entries = flattenSessionMessages([
      { info: { id: 'msg_1', role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
    ]);
    const after = Date.now();
    const [entry] = entries;
    expect('timestamp' in entry && entry.timestamp).toBeGreaterThanOrEqual(before);
    expect('timestamp' in entry && entry.timestamp).toBeLessThanOrEqual(after);
  });
});

describe('transport.getSessionMessages (B5)', () => {
  test('GETs {base}/session/{id}/message and flattens the rows', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse([
        {
          info: { id: 'msg_1', role: 'user', time: { created: 1 } },
          parts: [{ type: 'text', text: 'hi' }],
        },
        {
          info: { id: 'msg_2', role: 'assistant', time: { created: 2 } },
          parts: [{ type: 'text', text: 'hello!' }],
        },
      ])
    );
    const transport = createTransport({ baseUrl: BASE, fetch });
    const entries = await transport.getSessionMessages('ses_abc');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe(`${BASE}/session/ses_abc/message`);
    expect(entries).toEqual([
      { id: 'msg_1', role: 'user', text: 'hi', timestamp: 1 },
      { id: 'msg_2', role: 'assistant', text: 'hello!', timestamp: 2 },
    ]);
  });

  test('URL-encodes the session id path segment', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch, calls } = recordingFetch(() => jsonResponse([]));
    const transport = createTransport({ baseUrl: BASE, fetch });
    await transport.getSessionMessages('ses/../etc');
    expect(calls[0].url).toBe(`${BASE}/session/${encodeURIComponent('ses/../etc')}/message`);
  });

  test('rejects with the HTTP status attached on a non-ok response', async () => {
    const { createTransport } = await loadTransportModule();
    const { fetch } = recordingFetch(() => jsonResponse({ error: 'nope' }, 500));
    const transport = createTransport({ baseUrl: BASE, fetch });
    let caught: unknown;
    try {
      await transport.getSessionMessages('ses_abc');
    } catch (error) {
      caught = error;
    }
    expect((caught as { status?: number }).status).toBe(500);
  });
});
