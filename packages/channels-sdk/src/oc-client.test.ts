/**
 * OcClient — guardian-authenticated native OpenCode client unit tests.
 *
 * Stubs `fetch` (no library, per the channel-base.test.ts convention) and
 * asserts the wire contract: each call carries Basic auth + the OpenPalm user
 * headers the guardian reads today, and the SSE event reader yields parsed
 * native Event objects from the filtered /event stream.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { OcClient } from "./oc-client.ts";

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

function expectedAuthorization(principalId: string): string {
  return `Basic ${Buffer.from(`${principalId}:${SECRET}`, "utf-8").toString("base64")}`;
}

describe("OcClient — authenticated calls", () => {
  test("createSession sends Basic auth, user header, and session key", async () => {
    const { client, calls } = clientWithCapture(() => Response.json({ id: "ses_1" }));
    const session = await client.createSession("discord:alice", "discord:thread:42");
    expect(session.id).toBe("ses_1");
    const req = calls[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE}/session`);
    expect(req.headers.get("authorization")).toBe(expectedAuthorization("discord"));
    expect(req.headers.get("x-openpalm-user")).toBe("discord:alice");
    expect(req.headers.get("x-openpalm-session-key")).toBe("discord:thread:42");
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
    expect(req.headers.get("authorization")).toBe(expectedAuthorization("discord"));
    expect(req.headers.get("x-openpalm-user")).toBe("discord:bob");
  });

  test("replyPermission keeps Basic auth and user headers on follow-up calls", async () => {
    const { client, calls } = clientWithCapture(() => new Response("true", { headers: { "content-type": "application/json" } }));
    await client.prompt("discord:carol", "ses_3", "do a thing");
    await client.replyPermission("discord:carol", "per_9", "once");
    const replyReq = calls[1];
    expect(replyReq.url).toBe(`${BASE}/permission/per_9/reply`);
    expect(JSON.parse(replyReq.body).reply).toBe("once");
    expect(replyReq.headers.get("authorization")).toBe(expectedAuthorization("discord"));
    expect(replyReq.headers.get("x-openpalm-user")).toBe("discord:carol");
  });

  test('replyPermission "always" maps through verbatim', async () => {
    const { client, calls } = clientWithCapture(() => new Response("true", { headers: { "content-type": "application/json" } }));
    await client.replyPermission("discord:d", "per_x", "always");
    expect(JSON.parse(calls[0].body).reply).toBe("always");
  });

  test("abort posts to /session/{id}/abort with Basic auth", async () => {
    const { client, calls } = clientWithCapture(() => new Response("true", { headers: { "content-type": "application/json" } }));
    await client.abort("discord:e", "ses_4");
    expect(calls[0].url).toBe(`${BASE}/session/ses_4/abort`);
    expect(calls[0].headers.get("authorization")).toBe(expectedAuthorization("discord"));
    expect(calls[0].headers.get("x-openpalm-user")).toBe("discord:e");
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

  test("events() open is one authenticated GET with accept text/event-stream", async () => {
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
    expect(req.headers.get("authorization")).toBe(expectedAuthorization("discord"));
    expect(req.headers.get("x-openpalm-user")).toBe("discord:g");
  });
});
