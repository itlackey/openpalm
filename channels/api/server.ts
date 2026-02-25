import { createHttpAdapterFetch } from "@openpalm/lib/shared/channel-adapter-http-server.ts";
import type { ChannelAdapter, InboundResult } from "@openpalm/lib/shared/channel.ts";
import { readJsonObject, rejectPayloadTooLarge } from "@openpalm/lib/shared/channel-http.ts";
import { json } from "@openpalm/lib/shared/http.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";
import { installGracefulShutdown } from "@openpalm/lib/shared/shutdown.ts";

const log = createLogger("channel-api");

const PORT = Number(Bun.env.PORT ?? 8186);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_API_SECRET ?? "";
const API_KEY = Bun.env.OPENAI_COMPAT_API_KEY ?? "";
const ANTHROPIC_API_KEY = Bun.env.ANTHROPIC_COMPAT_API_KEY ?? "";

function openAIErrorBody(message: string) {
  return {
    error: {
      message,
      type: "invalid_request_error",
    },
  };
}

function anthropicErrorBody(message: string) {
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractPromptText(prompt: unknown): string | null {
  if (typeof prompt === "string" && prompt.trim()) return prompt;
  if (Array.isArray(prompt)) {
    const parts = prompt.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    if (parts.length > 0) return parts.join("\n");
  }
  return null;
}

function extractMessageText(content: unknown): string | null {
  if (typeof content === "string" && content.trim()) return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (!record || record.type !== "text" || typeof record.text !== "string" || !record.text.trim()) continue;
    parts.push(record.text);
  }
  if (parts.length === 0) return null;
  return parts.join("\n");
}

function extractChatText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  const userMessages: string[] = [];
  for (const message of messages) {
    const record = asRecord(message);
    if (!record || record.role !== "user") continue;
    const text = extractMessageText(record.content);
    if (text) userMessages.push(text);
  }
  if (userMessages.length === 0) return null;
  return userMessages[userMessages.length - 1];
}

function asGatewayAnswer(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.answer === "string") return parsed.answer;
  } catch {
    // passthrough
  }
  return "";
}

