import { buildChannelMessage, forwardChannelMessage } from "@openpalm/lib/shared/channel-sdk.ts";
import { json } from "@openpalm/lib/shared/http.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";

const log = createLogger("channel-api");

const PORT = Number(Bun.env.PORT ?? 8186);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_API_SECRET ?? "";
const API_KEY = Bun.env.OPENAI_COMPAT_API_KEY ?? "";
const ANTHROPIC_API_KEY = Bun.env.ANTHROPIC_COMPAT_API_KEY ?? "";

function openAIError(status: number, message: string) {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: "invalid_request_error",
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function anthropicError(status: number, message: string) {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message,
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
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
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json(200, { ok: true, service: "channel-api" });

    const chatCompletions = url.pathname === "/v1/chat/completions" && req.method === "POST";
    const completions = url.pathname === "/v1/completions" && req.method === "POST";
    const anthropicMessages = url.pathname === "/v1/messages" && req.method === "POST";
    const anthropicCompletions = url.pathname === "/v1/complete" && req.method === "POST";
    if (!chatCompletions && !completions && !anthropicMessages && !anthropicCompletions) return json(404, { error: "not_found" });

    if ((chatCompletions || completions) && apiKey) {
      const authorization = req.headers.get("authorization");
      if (authorization !== `Bearer ${apiKey}`) return openAIError(401, "Unauthorized");
    }
    if ((anthropicMessages || anthropicCompletions) && anthropicApiKey) {
      const key = req.headers.get("x-api-key");
      if (key !== anthropicApiKey) return anthropicError(401, "Unauthorized");
    }

    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (contentLength > 1_048_576) {
      if (chatCompletions || completions) return openAIError(413, "Payload too large");
      return anthropicError(413, "Payload too large");
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      if (chatCompletions || completions) return openAIError(400, "Invalid JSON");
      return anthropicError(400, "Invalid JSON");
    }

    if (body.stream === true) {
      if (chatCompletions || completions) return openAIError(400, "Streaming is not supported");
      return anthropicError(400, "Streaming is not supported");
    }

    const text = chatCompletions || anthropicMessages
      ? extractChatText(body.messages)
      : extractPromptText(body.prompt);
    if (!text) {
      if (anthropicMessages) return anthropicError(400, "messages with user content is required");
      if (anthropicCompletions) return anthropicError(400, "prompt is required");
      return openAIError(400, chatCompletions ? "messages with user content is required" : "prompt is required");
    }

    const model = typeof body.model === "string" && body.model.trim() ? body.model : "openpalm";
    const userId = typeof body.user === "string" && body.user.trim() ? body.user : "api-user";

    const payload = buildChannelMessage({
      userId,
      channel: "api",
      text,
      metadata: {
        endpoint: chatCompletions
          ? "chat.completions"
          : anthropicMessages
            ? "anthropic.messages"
            : anthropicCompletions
              ? "anthropic.complete"
              : "completions",
        model,
      },
    });

    const gatewayResponse = await forwardChannelMessage(gatewayUrl, sharedSecret, payload, forwardFetch);
    if (!gatewayResponse.ok) {
      if (anthropicMessages || anthropicCompletions) {
        return anthropicError(gatewayResponse.status >= 500 ? 502 : gatewayResponse.status, `Gateway error (${gatewayResponse.status})`);
      }
      return openAIError(gatewayResponse.status >= 500 ? 502 : gatewayResponse.status, `Gateway error (${gatewayResponse.status})`);
    }

    const answerBody = await gatewayResponse.text();
    const answer = asGatewayAnswer(answerBody);
    const created = Math.floor(Date.now() / 1000);

    if (chatCompletions) {
      return json(200, {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: answer,
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      });
    }

    if (anthropicMessages) {
      return json(200, {
        id: `msg_${crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: answer }],
        model,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      });
    }

    if (anthropicCompletions) {
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
      choices: [
        {
          text: answer,
          index: 0,
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
  };
}

if (import.meta.main) {
  if (!SHARED_SECRET) {
    log.error("CHANNEL_API_SECRET is not set, exiting");
    process.exit(1);
  }
  Bun.serve({ port: PORT, fetch: createApiFetch(GATEWAY_URL, SHARED_SECRET, API_KEY) });
  log.info("started", { port: PORT });
}
