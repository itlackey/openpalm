import { describe, expect, it } from "bun:test";
import VoiceChannel from "./index";

function mockGuardianFetch() {
  const mockFetch = async () => {
    return new Response(JSON.stringify({ answer: "hello back", sessionId: "s1" }), { status: 200 });
  };
  return mockFetch as unknown as typeof fetch;
}

function createHandler() {
  const channel = new VoiceChannel();
  Object.defineProperty(channel, "secret", { get: () => "test-secret" });
  return channel.createFetch(mockGuardianFetch());
}

describe("voice channel health", () => {
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
});
