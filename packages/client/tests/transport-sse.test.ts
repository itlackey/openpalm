/**
 * P5b (#555) RED — SSE stream parsing in the client transport (P5b item 1:
 * "message send with SSE streaming", ported from the hand-rolled consumer in
 * packages/ui/src/lib/chat/session-events.ts).
 *
 * parseSseStream(stream) consumes a raw byte stream and yields parsed frames
 * ({ event?, data?, id? }). Contract pinned here (matches the ui reference
 * implementation and the SSE spec):
 *   - frames are '\n\n'-delimited; multi-line `data:` joined with '\n',
 *   - comment/heartbeat lines (':…') and `retry:` fields are ignored,
 *   - frames split across chunk boundaries are buffered, including
 *     multi-byte UTF-8 characters split mid-sequence,
 *   - comment-only frames yield nothing,
 *   - an unterminated trailing frame at end-of-stream is discarded.
 *
 * All streams here are mock ReadableStreams (no network).
 *
 * RED until src/lib/transport/index.ts exists: every test fails with
 * "Cannot find module …/src/lib/transport/index.ts" (missing feature).
 */
import { describe, expect, test } from 'bun:test';
import { loadTransportModule } from './helpers/contract.ts';
import { byteStream, collect } from './helpers/mocks.ts';

describe('transport SSE stream parsing (P5b item 1)', () => {
  test('parses a complete frame into event/data/id', async () => {
    const { parseSseStream } = await loadTransportModule();
    const frames = await collect(
      parseSseStream(byteStream(['event: message\ndata: {"a":1}\nid: 7\n\n']))
    );
    expect(frames).toEqual([{ event: 'message', data: '{"a":1}', id: '7' }]);
  });

  test('joins multi-line data with newlines (SSE spec)', async () => {
    const { parseSseStream } = await loadTransportModule();
    const frames = await collect(
      parseSseStream(byteStream(['data: line one\ndata: line two\n\n']))
    );
    expect(frames.length).toBe(1);
    expect(frames[0].data).toBe('line one\nline two');
  });

  test('accepts "data:" with no space after the colon', async () => {
    const { parseSseStream } = await loadTransportModule();
    const frames = await collect(parseSseStream(byteStream(['data:tight\n\n'])));
    expect(frames.length).toBe(1);
    expect(frames[0].data).toBe('tight');
  });

  test('ignores comment/heartbeat lines and retry: fields', async () => {
    const { parseSseStream } = await loadTransportModule();
    const frames = await collect(
      parseSseStream(byteStream([': heartbeat\nretry: 3000\ndata: ok\n\n']))
    );
    expect(frames).toEqual([{ data: 'ok' }]);
  });

  test('comment-only frames yield nothing', async () => {
    const { parseSseStream } = await loadTransportModule();
    const frames = await collect(parseSseStream(byteStream([': ping\n\n', ': ping\n\n'])));
    expect(frames).toEqual([]);
  });

  test('parses multiple frames from a single chunk', async () => {
    const { parseSseStream } = await loadTransportModule();
    const frames = await collect(
      parseSseStream(byteStream(['data: one\n\ndata: two\n\ndata: three\n\n']))
    );
    expect(frames.map((frame) => frame.data)).toEqual(['one', 'two', 'three']);
  });

  test('buffers a frame split across chunk boundaries', async () => {
    const { parseSseStream } = await loadTransportModule();
    const frames = await collect(
      parseSseStream(
        byteStream(['event: message\nda', 'ta: {"x":1}\n\nevent: done\n', 'data: {}\n\n'])
      )
    );
    expect(frames).toEqual([
      { event: 'message', data: '{"x":1}' },
      { event: 'done', data: '{}' }
    ]);
  });

  test('decodes multi-byte UTF-8 characters split across chunks', async () => {
    // '中' is 3 UTF-8 bytes, '€' is 3 — cut mid-'中' so a byte-naive decoder
    // would corrupt the text. The parser must decode in streaming mode.
    const { parseSseStream } = await loadTransportModule();
    const bytes = new TextEncoder().encode('data: 中€\n\n');
    const cut = 7; // 'data: ' = 6 bytes, +1 lands inside the 3-byte '中'
    const frames = await collect(
      parseSseStream(byteStream([bytes.slice(0, cut), bytes.slice(cut)]))
    );
    expect(frames.length).toBe(1);
    expect(frames[0].data).toBe('中€');
  });

  test('discards an unterminated trailing frame at end of stream', async () => {
    const { parseSseStream } = await loadTransportModule();
    const frames = await collect(
      parseSseStream(byteStream(['data: complete\n\ndata: incomplete']))
    );
    expect(frames.map((frame) => frame.data)).toEqual(['complete']);
  });
});
