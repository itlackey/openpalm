/**
 * OcClient — guardian-signed native OpenCode client unit tests.
 *
 * Stubs `fetch` (no library, per the channel-base.test.ts convention) and
 * asserts the wire contract: each call carries the §3.1 signed headers, the
 * signature actually verifies with the same secret on the guardian side, fresh
 * nonce/timestamp per call, and the SSE event reader yields parsed native
 * Event objects from the filtered /event stream.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { OcClient, generateMessageId } from "./oc-client.ts";
import { verifyRequest } from "./crypto.ts";

// Save the real fetch and restore it after each test — overriding the global
// here would otherwise pollute sibling test files in the same `bun test` run.
const REAL_FETCH = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = REAL_FETCH;
});

const SECRET = "discord-channel-secret";
const BASE = "http://guardian:8080/oc";

interface CapturedReq {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** Build an OcClient whose fetch is captured, returning a fixed Response. */
function clientWithCapture(respond: (req: CapturedReq) => Response): {
  client: OcClient;
  calls: CapturedReq[];
} {
  const calls: CapturedReq[] = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const captured: CapturedReq = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(captured);
    return respond(captured);
  }) as typeof fetch;
  const client = new OcClient({ channel: "discord", secret: SECRET, baseUrl: BASE });
  // Override the module-level fetch via globalThis (OcClient uses the global).
  (globalThis as { fetch: typeof fetch }).fetch = stub;
  return { client, calls };
}

/** Reconstruct the signed fields from captured headers + verify the signature. */
function verifyCapturedSignature(req: CapturedReq): boolean {
  const ocPath = req.url.slice(BASE.length);
  return verifyRequest(
    SECRET,
    {
      method: req.method,
      pathWithQuery: ocPath,
      body: req.body,
      nonce: req.headers.get("x-channel-nonce") ?? "",
      timestamp: Number(req.headers.get("x-channel-timestamp")),
      userId: req.headers.get("x-channel-user-id") ?? "",
    },
    req.headers.get("x-channel-signature") ?? "",
  );
}

describe("OcClient — signed calls (§3.1)", () => {
  test("createSession signs with the channel secret + userId and verifies", async () => {
    const { client, calls } = clientWithCapture(() => Response.json({ id: "ses_1" }));
    const session = await client.createSession("discord:alice", "discord:thread:42");
    expect(session.id).toBe("ses_1");
    const req = calls[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE}/session`);
    expect(req.headers.get("x-channel-name")).toBe("discord");
    expect(req.headers.get("x-channel-user-id")).toBe("discord:alice");
    expect(req.headers.get("x-channel-session-key")).toBe("discord:thread:42");
    expect(verifyCapturedSignature(req)).toBe(true);
  });

  test("prompt posts to /session/{id}/message with text parts and NO client messageID", async () => {
    const { client, calls } = clientWithCapture(() => new Response(JSON.stringify({ info: {}, parts: [] }), { headers: { "content-type": "application/json" } }));
    await client.prompt("discord:bob", "ses_2", "hello there");
    const req = calls[0];
    // /message (blocking) — NOT prompt_async, which no-ops on follow-up turns.
    expect(req.url).toBe(`${BASE}/session/ses_2/message`);
    const body = JSON.parse(req.body);
    // No client messageID — a client id makes OpenCode no-op follow-up turns.
    expect(body.messageID).toBeUndefined();
    expect(body.parts[0].text).toBe("hello there");
    expect(verifyCapturedSignature(req)).toBe(true);
  });

  test("replyPermission uses a FRESH nonce (not reused) and verifies", async () => {
    const { client, calls } = clientWithCapture(() => new Response("true", { headers: { "content-type": "application/json" } }));
    await client.prompt("discord:carol", "ses_3", "do a thing");
    await client.replyPermission("discord:carol", "per_9", "once");
    const promptReq = calls[0];
    const replyReq = calls[1];
    expect(replyReq.url).toBe(`${BASE}/permission/per_9/reply`);
    expect(JSON.parse(replyReq.body).reply).toBe("once");
    // Fresh per-call signing → different nonce from the prompt.
    expect(replyReq.headers.get("x-channel-nonce")).not.toBe(promptReq.headers.get("x-channel-nonce"));
    expect(verifyCapturedSignature(replyReq)).toBe(true);
  });

  test('replyPermission "always" maps through verbatim', async () => {
    const { client, calls } = clientWithCapture(() => new Response("true", { headers: { "content-type": "application/json" } }));
    await client.replyPermission("discord:d", "per_x", "always");
    expect(JSON.parse(calls[0].body).reply).toBe("always");
  });

  test("abort signs POST /session/{id}/abort and verifies", async () => {
    const { client, calls } = clientWithCapture(() => new Response("true", { headers: { "content-type": "application/json" } }));
    await client.abort("discord:e", "ses_4");
    expect(calls[0].url).toBe(`${BASE}/session/ses_4/abort`);
    expect(verifyCapturedSignature(calls[0])).toBe(true);
  });
});

describe("OcClient — filtered /event stream (§3.2, §4.2)", () => {
  test("events() yields parsed native Event objects from the SSE stream", async () => {
    const frames = [
      JSON.stringify({ type: "message.part.delta", properties: { sessionID: "ses_5", messageID: "^msg1", delta: "hel" } }),
      JSON.stringify({ type: "message.part.delta", properties: { sessionID: "ses_5", messageID: "^msg1", delta: "lo" } }),
      JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_5" } }),
    ];
    const sse = frames.map((f) => `data: ${f}\n\n`).join("");
    const { client } = clientWithCapture(() =>
      new Response(new TextEncoder().encode(sse), { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const ac = new AbortController();
    const seen: string[] = [];
    for await (const ev of client.events("discord:f", ac.signal)) {
      seen.push((ev as { type: string }).type);
      if (seen.length === 3) break;
    }
    expect(seen).toEqual(["message.part.delta", "message.part.delta", "session.idle"]);
  });

  test("events() open is one signed GET with accept text/event-stream", async () => {
    const { client, calls } = clientWithCapture(() =>
      new Response(new TextEncoder().encode(""), { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const ac = new AbortController();
    const gen = client.events("discord:g", ac.signal);
    await gen.next(); // triggers the open
    ac.abort();
    const req = calls[0];
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`${BASE}/event`);
    expect(req.headers.get("accept")).toBe("text/event-stream");
    // Empty-body GET signs SHA256("") — verifies.
    expect(verifyCapturedSignature(req)).toBe(true);
  });
});

describe("generateMessageId", () => {
  test("produces a msg_-prefixed id (OpenCode convention)", () => {
    const id = generateMessageId();
    expect(id.startsWith("msg_")).toBe(true);
    expect(id.length).toBeGreaterThan(4);
  });
});
