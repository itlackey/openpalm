/**
 * Discord stream-render turn-loop CHARACTERIZATION tests (pre-refactor lock).
 *
 * These drive the REAL `streamTurn` with hand-written mocks to pin the behaviour
 * that a shared `renderTurn`/`ThrottledEditBuffer` extraction MUST preserve:
 *   - the shared skeleton: subscribe → prompt (fire-and-forget) → render deltas →
 *     stop at turn-end;
 *   - the THROTTLE algorithm: the first delta flushes immediately (send), a second
 *     delta inside the throttle window is coalesced (no second send) and the
 *     buffer is flushed once more on finalize;
 *   - the Discord-only divergence: a throwing frame (here a permission prompt whose
 *     `thread.send` rejects) is CAUGHT so the turn survives and later deltas still
 *     render. (Slack does NOT catch — locked separately once `renderTurn` exists.)
 */
import { describe, test, expect } from "bun:test";
import { streamTurn, type StreamTurnArgs } from "./stream-render.ts";
import type { OcClient } from "@openpalm/portal-sdk";
import type { Message, ThreadChannel } from "discord.js";

const SID = "ses_target";

function frames(...evs: unknown[]): AsyncIterable<unknown> & { close?: () => void } {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of evs) yield e;
    },
    close() {},
  };
}

function delta(text: string, messageID = "m1"): unknown {
  return { type: "message.part.delta", properties: { sessionID: SID, messageID, delta: text } };
}
const turnEnd = { type: "session.idle", properties: { sessionID: SID } };

interface Harness {
  args: StreamTurnArgs;
  sends: unknown[];
  edits: string[];
  reactions: string[];
}

function harness(opts: { events: AsyncIterable<unknown> & { close?: () => void }; throwOnObjectSend?: boolean }): Harness {
  const sends: unknown[] = [];
  const edits: string[] = [];
  const reactions: string[] = [];

  const makeMessage = () =>
    ({
      async edit(content: string) {
        edits.push(content);
      },
      createMessageComponentCollector() {
        return { on() {}, stop() {} };
      },
    }) as unknown as Message;

  const thread = {
    async sendTyping() {},
    async send(arg: unknown) {
      if (opts.throwOnObjectSend && typeof arg === "object") throw new Error("discord 500");
      sends.push(arg);
      return makeMessage();
    },
  } as unknown as ThreadChannel;

  const triggerMessage = {
    async react(emoji: string) {
      reactions.push(emoji);
    },
  } as unknown as Message;

  const client = {
    async createSession() {
      return { id: SID };
    },
    async prompt() {},
    async replyPermission() {
      return true;
    },
    async replyQuestion() {
      return true;
    },
    async abort() {},
  } as unknown as OcClient;

  const args: StreamTurnArgs = {
    client,
    userId: "discord:1",
    requestingUserId: "1",
    thread,
    sessionKey: "discord:thread:1",
    text: "hi",
    subscribeEvents: () => opts.events,
    triggerMessage,
  };
  return { args, sends, edits, reactions };
}

describe("Discord streamTurn — shared skeleton + throttle (characterization)", () => {
  test("first delta flushes immediately, a second within the window is coalesced, finalize flushes once", async () => {
    const h = harness({ events: frames(delta("hello"), delta("world"), turnEnd) });
    await streamTurn(h.args);
    // Immediate flush of the FIRST delta = exactly one send; the second delta was
    // scheduled (throttled), not sent separately.
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toBe("hello");
    // finalize() edits the same message with the full accumulated buffer.
    expect(h.edits).toEqual(["helloworld"]);
  });

  test("turn-end ends the turn (a delta after session.idle is never rendered)", async () => {
    const h = harness({ events: frames(delta("first"), turnEnd, delta("after-end")) });
    await streamTurn(h.args);
    expect(h.sends).toEqual(["first"]);
    expect(h.edits).toEqual(["first"]);
  });

  test("a tool frame reacts an emoji on the trigger message (dispatch reaches the sink)", async () => {
    const tool = { type: "session.next.tool.called", properties: { sessionID: SID, callID: "c1", tool: "bash" } };
    const h = harness({ events: frames(tool, turnEnd) });
    await streamTurn(h.args);
    expect(h.reactions).toEqual(["🐚"]);
  });
});

describe("Discord streamTurn — tolerates a throwing frame (onFrameError: catch)", () => {
  test("a permission frame whose send rejects does NOT abort the turn; later deltas still render", async () => {
    const permission = { type: "permission.asked", properties: { sessionID: SID, id: "per_1", permission: "bash", patterns: [] } };
    const h = harness({ events: frames(permission, delta("survived"), turnEnd), throwOnObjectSend: true });
    // Must resolve (not reject): the malformed frame is swallowed.
    await streamTurn(h.args);
    // The permission send threw (object arg), but the following delta rendered.
    expect(h.sends).toEqual(["survived"]);
    expect(h.edits).toEqual(["survived"]);
  });
});
