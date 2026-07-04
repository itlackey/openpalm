/**
 * BasePortal shared-hub wiring — the REAL fix for the guardian per-principal
 * /event 429.
 *
 * The guardian caps concurrent /event streams per principal at 1 (oc-bounds.ts),
 * and the principalKey includes userId (ownership.ts) — so a single user running
 * a STREAMED turn (portal streaming path → `eventHub.subscribe`) concurrently
 * with a BUFFERED turn (a `/ask` slash command → `forward` → the same hub) must
 * NOT open two upstream streams. Both paths therefore have to funnel through the
 * ONE hub instance BasePortal owns.
 *
 * This test drives both paths through the portal's ACTUAL wiring (not a hand-rolled
 * hub) and asserts exactly one upstream /event open, and that each turn still
 * receives only its own session's frames. It would fail under the old two-hub
 * layout (a dedicated bufferedHub separate from each portal's ocEventHub).
 */
import { describe, test, expect } from 'bun:test';
import { BasePortal, collectTurnAnswer, createLogger, type ForwardResult } from './index.ts';
import type { OcClient, OcSession } from './opencode.ts';

/**
 * A fake OcClient whose events() yields from a manually-fed queue and counts
 * opens, plus the createSession/prompt the buffered path needs. One shared
 * upstream ⇒ `opens` must stay at 1 no matter how many turns subscribe.
 */
function fakeClient(bufferedSessionId: string) {
  let opens = 0;
  const feeders: Array<(frame: unknown) => void> = [];
  const client = {
    events(_userId: string, signal: AbortSignal) {
      opens++;
      const queue: unknown[] = [];
      let waiting: ((r: IteratorResult<unknown>) => void) | null = null;
      let done = false;
      const push = (frame: unknown) => {
        if (waiting) {
          const w = waiting;
          waiting = null;
          w({ value: frame, done: false });
        } else queue.push(frame);
      };
      const finish = () => {
        done = true;
        if (waiting) {
          const w = waiting;
          waiting = null;
          w({ value: undefined, done: true });
        }
      };
      feeders.push(push);
      signal.addEventListener('abort', finish, { once: true });
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<unknown>> {
              if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
              if (done) return Promise.resolve({ value: undefined, done: true });
              return new Promise((res) => {
                waiting = res;
              });
            },
          };
        },
      };
    },
    createSession(_userId: string, _sessionKey?: string): Promise<OcSession> {
      return Promise.resolve({ id: bufferedSessionId });
    },
    prompt(_userId: string, _sessionId: string, _text: string): Promise<void> {
      return Promise.resolve();
    },
  };
  return { client: client as unknown as OcClient, get opens() { return opens; }, feed: (f: unknown) => feeders[0]?.(f) };
}

const delta = (sessionID: string, text: string) => ({ type: 'message.part.delta', properties: { sessionID, delta: text } });
const turnEnd = (sessionID: string) => ({ type: 'session.idle', properties: { sessionID } });

/** Minimal concrete portal that injects the fake client and exposes the two
 * stream-opening paths (streaming `eventHub.subscribe` + buffered `forward`). */
class TestPortal extends BasePortal {
  readonly name = 'slack';
  protected readonly maxMessageLength = 4000;
  protected readonly threadTtlMs = 1000;

  constructor(private readonly fake: OcClient) {
    super(createLogger('test-portal'));
  }

  protected createOcClient(): OcClient {
    return this.fake;
  }

  start(): void {}

  /** Streaming path wiring: exactly what runConversation's streamTurn calls. */
  subscribeStreaming(userId: string) {
    return this.eventHub.subscribe(userId);
  }

  /** Buffered path wiring: the `/ask` slash-command path. */
  runBuffered(result: ForwardResult) {
    return this.forward(result);
  }

  /** Open upstream /event streams on the shared hub (for the assertion). */
  get eventHubOpenStreams(): number {
    return this.eventHub.openStreamCount;
  }
}

describe('BasePortal shared /event hub', () => {
  test('a streaming turn and a buffered turn for one principal share ONE upstream stream', async () => {
    const f = fakeClient('sbuf');
    const portal = new TestPortal(f.client);

    // STREAMED turn (e.g. an @-mention thread) subscribes via the portal's
    // streaming wiring — this opens the single upstream.
    const streamSub = portal.subscribeStreaming('slack:U1');
    const streamAnswer = collectTurnAnswer(streamSub, 'sstream');

    // BUFFERED turn (e.g. a concurrent `/ask` slash command) for the SAME
    // principal goes through forward(), which subscribes through the SAME hub.
    const bufferedResp = portal.runBuffered({ userId: 'slack:U1', text: 'hi', metadata: { sessionKey: 'sk' } });

    // The whole point: one upstream /event stream for the principal, not two.
    expect(f.opens).toBe(1);
    expect(portal.eventHubOpenStreams).toBe(1);

    // Interleave both sessions' frames on the ONE upstream; each turn filters by
    // its own sessionId.
    f.feed(delta('sstream', 'S1'));
    f.feed(delta('sbuf', 'B1'));
    f.feed(delta('sstream', 'S2'));
    f.feed(turnEnd('sbuf'));
    f.feed(delta('sstream', 'S3'));
    f.feed(turnEnd('sstream'));

    expect(await streamAnswer).toBe('S1S2S3');
    const resp = await bufferedResp;
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ userId: 'slack:U1', sessionId: 'sbuf', answer: 'B1' });

    // Still one upstream after both turns completed.
    expect(f.opens).toBe(1);

    streamSub.close();
  });
});