export function createApiFetch(
  gatewayUrl: string,
  sharedSecret: string,
  apiKey: string,
  forwardFetch: typeof fetch = fetch,
  anthropicApiKey = ANTHROPIC_API_KEY,
) {
  const openAiRoute = (endpoint: "chat.completions" | "completions"): ChannelAdapter["routes"][number] => ({
    method: "POST",
    path: endpoint === "chat.completions" ? "/v1/chat/completions" : "/v1/completions",
    handler: async (req: Request): Promise<InboundResult> => {
      if (apiKey) {
        const authorization = req.headers.get("authorization");
        if (authorization !== `Bearer ${apiKey}`) return { ok: false, status: 401, body: openAIErrorBody("Unauthorized") };
      }

      const tooLarge = rejectPayloadTooLarge(req);
      if (tooLarge) return { ok: false, status: 413, body: openAIErrorBody("Payload too large") };

      const body = await readJsonObject<Record<string, unknown>>(req);
      if (!body) return { ok: false, status: 400, body: openAIErrorBody("Invalid JSON") };
      if (body.stream === true) return { ok: false, status: 400, body: openAIErrorBody("Streaming is not supported") };

      const text = endpoint === "chat.completions" ? extractChatText(body.messages) : extractPromptText(body.prompt);
      if (!text) {
        return {
          ok: false,
          status: 400,
          body: openAIErrorBody(endpoint === "chat.completions" ? "messages with user content is required" : "prompt is required"),
        };
      }

      const model = typeof body.model === "string" && body.model.trim() ? body.model : "openpalm";
      const userId = typeof body.user === "string" && body.user.trim() ? body.user : "api-user";

      return {
        ok: true,
        payload: {
          userId,
          channel: "api",
          text,
          metadata: { endpoint, model },
        },
      };
    },
  });

  const anthropicRoute = (endpoint: "anthropic.messages" | "anthropic.complete"): ChannelAdapter["routes"][number] => ({
    method: "POST",
    path: endpoint === "anthropic.messages" ? "/v1/messages" : "/v1/complete",
    handler: async (req: Request): Promise<InboundResult> => {
      if (anthropicApiKey) {
        const key = req.headers.get("x-api-key");
        if (key !== anthropicApiKey) return { ok: false, status: 401, body: anthropicErrorBody("Unauthorized") };
      }

      const tooLarge = rejectPayloadTooLarge(req);
      if (tooLarge) return { ok: false, status: 413, body: anthropicErrorBody("Payload too large") };

      const body = await readJsonObject<Record<string, unknown>>(req);
      if (!body) return { ok: false, status: 400, body: anthropicErrorBody("Invalid JSON") };
      if (body.stream === true) return { ok: false, status: 400, body: anthropicErrorBody("Streaming is not supported") };

      const text = endpoint === "anthropic.messages" ? extractChatText(body.messages) : extractPromptText(body.prompt);
      if (!text) {
        return {
          ok: false,
          status: 400,
          body: anthropicErrorBody(endpoint === "anthropic.messages" ? "messages with user content is required" : "prompt is required"),
        };
      }

      const model = typeof body.model === "string" && body.model.trim() ? body.model : "openpalm";
      const userId = typeof body.user === "string" && body.user.trim() ? body.user : "api-user";

      return {
        ok: true,
        payload: {
          userId,
          channel: "api",
          text,
          metadata: { endpoint, model },
        },
      };
    },
  });

  const adapter: ChannelAdapter = {
    name: "api",
    routes: [
      openAiRoute("chat.completions"),
      openAiRoute("completions"),
      anthropicRoute("anthropic.messages"),
      anthropicRoute("anthropic.complete"),
    ],
    health: () => ({ ok: true, service: "channel-api" }),
  };

  return createHttpAdapterFetch(adapter, gatewayUrl, sharedSecret, forwardFetch, {
    onRouteError: ({ status, body }) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    onGatewayError: ({ gatewayStatus, payloadMetadata }) => {
      const endpoint = payloadMetadata?.endpoint;
      const message = `Gateway error (${gatewayStatus})`;
      const status = gatewayStatus >= 500 ? 502 : gatewayStatus;
      const body = typeof endpoint === "string" && endpoint.startsWith("anthropic.")
        ? anthropicErrorBody(message)
        : openAIErrorBody(message);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    },
    onSuccess: ({ payloadMetadata, gatewayBodyText }) => {
      const answer = asGatewayAnswer(gatewayBodyText);
      const endpoint = typeof payloadMetadata?.endpoint === "string" ? payloadMetadata.endpoint : "completions";
      const model = typeof payloadMetadata?.model === "string" && payloadMetadata.model.trim()
        ? payloadMetadata.model
        : "openpalm";
      const created = Math.floor(Date.now() / 1000);

      if (endpoint === "chat.completions") {
        return json(200, {
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: "chat.completion",
          created,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
      if (endpoint === "anthropic.messages") {
        return json(200, {
          id: `msg_${crypto.randomUUID()}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: answer }],
          model,
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        });
      }
      if (endpoint === "anthropic.complete") {
        return json(200, {
          id: `compl-${crypto.randomUUID()}`,
          type: "completion",
          completion: answer,
          stop_reason: "stop_sequence",
          model,
        });
      }

      return json(200, {
        id: `cmpl-${crypto.randomUUID()}`,
        object: "text_completion",
        created,
        model,
        choices: [{ text: answer, index: 0, logprobs: null, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    },
  });
}

if (import.meta.main) {
  if (!SHARED_SECRET) {
    log.error("CHANNEL_API_SECRET is not set, exiting");
    process.exit(1);
  }
  const server = Bun.serve({ port: PORT, fetch: createApiFetch(GATEWAY_URL, SHARED_SECRET, API_KEY) });
  installGracefulShutdown(server, { service: "channel-api", logger: log });
  log.info("started", { port: PORT });
}
