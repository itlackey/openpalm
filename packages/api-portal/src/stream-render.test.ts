/**
 * API channel streaming renderer — unit tests (design §4.4, §4.5) — Stage 6.
 *
 * Two layers, both unit-provable without a live OpenCode server:
 *   1. PURE protocol framers — the OpenCode-delta → OpenAI/Anthropic SSE mapping
 *      is deterministic, so we assert the exact frame shapes.
 *   2. The streamed-turn runner end-to-end against a STUBBED global fetch that
 *      emulates the guardian /oc endpoints (create session, prompt_async 204,
 *      and a filtered /event SSE stream). This proves deltas map to the right
 *      protocol frames AND that `permission.asked` drives a signed reply with
 *      the policy's decision (default reject) — the §4.5 contract.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { _internal, streamTurn, openAiChatFramer, anthropicFramer } from "./stream-render.ts";
import { loadPermissionPolicy } from "./permissions.ts";
import { createGatewayClient } from './oc-client.ts';

// ── Pure framer tests ───────────────────────────────────────────────────────

describe("openAiChunk — chat.completion.chunk delta frame", () => {
  test("wraps the delta as a content delta and terminates with a blank line", () => {
    const frame = _internal.openAiChunk("chatcmpl-x", "gpt-4", "hello");
    expect(frame.startsWith("data: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    const json = JSON.parse(frame.slice("data: ".length).trim());
    expect(json.object).toBe("chat.completion.chunk");
    expect(json.id).toBe("chatcmpl-x");
    expect(json.model).toBe("gpt-4");
    expect(json.choices[0].delta.content).toBe("hello");
    expect(json.choices[0].finish_reason).toBeNull();
  });
});

describe("openAiDoneChunks — terminal stop + [DONE]", () => {
  test("emits a finish_reason:stop chunk then data: [DONE]", () => {
    const out = _internal.openAiDoneChunks("chatcmpl-x", "gpt-4");
    const frames = out.split("\n\n").filter(Boolean);
    const stop = JSON.parse(frames[0].slice("data: ".length));
    expect(stop.choices[0].finish_reason).toBe("stop");
    expect(stop.choices[0].delta).toEqual({});
    expect(frames[1]).toBe("data: [DONE]");
  });
});

describe("openAiLegacyChunk — text_completion streaming frame", () => {
  test("carries text + finish_reason", () => {
    const json = JSON.parse(_internal.openAiLegacyChunk("cmpl-x", "gpt-3.5", "abc", null).slice("data: ".length));
    expect(json.object).toBe("text_completion");
    expect(json.choices[0].text).toBe("abc");
    expect(json.choices[0].finish_reason).toBeNull();
  });
});

describe("anthropic framing — message_start … message_stop sequence", () => {
  test("start emits message_start then content_block_start", () => {
    const out = _internal.anthropicStart("msg_x", "claude-3");
    expect(out).toContain("event: message_start");
    expect(out).toContain("event: content_block_start");
    const first = JSON.parse(out.split("\n\n")[0].split("data: ")[1]);
    expect(first.type).toBe("message_start");
    expect(first.message.id).toBe("msg_x");
    expect(first.message.role).toBe("assistant");
  });

  test("delta is a text_delta content_block_delta", () => {
    const json = JSON.parse(_internal.anthropicDelta("hi").split("data: ")[1].trim());
    expect(json.type).toBe("content_block_delta");
    expect(json.delta.type).toBe("text_delta");
    expect(json.delta.text).toBe("hi");
  });

  test("stop emits block_stop → message_delta → message_stop", () => {
    const out = _internal.anthropicStop();
    expect(out).toContain("event: content_block_stop");
    expect(out).toContain("event: message_delta");
    expect(out).toContain("event: message_stop");
  });
});

// ── Streamed-turn runner (stubbed global fetch) ─────────────────────────────

const REAL_FETCH = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = REAL_FETCH;
});

/** Build an SSE body from a list of OpenCode event frames. */
function sseBody(events: Array<{ type: string; properties: Record<string, unknown> }>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      }
      controller.close();
    },
  });
}

interface StubOpts {
  sessionId: string;
  events: Array<{ type: string; properties: Record<string, unknown> }>;
  /** Capture every guardian /oc call for assertions. */
  calls: Array<{ method: string; path: string; body: string }>;
}

