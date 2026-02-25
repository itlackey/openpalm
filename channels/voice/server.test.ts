import { describe, expect, it } from "bun:test";
import { signPayload } from "@openpalm/lib/shared/crypto.ts";
import { createVoiceFetch } from "./server.ts";

describe("voice adapter", () => {
  it("returns 501 for voice stream endpoint", async () => {
    const fetchHandler = createVoiceFetch("http://gateway", "secret", fetch);
    const resp = await fetchHandler(new Request("http://voice/voice/stream"));
    expect(resp.status).toBe(501);
  });

  it("forwards normalized transcription payload", async () => {
    let signature = "";
    let body = "";
    const mockFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      signature = String((init?.headers as Record<string, string>)["x-channel-signature"]);
      body = String(init?.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const fetchHandler = createVoiceFetch("http://gateway", "secret", mockFetch as typeof fetch);
    const resp = await fetchHandler(new Request("http://voice/voice/transcription", {
      method: "POST",
      body: JSON.stringify({ text: "transcribed", audioRef: "a1" })
    }));
    expect(resp.status).toBe(200);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed.channel).toBe("voice");
    expect(signature).toBe(signPayload("secret", body));
  });
});
