/**
 * Unit tests for the shared turn loop + throttle buffer (post-extraction).
 *
 * The portal-driver characterization tests (each portal's stream-render.characterize)
 * lock the observable end-to-end behaviour; these pin the extracted primitives
 * directly, including the divergence knobs that keep each portal exact.
 */
import { describe, test, expect } from "bun:test";
import {
  ThrottledEditBuffer,
  renderTurn,
  type RenderSink,
  type RenderTurnOptions,
} from "./render-turn.ts";

const SID = "ses_1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ThrottledEditBuffer — edit-now-if-past-throttle else schedule-trailing-flush", () => {
  test("the first append (lastEdit=0) flushes immediately and exposes the text", async () => {
    let flushes = 0;
    let seen = "";
    const buf = new ThrottledEditBuffer(1000, () => {
      flushes++;
      seen = buf.text;
    });
    await buf.append("hello");
    expect(flushes).toBe(1);
    expect(seen).toBe("hello");
  });

  test("a second append inside the window is coalesced into ONE trailing flush", async () => {
    let flushes = 0;
    const buf = new ThrottledEditBuffer(20, () => {
      flushes++;
    });
    await buf.append("a"); // immediate
    void buf.append("b"); // scheduled
    void buf.append("c"); // already scheduled → no new timer
    expect(flushes).toBe(1);
    await sleep(40);
    expect(flushes).toBe(2);
    expect(buf.text).toBe("abc");
  });

  test("cancelPending() drops the scheduled trailing flush", async () => {
    let flushes = 0;
    const buf = new ThrottledEditBuffer(20, () => {
      flushes++;
    });
    await buf.append("a"); // immediate
    void buf.append("b"); // scheduled
    buf.cancelPending();
    await sleep(40);
    expect(flushes).toBe(1);
  });
});

// ── renderTurn harness ──────────────────────────────────────────────────────

function recordingSink(overrides: Partial<RenderSink> = {}): { sink: RenderSink; calls: string[] } {
  const calls: string[] = [];
  const sink: RenderSink = {
    onText: (d) => {
      calls.push(`text:${d}`);
    },
    onTool: (t) => {
      calls.push(`tool:${t.callID}`);
    },
    onPermission: (a) => {
      calls.push(`perm:${a.requestID}`);
    },
    onQuestion: (a) => {
      calls.push(`question:${a.requestID}`);
    },
    onSessionError: () => {
      calls.push("session-error");
    },
    ...overrides,
  };
  return { sink, calls };
}

async function* frames(...evs: unknown[]): AsyncGenerator<unknown> {
  for (const e of evs) yield e;
}

const deltaFrame = { type: "message.part.delta", properties: { sessionID: SID, messageID: "m", delta: "x" } };
const turnEndFrame = { type: "session.idle", properties: { sessionID: SID } };
const errorFrame = { type: "session.error", properties: { sessionID: SID } };

const baseOpts: RenderTurnOptions = {
  sessionId: SID,
  turnRenderTimeoutMs: 60_000,
  onFrameError: "throw",
  checkTurnEndBefore: false,
};

describe("renderTurn — dispatch + turn-end", () => {
  test("dispatches deltas then stops at turn-end", async () => {
    const { sink, calls } = recordingSink();
    await renderTurn(frames(deltaFrame, turnEndFrame, deltaFrame), sink, baseOpts);
    expect(calls).toEqual(["text:x"]); // frame after turn-end never dispatched
  });

  test("session.error renders the notice then ends", async () => {
    const { sink, calls } = recordingSink();
    await renderTurn(frames(errorFrame, deltaFrame), sink, baseOpts);
    expect(calls).toEqual(["session-error"]);
  });

  test("checkTurnEndBefore=true ends the turn identically", async () => {
    const { sink, calls } = recordingSink();
    await renderTurn(frames(deltaFrame, turnEndFrame), sink, { ...baseOpts, checkTurnEndBefore: true });
    expect(calls).toEqual(["text:x"]);
  });
});

describe("renderTurn — onFrameError divergence", () => {
  const throwingSink = () =>
    recordingSink({
      onText: () => {
        throw new Error("boom");
      },
    });

  test("'catch' swallows a throwing frame, logs it, and continues to turn-end", async () => {
    const { sink } = throwingSink();
    const errors: unknown[] = [];
    await renderTurn(frames(deltaFrame, turnEndFrame), sink, {
      ...baseOpts,
      checkTurnEndBefore: true,
      onFrameError: "catch",
      onFrameErrorLog: (err) => errors.push(err),
    });
    expect(errors).toHaveLength(1); // resolved, not rejected
  });

  test("'throw' lets a throwing frame end the turn (rejects)", async () => {
    const { sink } = throwingSink();
    await expect(
      renderTurn(frames(deltaFrame, turnEndFrame), sink, { ...baseOpts, onFrameError: "throw" }),
    ).rejects.toThrow("boom");
  });
});

describe("renderTurn — deadline", () => {
  test("a past deadline breaks immediately and calls onTimeout", async () => {
    const { sink, calls } = recordingSink();
    let timedOut = false;
    await renderTurn(frames(deltaFrame), sink, {
      ...baseOpts,
      turnRenderTimeoutMs: -1,
      onTimeout: () => {
        timedOut = true;
      },
    });
    expect(timedOut).toBe(true);
    expect(calls).toEqual([]);
  });
});
