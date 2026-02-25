import { describe, expect, it } from "bun:test";
import { signPayload } from "@openpalm/lib/shared/crypto.ts";
import { createApiFetch } from "./server.ts";

describe("api adapter", () => {
  it("returns health and rejects unauthorized requests when api key is configured", async () => {
    const fetchHandler = createApiFetch("http://gateway", "secret", "key-123", fetch);
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

    const fetchHandler = createApiFetch("http://gateway", "secret", "", mockFetch as typeof fetch);
    const response = await fetchHandler(new Request("http://openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4o-mini",
        user: "u1",
        messages: [{ role: "user", content: "hello" }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(url).toBe("http://gateway/channel/inbound");
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

  it("normalizes completion payload and returns OpenAI completion shape", async () => {
    const mockFetch = async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ answer: "done" }), { status: 200 });
    const fetchHandler = createApiFetch("http://gateway", "secret", "", mockFetch as unknown as typeof fetch);
    const response = await fetchHandler(new Request("http://openai/v1/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-3.5-turbo-instruct",
        prompt: "finish this",
      }),
    }));

    expect(response.status).toBe(200);
    const parsedResponse = await response.json() as Record<string, unknown>;
    expect(parsedResponse.object).toBe("text_completion");
    const choices = parsedResponse.choices as Array<Record<string, unknown>>;
    expect(choices[0].text).toBe("done");
  });

  it("normalizes anthropic messages payload and returns anthropic message shape", async () => {
    let body = "";
    const mockFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ answer: "anthropic-ok" }), { status: 200 });
    };

    const fetchHandler = createApiFetch("http://gateway", "secret", "", mockFetch as typeof fetch, "");
    const response = await fetchHandler(new Request("http://openai/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-5-sonnet-latest",
        messages: [{ role: "user", content: "hello from anthropic" }],
      }),
    }));

    expect(response.status).toBe(200);
    const parsedForward = JSON.parse(body) as Record<string, unknown>;
    expect(parsedForward.channel).toBe("api");
    expect(parsedForward.text).toBe("hello from anthropic");

    const parsedResponse = await response.json() as Record<string, unknown>;
    expect(parsedResponse.type).toBe("message");
    const content = parsedResponse.content as Array<Record<string, unknown>>;
    expect(content[0].text).toBe("anthropic-ok");
  });

  it("rejects anthropic requests with invalid api key when configured", async () => {
    const fetchHandler = createApiFetch("http://gateway", "secret", "", fetch, "anthropic-key");
    const unauthorized = await fetchHandler(new Request("http://openai/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "hello" }] }),
    }));
    expect(unauthorized.status).toBe(401);
  });
});
