import { describe, expect, it } from "bun:test";
import { signPayload } from "@openpalm/channels-sdk";
import ApiChannel from "./index.ts";

describe("api adapter", () => {
  it("returns health and rejects unauthorized requests when api key is configured", async () => {
    const channel = new ApiChannel();
    Object.defineProperty(channel, "apiKey", { get: () => "key-123" });
    const handler = channel.createFetch();

    const health = await handler(new Request("http://openai/health"));
    expect(health.status).toBe(200);

    const unauthorized = await handler(new Request("http://openai/v1/chat/completions", {
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

    const channel = new ApiChannel();
    Object.defineProperty(channel, "secret", { get: () => "secret" });
    Object.defineProperty(channel, "apiKey", { get: () => "" });
    const handler = channel.createFetch(mockFetch as typeof fetch);

    const response = await handler(new Request("http://openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4o-mini",
        user: "u1",
        messages: [{ role: "user", content: "hello" }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(url).toBe("http://guardian:8080/channel/inbound");
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
    const channel = new ApiChannel();
    const handler = channel.createFetch();
    const response = await handler(new Request("http://openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "system", content: "you are helpful" }] }),
    }));
    expect(response.status).toBe(400);
  });

  it("returns 400 for streaming requests", async () => {
    const channel = new ApiChannel();
    const handler = channel.createFetch();
    const response = await handler(new Request("http://openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(response.status).toBe(400);
  });

  it("returns 404 for unknown paths", async () => {
    const channel = new ApiChannel();
    const handler = channel.createFetch();
    const response = await handler(new Request("http://openai/v1/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-3.5", prompt: "hi" }),
    }));
    expect(response.status).toBe(404);
  });
});
