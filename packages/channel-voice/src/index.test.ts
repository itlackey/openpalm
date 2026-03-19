import { afterEach, describe, expect, it } from "bun:test";
import VoiceChannel from "./index";
import { config } from "./config";

const originalConfig = {
  server: { ...config.server },
  stt: { ...config.stt },
  tts: { ...config.tts },
};

afterEach(() => {
  Object.assign(config.server, originalConfig.server);
  Object.assign(config.stt, originalConfig.stt);
  Object.assign(config.tts, originalConfig.tts);
});

function mockGuardianFetch(
  responseBody: Record<string, unknown> = { answer: "hello back", sessionId: "s1" },
  capturePayload?: (payload: Record<string, unknown>) => void,
) {
  const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    if (capturePayload && typeof init?.body === "string") {
      capturePayload(JSON.parse(init.body) as Record<string, unknown>);
    }
    return new Response(JSON.stringify(responseBody), { status: 200 });
  };
  return mockFetch as unknown as typeof fetch;
}

function createHandler(fetchFn: typeof fetch = mockGuardianFetch()) {
  const channel = new VoiceChannel();
  Object.defineProperty(channel, "secret", { get: () => "test-secret" });
  return channel.createFetch(fetchFn);
}

describe("voice channel provider configuration", () => {
  it("GET /api/health returns 200 with STT/TTS config", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://voice/api/health"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("channel-voice");
    expect(body.stt).toBeDefined();
    expect(body.tts).toBeDefined();
    const stt = body.stt as Record<string, unknown>;
    const tts = body.tts as Record<string, unknown>;
    expect(stt.model).toBe("whisper-1");
    expect(tts.model).toBe("tts-1");
    expect(tts.voice).toBe("alloy");
  });
});

describe("voice channel pipeline validation", () => {
  it("POST /api/pipeline with no audio returns 400", async () => {
    const handler = createHandler();
    const form = new FormData();
    const resp = await handler(
      new Request("http://voice/api/pipeline", {
        method: "POST",
        body: form,
      })
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.error).toBe("Missing audio file or text");
  });

  it("POST /api/pipeline rejects oversized audio (>25MB)", async () => {
    const handler = createHandler();
    const form = new FormData();
    // Create a file slightly over 25MB
    const bigBuffer = new Uint8Array(26 * 1024 * 1024);
    form.append("audio", new File([bigBuffer], "big.wav", { type: "audio/wav" }));
    const resp = await handler(
      new Request("http://voice/api/pipeline", {
        method: "POST",
        body: form,
      })
    );
    expect(resp.status).toBe(413);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.error).toContain("max 25MB");
  });

  it("forwards a stable session key and trusted client IP details to guardian", async () => {
    let forwarded: Record<string, unknown> | undefined;
    const handler = createHandler(mockGuardianFetch(undefined, (payload) => {
      forwarded = payload;
    }));
    const form = new FormData();
    form.append("text", "hello");

    const resp = await handler(
      new Request("http://voice/api/pipeline", {
        method: "POST",
        headers: {
          "x-forwarded-for": "203.0.113.10, 198.51.100.7",
          "x-openpalm-session-key": "voice-client-123",
        },
        body: form,
      }),
    );

    expect(resp.status).toBe(200);
    expect(forwarded).toBeDefined();
    expect(forwarded?.userId).toBe("203.0.113.10");
    expect(forwarded?.metadata).toEqual({ sessionKey: "voice-client-123" });
  });

  it("returns 502 when guardian responds without an answer string", async () => {
    const handler = createHandler(mockGuardianFetch({ sessionId: "s1" }));
    const form = new FormData();
    form.append("text", "hello");

    const resp = await handler(
      new Request("http://voice/api/pipeline", {
        method: "POST",
        body: form,
      }),
    );

    expect(resp.status).toBe(502);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.code).toBe("guardian_bad_response");
  });
});

describe("voice channel static files", () => {
  it("GET / returns index.html", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://voice/"));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/html");
  });

  it("GET /nonexistent returns 404", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://voice/nonexistent.xyz"));
    expect(resp.status).toBe(404);
  });

  it("GET with path traversal returns 403", async () => {
    // URL parser normalizes ".." out of paths, so we call route() directly
    // with a crafted URL to test the defense-in-depth traversal guard.
    const channel = new VoiceChannel();
    Object.defineProperty(channel, "secret", { get: () => "test-secret" });
    const req = new Request("http://voice/etc/passwd", { method: "GET" });
    const url = new URL("http://voice/../../etc/passwd");
    // Override pathname to contain traversal (URL normalizes it away)
    Object.defineProperty(url, "pathname", { value: "/../../etc/passwd" });
    const resp = await channel.route(req, url);
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(403);
  });

  it("blocks prefix-based traversal attempts outside webRoot", async () => {
    config.server.webRoot = "/tmp/openpalm-web";

    const channel = new VoiceChannel();
    Object.defineProperty(channel, "secret", { get: () => "test-secret" });
    const req = new Request("http://voice/web-malicious/file.txt", { method: "GET" });
    const url = new URL("http://voice/web-malicious/file.txt");
    Object.defineProperty(url, "pathname", { value: "/../openpalm-web-malicious/file.txt" });

    const resp = await channel.route(req, url);
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(403);
  });
});

describe("voice channel health", () => {
  it("reports keyless custom providers as configured", async () => {
    config.stt.baseUrl = "http://whisper:9000";
    config.stt.apiKey = "";
    config.tts.baseUrl = "http://kokoro:8880";
    config.tts.apiKey = "";

    const handler = createHandler();
    const resp = await handler(new Request("http://voice/api/health"));
    expect(resp.status).toBe(200);

    const body = (await resp.json()) as Record<string, unknown>;
    const stt = body.stt as Record<string, unknown>;
    const tts = body.tts as Record<string, unknown>;
    expect(stt.configured).toBe(true);
    expect(tts.configured).toBe(true);
  });
});
