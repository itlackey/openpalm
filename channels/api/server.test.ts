import { describe, expect, it } from "bun:test";
import { signPayload } from "@openpalm/lib/shared/crypto.ts";
import { createApiFetch } from "./server.ts";

describe("api adapter", () => {
  it("returns health and rejects unauthorized requests when api key is configured", async () => {
    const fetchHandler = createApiFetch("http://guardian", "secret", "key-123", fetch);
    const health = await fetchHandler(new Request("http://openai/health"));
    expect(health.status).toBe(200);

    const unauthorized = await fetchHandler(new Request("http://openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] }),
    }));
    expect(unauthorized.status).toBe(401);
  });

  it("normalizes chat payload and returns OpenAI chat-completion shape", async () => {
    let url = "";
    let signature = "";
    let body = "";
    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      signature = String((init?.headers as Record<string, string>)["x-channel-signature"]);
      body = String(init?.body);
      return new Response(JSON.stringify({ answer: "hello back" }), { status: 200 });
    };

    const fetchHandler = createApiFetch("http://guardian", "secret", "", mockFetch as typeof fetch);
    const response = await fetchHandler(new Request("http://openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4o-mini",
        user: "u1",
        messages: [{ role: "user", content: "hello" }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(url).toBe("http://guardian/channel/inbound");
    const parsedForward = JSON.parse(body) as Record<string, unknown>;
    expect(parsedForward.channel).toBe("api");
    expect(parsedForward.userId).toBe("u1");
    expect(parsedForward.text).toBe("hello");
    expect(signature).toBe(signPayload("secret", body));

    const parsedResponse = await response.json() as Record<string, unknown>;
    expect(parsedResponse.object).toBe("chat.completion");
    const choices = parsedResponse.choices as Array<Record<string, unknown>>;
    const choiceMessage = choices[0].message as Record<string, unknown>;
    expect(choiceMessage.content).toBe("hello back");
  });

  it("returns 400 when no user message found", async () => {
    const fetchHandler = createApiFetch("http://guardian", "secret", "", fetch);
    const response = await fetchHandler(new Request("http://openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "system", content: "you are helpful" }] }),
    }));
    expect(response.status).toBe(400);
  });

  it("returns 400 for streaming requests", async () => {
    const fetchHandler = createApiFetch("http://guardian", "secret", "", fetch);
    const response = await fetchHandler(new Request("http://openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(response.status).toBe(400);
  });

  it("returns 404 for unknown paths", async () => {
    const fetchHandler = createApiFetch("http://guardian", "secret", "", fetch);
    const response = await fetchHandler(new Request("http://openai/v1/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-3.5", prompt: "hi" }),
    }));
    expect(response.status).toBe(404);
  });
});