/** Stub the guardian /oc proxy: POST /session, prompt_async (204), GET /event, replies. */
function stubGuardian(opts: StubOpts): void {
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const path = url.replace("http://guardian:8080/oc", "");
    opts.calls.push({ method, path, body: typeof init?.body === "string" ? init.body : "" });

    if (method === "POST" && path === "/session") {
      return new Response(JSON.stringify({ id: opts.sessionId }), { status: 200 });
    }
    if (method === "POST" && path.endsWith("/message")) {
      return new Response(JSON.stringify({ info: {}, parts: [] }), { status: 200 });
    }
    if (method === "GET" && path === "/event") {
      return new Response(sseBody(opts.events), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (method === "POST" && path.includes("/permission/")) {
      return new Response(JSON.stringify(true), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  (globalThis as { fetch: typeof fetch }).fetch = stub;
}

async function readAll(resp: Response): Promise<string> {
  const reader = resp.body!.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

const SID = "ses_api_target";

describe("streamTurn — OpenAI deltas map to chat.completion.chunk SSE (§4.4)", () => {
  test("text deltas for our session+messageID stream as chunks, ending with [DONE]", async () => {
    const calls: StubOpts["calls"] = [];
    // The runner generates the messageID internally; emit deltas WITHOUT a
    // messageID so they correlate on sessionID alone (extractTextDelta only
    // filters on messageID when the frame carries one).
    stubGuardian({
      sessionId: SID,
      calls,
      events: [
        { type: "message.part.delta", properties: { sessionID: SID, delta: "Hel" } },
        { type: "message.part.delta", properties: { sessionID: SID, delta: "lo" } },
        { type: "session.status", properties: { sessionID: SID, status: "idle" } },
      ],
    });

    const client = createGatewayClient('http://guardian:8080/oc', 'api', 's');
    const resp = streamTurn({
      client,
      policy: loadPermissionPolicy({}),
      userId: "api:u1",
      sessionKey: "api:u1",
      text: "hi",
      framer: openAiChatFramer("chatcmpl-test", "gpt-4"),
    });
    expect(resp.headers.get("content-type")).toBe("text/event-stream");

    const out = await readAll(resp);
    // Role chunk first, then content deltas, then stop + [DONE].
    expect(out).toContain('"role":"assistant"');
    expect(out).toContain('"content":"Hel"');
    expect(out).toContain('"content":"lo"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);

    // The guardian was driven through create → message → event.
    expect(calls.some((c) => c.method === "POST" && c.path === "/session")).toBe(true);
    expect(calls.some((c) => c.path.endsWith("/message"))).toBe(true);
    expect(calls.some((c) => c.path === "/event")).toBe(true);
  });
});

describe("streamTurn — Anthropic deltas map to content_block_delta SSE (§4.4)", () => {
  test("emits message_start, a text_delta, and the stop sequence", async () => {
    const calls: StubOpts["calls"] = [];
    stubGuardian({
      sessionId: SID,
      calls,
      events: [
        { type: "session.next.text.delta", properties: { sessionID: SID, delta: "world" } },
        { type: "session.status", properties: { sessionID: SID, status: "idle" } },
      ],
    });

    const client = createGatewayClient('http://guardian:8080/oc', 'api', 's');
    const resp = streamTurn({
      client,
      policy: loadPermissionPolicy({}),
      userId: "api:u1",
      sessionKey: "api:u1",
      text: "hi",
      framer: anthropicFramer("msg_test", "claude-3"),
    });

    const out = await readAll(resp);
    expect(out).toContain("event: message_start");
    expect(out).toContain('"text":"world"');
    expect(out).toContain("event: message_stop");
  });
});

describe("streamTurn — non-interactive permission policy (§4.5)", () => {
  test("default policy REJECTS permission.asked via a signed guardian reply", async () => {
    const calls: StubOpts["calls"] = [];
    stubGuardian({
      sessionId: SID,
      calls,
      events: [
        { type: "permission.asked", properties: { id: "per_42", sessionID: SID, permission: "bash", patterns: ["echo x"] } },
        { type: "session.status", properties: { sessionID: SID, status: "idle" } },
      ],
    });

    const client = createGatewayClient('http://guardian:8080/oc', 'api', 's');
    const resp = streamTurn({
      client,
      policy: loadPermissionPolicy({}), // default → reject
      userId: "api:u1",
      sessionKey: "api:u1",
      text: "run bash",
      framer: openAiChatFramer("chatcmpl-test", "gpt-4"),
    });
    await readAll(resp);

    const reply = calls.find((c) => c.path === "/permission/per_42/reply");
    expect(reply).toBeDefined();
    expect(JSON.parse(reply!.body).reply).toBe("reject");
  });

  test("auto policy with an allowlist APPROVES the matching tool (reply:once)", async () => {
    const calls: StubOpts["calls"] = [];
    stubGuardian({
      sessionId: SID,
      calls,
      events: [
        { type: "permission.asked", properties: { id: "per_99", sessionID: SID, permission: "bash", patterns: [] } },
        { type: "session.status", properties: { sessionID: SID, status: "idle" } },
      ],
    });

    const client = createGatewayClient('http://guardian:8080/oc', 'api', 's');
    const resp = streamTurn({
      client,
      policy: loadPermissionPolicy({ OP_API_PERMISSION_MODE: "auto", OP_API_PERMISSION_ALLOWLIST: "bash" }),
      userId: "api:u1",
      sessionKey: "api:u1",
      text: "run bash",
      framer: openAiChatFramer("chatcmpl-test", "gpt-4"),
    });
    await readAll(resp);

    const reply = calls.find((c) => c.path === "/permission/per_99/reply");
    expect(JSON.parse(reply!.body).reply).toBe("once");
  });
});
