/**
 * Shared OpenCode event interpreters — PURE unit tests (design §1.1, §4.2).
 *
 * These functions are the security/correctness-load-bearing correlation logic
 * every rich-UX renderer (Discord, Slack) shares: a delta must be attributed to
 * the right session AND messageID, a foreign session's frames must be ignored,
 * permission.asked must surface the requestID, and turn-end must be detected.
 */
import { describe, test, expect } from "bun:test";
import {
  asRaw,
  extractTextDelta,
  isTurnEnd,
  extractToolUpdate,
  extractPermissionAsk,
  extractQuestionAsk,
  partSnapshotType,
  isSessionError,
} from "./oc-events.ts";

const SID = "ses_target";
const MID = "^msgcorrelation";

function ev(type: string, properties: Record<string, unknown>) {
  return asRaw({ type, properties });
}

describe("asRaw — defensive coercion", () => {
  test("non-object yields empty type + empty properties", () => {
    expect(asRaw(null)).toEqual({ type: "", properties: {} });
    expect(asRaw(42)).toEqual({ type: "", properties: {} });
  });
  test("missing properties defaults to {}", () => {
    expect(asRaw({ type: "x" })).toEqual({ type: "x", properties: {} });
  });
});

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

  test("a delta carrying a SERVER messageID (≠ the client-supplied one) STILL renders — correlation is by session, not messageID (live-verified 2026-06-04)", () => {
    // The assistant's reply deltas carry a server-generated msg_… id, never the
    // client's; filtering by messageID would blank the stream. Session is the key.
    expect(extractTextDelta(ev("message.part.delta", { sessionID: SID, messageID: "msg_server_generated", delta: "x" }), SID)).toBe("x");
  });

  test("a reasoning-part delta is NOT rendered (chain-of-thought filtered); a text-part delta is", () => {
    const snap = partSnapshotType(ev("message.part.updated", { sessionID: SID, part: { id: "prt_reason", type: "reasoning" } }));
    expect(snap).toEqual({ partID: "prt_reason", type: "reasoning" });
    const reasoning = new Set<string>([snap!.partID]);
    // Both reasoning and answer deltas carry field:"text" — only the partID tells them apart.
    expect(extractTextDelta(ev("message.part.delta", { sessionID: SID, partID: "prt_reason", field: "text", delta: "thinking…" }), SID, reasoning)).toBeNull();
    expect(extractTextDelta(ev("message.part.delta", { sessionID: SID, partID: "prt_answer", field: "text", delta: "Hi" }), SID, reasoning)).toBe("Hi");
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

  // Live 1.15.13: status is an OBJECT { type: "idle" | "busy" } (verified
  // 2026-06-04). A bare string is also tolerated for drift-safety.
  test("session.status {type:idle} ends the turn (real 1.15.13 shape)", () => {
    expect(isTurnEnd(ev("session.status", { sessionID: SID, status: { type: "idle" } }), SID)).toBe(true);
  });

  test("session.status {type:busy} does NOT end the turn (real 1.15.13 shape)", () => {
    expect(isTurnEnd(ev("session.status", { sessionID: SID, status: { type: "busy" } }), SID)).toBe(false);
  });

  test("session.status idle as a bare string is also accepted (drift-tolerant)", () => {
    expect(isTurnEnd(ev("session.status", { sessionID: SID, status: "idle" }), SID)).toBe(true);
  });

  test("session.status busy as a bare string does NOT end the turn", () => {
    expect(isTurnEnd(ev("session.status", { sessionID: SID, status: "busy" }), SID)).toBe(false);
  });

  test("session.status with MISSING status does NOT end the turn (no premature end)", () => {
    expect(isTurnEnd(ev("session.status", { sessionID: SID }), SID)).toBe(false);
  });

  test("session.status with EMPTY status object does NOT end the turn (no premature end)", () => {
    expect(isTurnEnd(ev("session.status", { sessionID: SID, status: {} }), SID)).toBe(false);
  });

  test("session.status with an UNKNOWN status does NOT end the turn", () => {
    expect(isTurnEnd(ev("session.status", { sessionID: SID, status: { type: "thinking" } }), SID)).toBe(false);
  });

  test("turn-end for a DIFFERENT session is ignored", () => {
    expect(isTurnEnd(ev("session.idle", { sessionID: "other" }), SID)).toBe(false);
  });
});

describe("extractToolUpdate — tool-part state (§1.1, §4.1)", () => {
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

describe("extractQuestionAsk — surfaces the question tool (§ question tool)", () => {
  test("question.asked yields requestID + questions + options", () => {
    const q = extractQuestionAsk(
      ev("question.asked", {
        sessionID: SID,
        id: "que_1",
        questions: [{ question: "Where is the root?", header: "Project root", options: [{ label: "/work", description: "here" }, { label: "Other", description: "custom" }] }],
      }),
      SID,
    );
    expect(q).not.toBeNull();
    expect(q!.requestID).toBe("que_1");
    expect(q!.questions[0].options.map((o) => o.label)).toEqual(["/work", "Other"]);
  });

  test("question.asked for a foreign session is ignored", () => {
    expect(extractQuestionAsk(ev("question.asked", { sessionID: "other", id: "que_2", questions: [{ question: "x", header: "y", options: [] }] }), SID)).toBeNull();
  });

  test("question.asked missing id or questions yields null", () => {
    expect(extractQuestionAsk(ev("question.asked", { sessionID: SID, questions: [{ question: "x", header: "y", options: [] }] }), SID)).toBeNull();
    expect(extractQuestionAsk(ev("question.asked", { sessionID: SID, id: "que_3", questions: [] }), SID)).toBeNull();
  });
});

describe("isSessionError — guardian synthetic upstream reset (§3.2)", () => {
  test("session.error for our session is detected", () => {
    expect(isSessionError(ev("session.error", { sessionID: SID, error: "boom" }), SID)).toBe(true);
  });
  test("session.error for a foreign session is ignored", () => {
    expect(isSessionError(ev("session.error", { sessionID: "other" }), SID)).toBe(false);
  });
  test("a non-error event is not a session error", () => {
    expect(isSessionError(ev("session.status", { sessionID: SID, status: "idle" }), SID)).toBe(false);
  });
});
