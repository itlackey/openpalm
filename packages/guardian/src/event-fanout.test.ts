/**
 * Guardian /event ownership filtering + fan-out — Stage 2 unit tests (§3.2).
 *
 * These drive the routing core directly (routeFrame / consumeSseBuffer /
 * frameSessionId) with real ownership recorded via ownership.ts, so they prove
 * the security-critical properties without standing up a live OpenCode /event:
 *
 *   - TWO-PRINCIPAL cross-leak: a frame for A's session reaches ONLY A's stream,
 *     never B's (and vice-versa) — zero cross-delivery.
 *   - NO-sessionID drop: a synthetic global frame (no properties.sessionID) is
 *     dropped for everyone (global events never reach a channel).
 *   - permission.asked records requestID→principal for the owning subscriber.
 *   - SSE buffer framing: multi-frame chunks + a split partial frame are parsed
 *     into individual frames.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  frameSessionId,
  routeFrame,
  consumeSseBuffer,
  broadcastUpstreamReset,
  _addTestSubscriber,
  _resetSubscribersForTest,
  eventSubscriberCount,
} from "./event-fanout";
import {
  type Principal,
  recordSessionOwner,
  ownsPermission,
  _resetOwnershipForTest,
} from "./ownership";
import { beginTurn, inflightTurnCount, _resetBoundsForTest } from "./oc-bounds";

const A: Principal = { id: "test", kind: "portal", userId: "alice" };
const B: Principal = { id: "test", kind: "portal", userId: "bob" };

/**
 * A test subscriber that collects every SSE chunk written to its controller.
 * Decodes each chunk back to text so assertions can read the routed frames.
 */
