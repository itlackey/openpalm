/**
 * collectTurnAnswer + OcEventHub — the buffered (non-streaming) turn path shared
 * by BOTH portals must route its /event subscription through the per-principal
 * hub, so two concurrent turns for one principal share ONE upstream /event
 * stream (the guardian caps concurrent streams per principal at 1 — a second
 * open 429s and silently loses its turn).
 *
 * We stub OcClient.events with a controllable async generator that counts opens
 * and lets us feed frames into the single upstream, so the test never needs a
 * live guardian.
 */
import { describe, test, expect } from 'bun:test';
import { OcEventHub, collectTurnAnswer } from './index.ts';

/** A fake OcClient whose events() yields from a manually-fed queue per call. */
function fakeClient() {
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
  };
  return { client, get opens() { return opens; }, feed: (i: number, f: unknown) => feeders[i]?.(f) };
}

const delta = (sessionID: string, text: string) => ({ type: 'message.part.delta', properties: { sessionID, delta: text } });
const turnEnd = (sessionID: string) => ({ type: 'session.idle', properties: { sessionID } });

describe('collectTurnAnswer via OcEventHub', () => {
  test('two concurrent buffered turns for one principal share ONE upstream stream and each get their frames', async () => {
    const f = fakeClient();
    const hub = new OcEventHub(f.client as never);

    // Two concurrent turns (e.g. two threads/DMs) for the SAME principal.
    const subA = hub.subscribe('slack:U1');
    const subB = hub.subscribe('slack:U1');

    const answerA = collectTurnAnswer(subA, 's1');
    const answerB = collectTurnAnswer(subB, 's2');

    // A single upstream /event open despite two concurrent turns.
    expect(f.opens).toBe(1);
    expect(hub.openStreamCount).toBe(1);

    // Interleave both sessions' frames on the ONE upstream; each turn filters by
    // its own sessionId, so each assembles only its own deltas.
    f.feed(0, delta('s1', 'A1'));
    f.feed(0, delta('s2', 'B1'));
    f.feed(0, delta('s1', 'A2'));
    f.feed(0, turnEnd('s1'));
    f.feed(0, delta('s2', 'B2'));
    f.feed(0, turnEnd('s2'));

    expect(await answerA).toBe('A1A2');
    expect(await answerB).toBe('B1B2');
    expect(f.opens).toBe(1);

    subA.close();
    subB.close();
  });
});
