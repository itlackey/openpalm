/**
 * OpenPalm Channel A2A — Agent-to-Agent protocol adapter.
 *
 * Exposes the OpenPalm assistant as an A2A-discoverable agent. External
 * AI agents can discover capabilities via /.well-known/agent.json and
 * communicate via standard A2A JSON-RPC methods (message/send,
 * message/stream, tasks/get, tasks/cancel).
 *
 * Uses the official @a2a-js/sdk for protocol handling (JSON-RPC dispatch,
 * task lifecycle, SSE streaming) and the @openpalm/channels-sdk for
 * HMAC signing and Guardian forwarding.
 *
 * Extends BaseChannel so the channel-runner entrypoint can load and
 * start it, but overrides start() to wire the SDK's transport handler
 * to Bun's native HTTP server.
 */

import { BaseChannel, type HandleResult, createLogger } from "@openpalm/channels-sdk";
import {
  InMemoryTaskStore,
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
  UnauthenticatedUser,
} from "@a2a-js/sdk/server";
import type { AgentCard } from "@a2a-js/sdk";
import { buildAgentCard } from "./agent-card.ts";
import { OpenPalmExecutor } from "./executor.ts";

const logger = createLogger("channel-a2a");

// ── SSE helpers ───────────────────────────────────────────────────────────

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
} as const;

function formatSSEEvent(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// ── Channel ───────────────────────────────────────────────────────────────

export default class A2AChannel extends BaseChannel {
  name = "a2a";

  /** Bearer token for A2A agent authentication. Empty = no auth required. */
  private get bearerToken(): string {
    return Bun.env.A2A_BEARER_TOKEN ?? "";
  }

  // handleRequest is not used — all logic in start() via SDK wiring
  async handleRequest(_req: Request): Promise<HandleResult | null> {
    return null;
  }

  /**
   * Override start() to use the @a2a-js/sdk request handler instead of
   * the default BaseChannel server. This gives us full A2A protocol
   * compliance: JSON-RPC dispatch, task lifecycle, and SSE streaming.
   */
  start(): void {
    if (!this.secret) {
      logger.error(`CHANNEL_${this.name.toUpperCase()}_SECRET is not set, exiting`);
      process.exit(1);
    }

    const agentCard = buildAgentCard();
    const taskStore = new InMemoryTaskStore();
    const executor = new OpenPalmExecutor({
      guardianUrl: this.guardianUrl,
      channelSecret: this.secret,
    });

    const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);
    const transportHandler = new JsonRpcTransportHandler(requestHandler);

    Bun.serve({
      port: this.port,
      fetch: async (req: Request): Promise<Response> => {
        const url = new URL(req.url);

        // Health endpoint
        if (url.pathname === "/health" && req.method === "GET") {
          return Response.json({ ok: true, service: "channel-a2a" });
        }

        // Agent Card discovery — public, no auth required
        if (
          (url.pathname === "/.well-known/agent.json" ||
            url.pathname === "/.well-known/agent-card.json") &&
          req.method === "GET"
        ) {
          return Response.json(agentCard);
        }

        // Only accept POST for A2A JSON-RPC
        if (req.method !== "POST") {
          return Response.json({ error: "not_found" }, { status: 404 });
        }

        // Bearer token authentication
        if (this.bearerToken) {
          const auth = req.headers.get("authorization");
          if (auth !== `Bearer ${this.bearerToken}`) {
            return Response.json(
              {
                jsonrpc: "2.0",
                error: { code: -32001, message: "Unauthorized" },
                id: null,
              },
              { status: 401 },
            );
          }
        }

        // Parse JSON-RPC request body
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json(
            {
              jsonrpc: "2.0",
              error: { code: -32700, message: "Parse error" },
              id: null,
            },
            { status: 400 },
          );
        }

        // Create server call context (no auth beyond bearer token)
        const context = new ServerCallContext(undefined, new UnauthenticatedUser());

        // Dispatch to the SDK's JSON-RPC transport handler
        const result = await transportHandler.handle(body, context);

        // If the result is an async generator, stream as SSE
        if (result && typeof result === "object" && Symbol.asyncIterator in result) {
          return this.streamSSE(result as AsyncGenerator<unknown>);
        }

        // Regular JSON-RPC response
        return Response.json(result);
      },
    });

    logger.info("started", { port: this.port });
  }

  /** Convert an async generator of JSON-RPC events into an SSE Response. */
  private streamSSE(generator: AsyncGenerator<unknown>): Response {
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          for await (const event of generator) {
            controller.enqueue(encoder.encode(formatSSEEvent(event)));
          }
        } catch (err) {
          const errorEvent = {
            jsonrpc: "2.0",
            error: { code: -32603, message: `Stream error: ${err}` },
            id: null,
          };
          controller.enqueue(encoder.encode(formatSSEEvent(errorEvent)));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  }
}
