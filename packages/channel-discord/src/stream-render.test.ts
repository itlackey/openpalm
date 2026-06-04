/**
 * Discord stream renderer — PURE event-narrowing unit tests (design §4.1, §4.2).
 *
 * The Discord rendering side-effects (thread.send/edit, ActionRow clicks) need a
 * live Discord gateway and are stated in needsLiveVerification. What IS unit-
 * provable is the native-OpenCode-event correlation/narrowing logic, which is
 * the security- and correctness-load-bearing part: a delta must be attributed to
 * the right session AND messageID, a foreign session's frames must be ignored,
 * permission.asked must surface the requestID, and turn-end must be detected.
 */
import { describe, test, expect } from "bun:test";
import { _internal } from "./stream-render.ts";

const { extractTextDelta, isTurnEnd, extractToolUpdate, extractPermissionAsk, toolEmoji, asRaw } = _internal;

const SID = "ses_target";
const MID = "^msgcorrelation";

function ev(type: string, properties: Record<string, unknown>) {
  return asRaw({ type, properties });
}

describe("extractTextDelta — sessionID-only correlation (§4.2, corrected)", () => {
  test("message.part.delta for our session yields the delta", () => {
    expect(extractTextDelta(ev("message.part.delta", { sessionID: SID, messageID: MID, delta: "hi" }), SID)).toBe("hi");
  });

  test("session.next.text.delta (preferred 1.15.13 family) yields the delta", () => {
    expect(extractTextDelta(ev("session.next.text.delta", { sessionID: SID, messageID: MID, delta: "yo" }), SID)).toBe("yo");
  });

  test("delta for a DIFFERENT session is ignored", () => {
    expect(extractTextDelta(ev("message.part.delta", { sessionID: "other", messageID: MID, delta: "x" }), SID)).toBeNull();
  });

  test("a SERVER-generated messageID (≠ client id) still renders — session is the key (live-verified)", () => {
    expect(extractTextDelta(ev("message.part.delta", { sessionID: SID, messageID: "msg_server", delta: "x" }), SID)).toBe("x");
  });

  test("non-text field delta is ignored", () => {
    expect(extractTextDelta(ev("message.part.delta", { sessionID: SID, messageID: MID, field: "reasoning", delta: "x" }), SID)).toBeNull();
  });

  test("a non-delta event yields null", () => {
    expect(extractTextDelta(ev("session.status", { sessionID: SID, status: { type: "busy" } }), SID)).toBeNull();
  });
});

describe("isTurnEnd — session.status idle, fallback session.idle (§1.1)", () => {
  test("session.idle for our session ends the turn", () => {
    expect(isTurnEnd(ev("session.idle", { sessionID: SID }), SID)).toBe(true);
  });

  test("session.status idle ends the turn", () => {
    expect(isTurnEnd(ev("session.status", { sessionID: SID, status: "idle" }), SID)).toBe(true);
  });

  test("session.status busy does NOT end the turn", () => {
    expect(isTurnEnd(ev("session.status", { sessionID: SID, status: "busy" }), SID)).toBe(false);
  });

  test("turn-end for a DIFFERENT session is ignored", () => {
    expect(isTurnEnd(ev("session.idle", { sessionID: "other" }), SID)).toBe(false);
  });
});

describe("extractToolUpdate — colored by state.status (§4.1)", () => {
  test("message.part.updated tool part yields a tool update", () => {
    const t = extractToolUpdate(
      ev("message.part.updated", { sessionID: SID, part: { type: "tool", callID: "c1", tool: "bash", state: { status: "running", title: "echo hi" } } }),
      SID,
    );
    expect(t).not.toBeNull();
    expect(t!.callID).toBe("c1");
    expect(t!.tool).toBe("bash");
    expect(t!.status).toBe("running");
    expect(t!.title).toBe("echo hi");
  });

  test("session.next.tool.called yields a running update", () => {
    const t = extractToolUpdate(ev("session.next.tool.called", { sessionID: SID, callID: "c2", tool: "edit" }), SID);
    expect(t).not.toBeNull();
    expect(t!.callID).toBe("c2");
    expect(t!.status).toBe("running");
  });

  test("a tool update for a foreign session is ignored", () => {
    expect(extractToolUpdate(ev("message.part.updated", { sessionID: "other", part: { type: "tool", callID: "c", tool: "bash", state: { status: "running" } } }), SID)).toBeNull();
  });

  test("toolEmoji maps tool kind → a reaction emoji", () => {
    expect(toolEmoji("akm_curate")).toBe("🔎");
    expect(toolEmoji("akm_remember")).toBe("🧠");
    expect(toolEmoji("bash")).toBe("🐚");
    expect(toolEmoji("edit")).toBe("✏️");
    expect(toolEmoji("something_unknown")).toBe("🔧");
  });
});

describe("extractPermissionAsk — surfaces requestID for our session (§4.1)", () => {
  test("permission.asked yields the requestID + permission + patterns", () => {
    const ask = extractPermissionAsk(
      ev("permission.asked", { sessionID: SID, id: "per_1", permission: "bash", patterns: ["echo *"], always: ["echo *"] }),
      SID,
    );
    expect(ask).not.toBeNull();
    expect(ask!.requestID).toBe("per_1");
    expect(ask!.permission).toBe("bash");
    expect(ask!.patterns).toEqual(["echo *"]);
  });

  test("permission.asked for a foreign session is ignored", () => {
    expect(extractPermissionAsk(ev("permission.asked", { sessionID: "other", id: "per_2", permission: "bash" }), SID)).toBeNull();
  });

  test("a permission.asked missing an id yields null", () => {
    expect(extractPermissionAsk(ev("permission.asked", { sessionID: SID, permission: "bash" }), SID)).toBeNull();
  });
});