function collector(principal: Principal): { frames: string[]; drop: () => void } {
  const frames: string[] = [];
  const decoder = new TextDecoder();
  // A minimal stand-in for ReadableStreamDefaultController<Uint8Array>.
  const controller = {
    enqueue(bytes: Uint8Array) {
      frames.push(decoder.decode(bytes));
    },
    close() {},
    error() {},
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  const handle = _addTestSubscriber(principal, controller);
  return { frames, drop: handle.drop };
}

/** The data-payload (without the `data: ` prefix / trailing blank line). */
function payloads(frames: string[]): string[] {
  return frames.map((f) => f.replace(/^data: /, "").replace(/\n\n$/, ""));
}

beforeEach(() => {
  _resetSubscribersForTest();
  _resetOwnershipForTest();
  _resetBoundsForTest();
});

afterEach(() => {
  _resetSubscribersForTest();
  _resetOwnershipForTest();
  _resetBoundsForTest();
});

describe("frameSessionId — hard drop rule (§3.2 F2a)", () => {
  it("reads a non-empty properties.sessionID", () => {
    expect(frameSessionId(JSON.stringify({ type: "session.status", properties: { sessionID: "ses_1" } }))).toBe("ses_1");
  });

  it("absent sessionID → undefined (drop)", () => {
    expect(frameSessionId(JSON.stringify({ type: "server.heartbeat", properties: {} }))).toBeUndefined();
  });

  it("null sessionID → undefined (drop)", () => {
    expect(frameSessionId(JSON.stringify({ type: "x", properties: { sessionID: null } }))).toBeUndefined();
  });

  it("empty-string sessionID → undefined (drop)", () => {
    expect(frameSessionId(JSON.stringify({ type: "x", properties: { sessionID: "" } }))).toBeUndefined();
  });

  it("non-string sessionID → undefined (drop)", () => {
    expect(frameSessionId(JSON.stringify({ type: "x", properties: { sessionID: 123 } }))).toBeUndefined();
  });

  it("missing properties object → undefined (drop)", () => {
    expect(frameSessionId(JSON.stringify({ type: "x" }))).toBeUndefined();
  });

  it("unparseable JSON → undefined (drop)", () => {
    expect(frameSessionId("not json")).toBeUndefined();
  });
});

describe("routeFrame — two-principal cross-leak (§3.2)", () => {
  it("a frame for A's session reaches ONLY A, never B", () => {
    recordSessionOwner("ses_A", A);
    recordSessionOwner("ses_B", B);
    const a = collector(A);
    const b = collector(B);

    const frameForA = JSON.stringify({ type: "message.part.delta", properties: { sessionID: "ses_A", delta: "hi-A" } });
    routeFrame(frameForA);

    expect(payloads(a.frames)).toEqual([frameForA]);
    expect(b.frames).toEqual([]); // ZERO cross-delivery

    const frameForB = JSON.stringify({ type: "message.part.delta", properties: { sessionID: "ses_B", delta: "hi-B" } });
    routeFrame(frameForB);

    expect(payloads(a.frames)).toEqual([frameForA]); // unchanged
    expect(payloads(b.frames)).toEqual([frameForB]);

    a.drop();
    b.drop();
  });

  it("forwards the RAW UNMODIFIED frame (byte-for-byte) to the owner", () => {
    recordSessionOwner("ses_A", A);
    const a = collector(A);
    // A frame with extra/unknown fields — must pass through untouched (graceful degrade).
    const frame = JSON.stringify({ type: "session.next.tool.progress", properties: { sessionID: "ses_A", extra: { nested: [1, 2, 3] } } });
    routeFrame(frame);
    expect(payloads(a.frames)).toEqual([frame]);
    a.drop();
  });

  it("a frame for a session NEITHER principal owns reaches no one", () => {
    recordSessionOwner("ses_A", A);
    const a = collector(A);
    const b = collector(B);
    routeFrame(JSON.stringify({ type: "session.status", properties: { sessionID: "ses_unowned", status: "idle" } }));
    expect(a.frames).toEqual([]);
    expect(b.frames).toEqual([]);
    a.drop();
    b.drop();
  });
});

describe("routeFrame — no-sessionID global frames are dropped for everyone", () => {
  it("a synthetic global frame (no sessionID) reaches no subscriber", () => {
    recordSessionOwner("ses_A", A);
    const a = collector(A);
    // server.heartbeat carries properties:{} — must NEVER be forwarded.
    routeFrame(JSON.stringify({ type: "server.heartbeat", properties: {} }));
    routeFrame(JSON.stringify({ type: "server.connected", properties: {} }));
    routeFrame(JSON.stringify({ type: "installation.updated", properties: { version: "1.2.3" } }));
    expect(a.frames).toEqual([]);
    a.drop();
  });
});

describe("routeFrame — permission.asked ownership recording (§3.4)", () => {
  it("records requestID→principal for the owning subscriber only", () => {
    recordSessionOwner("ses_A", A);
    recordSessionOwner("ses_B", B);
    const a = collector(A);
    const b = collector(B);

    // properties IS the PermissionRequest: its `id` is the requestID, sessionID nested too.
    const frame = JSON.stringify({
      type: "permission.asked",
      properties: { id: "per_xyz", sessionID: "ses_A", permission: "bash", always: ["echo *"] },
    });
    routeFrame(frame);

    // Only A saw it, and only A now owns the requestID.
    expect(payloads(a.frames)).toEqual([frame]);
    expect(b.frames).toEqual([]);
    expect(ownsPermission("per_xyz", A)).toBe(true);
    expect(ownsPermission("per_xyz", B)).toBe(false);

    a.drop();
    b.drop();
  });

  it("does NOT record permission ownership when the principal does not own the session", () => {
    recordSessionOwner("ses_A", A);
    const b = collector(B); // B owns nothing
    routeFrame(JSON.stringify({ type: "permission.asked", properties: { id: "per_q", sessionID: "ses_A" } }));
    expect(b.frames).toEqual([]);
    expect(ownsPermission("per_q", B)).toBe(false);
    b.drop();
  });
});

describe("routeFrame — question.asked ownership recording (§3.4)", () => {
  it("records the que_ requestID→principal for the owning subscriber only", () => {
    // question.asked carries its reply id at properties.id (que_…) and is
    // answered by requestID exactly like permission.asked — routeFrame records
    // requestID→owner for both so the reply gate can authorize it.
    recordSessionOwner("ses_A", A);
    recordSessionOwner("ses_B", B);
    const a = collector(A);
    const b = collector(B);

    const frame = JSON.stringify({
      type: "question.asked",
      properties: { id: "que_xyz", sessionID: "ses_A", questions: [{ question: "Pick", header: "h", options: [{ label: "x", description: "" }] }] },
    });
    routeFrame(frame);

    // Only A saw the question, and only A now owns the que_ requestID.
    expect(payloads(a.frames)).toEqual([frame]);
    expect(b.frames).toEqual([]); // ZERO cross-delivery
    expect(ownsPermission("que_xyz", A)).toBe(true);
    expect(ownsPermission("que_xyz", B)).toBe(false);

    a.drop();
    b.drop();
  });
});

describe("consumeSseBuffer — SSE frame parsing", () => {
  it("parses multiple complete frames in one chunk and routes each", () => {
    recordSessionOwner("ses_A", A);
    const a = collector(A);
    const f1 = JSON.stringify({ type: "message.part.delta", properties: { sessionID: "ses_A", delta: "1" } });
    const f2 = JSON.stringify({ type: "message.part.delta", properties: { sessionID: "ses_A", delta: "2" } });
    const tail = consumeSseBuffer(`data: ${f1}\n\ndata: ${f2}\n\n`);
    expect(tail).toBe("");
    expect(payloads(a.frames)).toEqual([f1, f2]);
    a.drop();
  });

  it("returns a partial trailing frame as the unconsumed tail, completing across chunks", () => {
    recordSessionOwner("ses_A", A);
    const a = collector(A);
    const f1 = JSON.stringify({ type: "x", properties: { sessionID: "ses_A", n: 1 } });
    const f2 = JSON.stringify({ type: "x", properties: { sessionID: "ses_A", n: 2 } });
    // First chunk: one complete frame + the start of a second.
    const partialStart = `data: ${f2}`.slice(0, 15); // a deliberate mid-frame cut
    const tail = consumeSseBuffer(`data: ${f1}\n\n${partialStart}`);
    expect(payloads(a.frames)).toEqual([f1]);
    expect(tail).toBe(partialStart);
    // Second chunk: the rest of frame 2 + its boundary → routes f2.
    const rest = `data: ${f2}`.slice(15);
    const tail2 = consumeSseBuffer(`${tail}${rest}\n\n`);
    expect(tail2).toBe("");
    expect(payloads(a.frames)).toEqual([f1, f2]);
    a.drop();
  });

  it("ignores SSE comment/heartbeat lines with no data field", () => {
    recordSessionOwner("ses_A", A);
    const a = collector(A);
    const tail = consumeSseBuffer(`: heartbeat\n\n`);
    expect(tail).toBe("");
    expect(a.frames).toEqual([]);
    a.drop();
  });

  it("handles CRLF frame separators", () => {
    recordSessionOwner("ses_A", A);
    const a = collector(A);
    const f1 = JSON.stringify({ type: "x", properties: { sessionID: "ses_A" } });
    const tail = consumeSseBuffer(`data: ${f1}\r\n\r\n`);
    expect(tail).toBe("");
    expect(payloads(a.frames)).toEqual([f1]);
    a.drop();
  });
});

describe("eventSubscriberCount — /stats", () => {
  it("tracks add/drop", () => {
    expect(eventSubscriberCount()).toBe(0);
    const a = collector(A);
    expect(eventSubscriberCount()).toBe(1);
    const b = collector(B);
    expect(eventSubscriberCount()).toBe(2);
    a.drop();
    expect(eventSubscriberCount()).toBe(1);
    b.drop();
    expect(eventSubscriberCount()).toBe(0);
  });
});

describe("routeFrame — turn-end releases the in-flight-turn slot (§3.6)", () => {
  it("a session.idle frame for an owned session ends its in-flight turn AND is still forwarded", () => {
    recordSessionOwner("ses_A", A);
    const a = collector(A);
    beginTurn(A, "ses_A");
    expect(inflightTurnCount()).toBe(1);

    const idle = JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_A" } });
    routeFrame(idle);

    expect(inflightTurnCount()).toBe(0); // slot released at session-idle
    expect(payloads(a.frames)).toEqual([idle]); // turn-end frame still delivered
    a.drop();
  });

  it("an explicit idle session.status ends the turn; a non-idle one does NOT (real {type} shape)", () => {
    recordSessionOwner("ses_A", A);
    beginTurn(A, "ses_A");
    // Live 1.15.13 shape: status is an object { type: "busy" | "idle" }.
    routeFrame(JSON.stringify({ type: "session.status", properties: { sessionID: "ses_A", status: { type: "busy" } } }));
    expect(inflightTurnCount()).toBe(1); // busy ≠ turn-end
    routeFrame(JSON.stringify({ type: "session.status", properties: { sessionID: "ses_A" } }));
    expect(inflightTurnCount()).toBe(1); // missing status ≠ turn-end (no premature end)
    routeFrame(JSON.stringify({ type: "session.status", properties: { sessionID: "ses_A", status: { type: "idle" } } }));
    expect(inflightTurnCount()).toBe(0); // explicit idle ends it
  });
});

describe("broadcastUpstreamReset — synthetic session.error carries an owned sessionID (§3.2)", () => {
  it("emits one session.error per owned session so the channel-side isSessionError matches", () => {
    recordSessionOwner("ses_A1", A);
    recordSessionOwner("ses_A2", A);
    recordSessionOwner("ses_B", B);
    const a = collector(A);
    const b = collector(B);

    broadcastUpstreamReset({ name: "GuardianUpstreamReset", message: "assistant event stream reset" });

    const aFrames = payloads(a.frames).map((p) => JSON.parse(p));
    const bFrames = payloads(b.frames).map((p) => JSON.parse(p));
    // A gets a session.error for EACH owned session, each carrying its sessionID
    // (so the channel's isSessionError(e, sessionId) filter matches — without the
    // sessionID the teardown signal would be silently dropped).
    expect(aFrames.every((f) => f.type === "session.error")).toBe(true);
    expect(aFrames.map((f) => f.properties.sessionID).sort()).toEqual(["ses_A1", "ses_A2"]);
    expect(aFrames.every((f) => f.properties.error?.name === "GuardianUpstreamReset")).toBe(true);
    // B only sees its own session — zero cross-leak even on the reset path.
    expect(bFrames.map((f) => f.properties.sessionID)).toEqual(["ses_B"]);
    a.drop();
    b.drop();
  });

  it("a subscriber owning no session still gets a bare connection-level signal", () => {
    const a = collector(A); // owns nothing
    broadcastUpstreamReset({ name: "GuardianUpstreamReset", message: "reset" });
    const frames = payloads(a.frames).map((p) => JSON.parse(p));
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("session.error");
    a.drop();
  });
});
