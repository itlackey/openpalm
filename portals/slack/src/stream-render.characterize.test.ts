/**
 * Slack stream-render turn-loop CHARACTERIZATION tests (pre-refactor lock).
 *
 * These drive the REAL `streamTurn` with hand-written mocks to pin the behaviour
 * that a shared `renderTurn`/`ThrottledEditBuffer` extraction MUST preserve:
 *   - the shared skeleton: post placeholder → prompt (fire-and-forget) → render
 *     deltas by editing the ONE placeholder → stop at turn-end;
 *   - the THROTTLE algorithm: the first delta flushes immediately (chat.update), a
 *     second delta inside the throttle window is coalesced (no second update) and
 *     the buffer is flushed once more on finalize (which drops the Stop button).
 */
import { describe, test, expect } from "bun:test";
import { streamTurn, SlackPermissionRegistry, type StreamSlackClient, type SlackStreamTurnArgs } from "./stream-render.ts";
import type { OcClient } from "@openpalm/portal-sdk";

const SID = "ses_target";

async function* frames(...evs: unknown[]): AsyncGenerator<unknown> {
  for (const e of evs) yield e;
}

function delta(text: string): unknown {
  return { type: "message.part.delta", properties: { sessionID: SID, messageID: "m1", delta: text } };
}
const turnEnd = { type: "session.idle", properties: { sessionID: SID } };

interface UpdateCall {
  text: string;
  hasBlocks: boolean;
}
interface PostCall {
  text: string;
  hasBlocks: boolean;
}

function harness(events: AsyncGenerator<unknown>, opts: { rejectQuestionThrows?: boolean } = {}) {
  const posts: PostCall[] = [];
  const updates: UpdateCall[] = [];

  const slack: StreamSlackClient = {
    chat: {
      async postMessage(a) {
        posts.push({ text: a.text, hasBlocks: Array.isArray(a.blocks) });
        return { ts: "1.1" };
      },
      async update(a) {
        updates.push({ text: a.text, hasBlocks: Array.isArray(a.blocks) });
        return {};
      },
    },
  };

  // Slack's onQuestion awaits `client.rejectQuestion(...).catch(...)`; the `.catch`
  // only guards an async rejection, so a SYNCHRONOUS throw here propagates out of
  // the dispatched frame — the one un-self-guarded sink call, used to prove the
  // 'throw' knob terminates the turn.
  const rejectQuestion = opts.rejectQuestionThrows
    ? (): Promise<void> => {
        throw new Error("slack question boom");
      }
    : async (): Promise<void> => {};

  const client = {
    async createSession() {
      return { id: SID };
    },
    async prompt() {},
    rejectQuestion,
    async replyPermission() {
      return true;
    },
    async abort() {},
    events() {
      return events;
    },
  } as unknown as OcClient;

  const registry = new SlackPermissionRegistry(client);

  const args: SlackStreamTurnArgs = {
    client,
    registry,
    slack,
    userId: "slack:U1",
    requestingUserId: "U1",
    channel: "C1",
    threadTs: "1.0",
    sessionKey: "slack:thread:C1:1.0",
    text: "hi",
  };
  return { args, posts, updates };
}

describe("Slack streamTurn — shared skeleton + throttle (characterization)", () => {
  test("posts one placeholder, first delta updates immediately, second is coalesced, finalize drops the Stop button", async () => {
    const h = harness(frames(delta("hello"), delta("world"), turnEnd));
    await streamTurn(h.args);

    // Exactly one placeholder post (carries the Stop button).
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].hasBlocks).toBe(true);

    // First delta → immediate chat.update WITH blocks (Stop button still shown);
    // second delta coalesced; finalize → one more chat.update WITHOUT blocks.
    expect(h.updates).toEqual([
      { text: "hello", hasBlocks: true },
      { text: "helloworld", hasBlocks: false },
    ]);
  });

  test("turn-end ends the turn (a delta after session.idle is never rendered)", async () => {
    const h = harness(frames(delta("first"), turnEnd, delta("after-end")));
    await streamTurn(h.args);
    expect(h.updates).toEqual([
      { text: "first", hasBlocks: true },
      { text: "first", hasBlocks: false },
    ]);
  });

  test("a tool frame posts a tool status message (dispatch reaches the sink)", async () => {
    const tool = { type: "session.next.tool.called", properties: { sessionID: SID, callID: "c1", tool: "bash" } };
    const h = harness(frames(tool, turnEnd));
    await streamTurn(h.args);
    // Placeholder + tool status = 2 posts, both with blocks.
    expect(h.posts.filter((p) => p.hasBlocks)).toHaveLength(2);
  });
});

describe("Slack streamTurn — a throwing frame ENDS the turn (onFrameError: throw)", () => {
  test("a dispatched sink call that throws propagates, so streamTurn rejects and later deltas never render", async () => {
    // Symmetric to the Discord test that proves Discord SWALLOWS a throwing frame:
    // Slack's loop is NOT wrapped, so a throw ends the turn. The question-reject
    // sink call is the one dispatch path Slack does not self-guard (§4.3).
    const question = {
      type: "question.asked",
      properties: { sessionID: SID, id: "q1", questions: [{ question: "pick", options: [{ label: "a" }] }] },
    };
    const h = harness(frames(question, delta("SHOULD-NOT-RENDER"), turnEnd), { rejectQuestionThrows: true });

    // The throw is NOT caught: the turn terminates by rejecting.
    await expect(streamTurn(h.args)).rejects.toThrow("slack question boom");
    // Proof the turn did not continue: the delta after the throwing frame never rendered.
    expect(h.updates.some((u) => u.text.includes("SHOULD-NOT-RENDER"))).toBe(false);
  });
});
