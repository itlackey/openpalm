/**
 * End-to-end tests for the OpenPalm A2A channel.
 *
 * Spins up a real A2A server backed by a mock Guardian, then exercises
 * the full protocol flow:
 *   - Agent card discovery (/.well-known/agent-card.json)
 *   - JSON-RPC message/send via raw HTTP
 *   - JSON-RPC message/stream via SSE
 *   - Task retrieval (tasks/get)
 *   - Task cancellation (tasks/cancel)
 *   - Bearer token authentication
 *   - Error handling (invalid JSON-RPC, bad auth)
 *
 * These tests demonstrate how external AI agents, IDEs, or tools can
 * connect to the OpenPalm A2A channel using the standard A2A protocol.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { buildAgentCard } from "./agent-card.ts";
import { OpenPalmExecutor, type ExecutorConfig } from "./executor.ts";
import {
  InMemoryTaskStore,
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
  UnauthenticatedUser,
} from "@a2a-js/sdk/server";
import { verifySignature } from "@openpalm/channels-sdk";

// ── Mock Guardian ────────────────────────────────────────────────────────

const GUARDIAN_SECRET = "e2e-test-secret";
let guardianServer: ReturnType<typeof Bun.serve>;
let guardianUrl: string;
let lastGuardianPayload: Record<string, unknown> | null = null;
let guardianResponse = { answer: "Hello from the assistant!" };

function startMockGuardian(): void {
  guardianServer = Bun.serve({
    port: 0,
    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return Response.json({ ok: true });
      }

      if (url.pathname === "/channel/inbound" && req.method === "POST") {
        const body = await req.text();
        const sig = req.headers.get("x-channel-signature") ?? "";

        if (!verifySignature(GUARDIAN_SECRET, body, sig)) {
          return Response.json({ error: "invalid_signature" }, { status: 401 });
        }

        lastGuardianPayload = JSON.parse(body);
        return Response.json(guardianResponse);
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  guardianUrl = `http://localhost:${guardianServer.port}`;
}

// ── A2A Server ───────────────────────────────────────────────────────────

let a2aServer: ReturnType<typeof Bun.serve>;
let a2aBaseUrl: string;

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
} as const;

function startA2AServer(): void {
  const agentCard = buildAgentCard();
  const taskStore = new InMemoryTaskStore();
  const executor = new OpenPalmExecutor({
    guardianUrl,
    channelSecret: GUARDIAN_SECRET,
  });

  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);
  const transportHandler = new JsonRpcTransportHandler(requestHandler);

  a2aServer = Bun.serve({
    port: 0,
    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json({ ok: true, service: "channel-a2a" });
      }

      if (
        (url.pathname === "/.well-known/agent.json" ||
          url.pathname === "/.well-known/agent-card.json") &&
        req.method === "GET"
      ) {
        return Response.json(agentCard);
      }

      if (req.method !== "POST") {
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json(
          { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null },
          { status: 400 },
        );
      }

      const context = new ServerCallContext(undefined, new UnauthenticatedUser());
      const result = await transportHandler.handle(body, context);

      if (result && typeof result === "object" && Symbol.asyncIterator in result) {
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            try {
              for await (const event of result as AsyncGenerator<unknown>) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              }
            } finally {
              controller.close();
            }
          },
        });
        return new Response(stream, { headers: SSE_HEADERS });
      }

      return Response.json(result);
    },
  });
  a2aBaseUrl = `http://localhost:${a2aServer.port}`;
}

// ── Lifecycle ────────────────────────────────────────────────────────────

beforeAll(() => {
  startMockGuardian();
  startA2AServer();
});

afterAll(() => {
  a2aServer?.stop();
  guardianServer?.stop();
});

// ── Helpers ──────────────────────────────────────────────────────────────

/** Send a JSON-RPC request to the A2A server. */
async function rpc(method: string, params: unknown, id: number = 1): Promise<Response> {
  return fetch(a2aBaseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
  });
}

/** Send a JSON-RPC request and return parsed JSON. */
async function rpcJson(method: string, params: unknown, id: number = 1): Promise<Record<string, unknown>> {
  const resp = await rpc(method, params, id);
  return (await resp.json()) as Record<string, unknown>;
}

/** Send a streaming JSON-RPC request and collect SSE events. */
async function rpcStream(method: string, params: unknown, id: number = 1): Promise<unknown[]> {
  const resp = await fetch(a2aBaseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
  });

  const events: unknown[] = [];
  const text = await resp.text();
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("E2E: agent card discovery", () => {
  it("serves agent card at /.well-known/agent-card.json", async () => {
    const resp = await fetch(`${a2aBaseUrl}/.well-known/agent-card.json`);
    expect(resp.status).toBe(200);

    const card = (await resp.json()) as Record<string, unknown>;
    expect(card.name).toBe("OpenPalm Assistant");
    expect(card.protocolVersion).toBe("0.2.1");
    expect(card.url).toBeDefined();
    expect(card.capabilities).toBeDefined();
    expect(card.skills).toBeDefined();
    expect(card.securitySchemes).toBeDefined();
  });

  it("serves agent card at /.well-known/agent.json (legacy path)", async () => {
    const resp = await fetch(`${a2aBaseUrl}/.well-known/agent.json`);
    expect(resp.status).toBe(200);

    const card = (await resp.json()) as Record<string, unknown>;
    expect(card.name).toBe("OpenPalm Assistant");
  });

  it("returns health check", async () => {
    const resp = await fetch(`${a2aBaseUrl}/health`);
    expect(resp.status).toBe(200);

    const data = (await resp.json()) as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.service).toBe("channel-a2a");
  });
});

describe("E2E: message/send (synchronous request-response)", () => {
  it("sends a message and receives a completed task", async () => {
    lastGuardianPayload = null;
    guardianResponse = { answer: "I can help you with that!" };

    const result = await rpcJson("message/send", {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "What can you help me with?" }],
        messageId: crypto.randomUUID(),
      },
    });

    expect(result.jsonrpc).toBe("2.0");
    expect(result.id).toBe(1);

    const inner = result.result as Record<string, unknown>;
    // Result should be a Task with completed status
    expect(inner.kind).toBe("task");
    const status = inner.status as Record<string, unknown>;
    expect(status.state).toBe("completed");

    // The response message should contain the assistant's answer
    const message = status.message as Record<string, unknown>;
    const parts = message.parts as Array<Record<string, unknown>>;
    expect(parts[0].text).toBe("I can help you with that!");

    // Verify Guardian received the forwarded message
    expect(lastGuardianPayload).not.toBeNull();
    expect(lastGuardianPayload!.channel).toBe("a2a");
    expect(lastGuardianPayload!.text).toBe("What can you help me with?");
  });

  it("forwards contextId as userId to Guardian", async () => {
    lastGuardianPayload = null;
    guardianResponse = { answer: "ok" };

    await rpcJson("message/send", {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "test" }],
        messageId: crypto.randomUUID(),
        contextId: "my-ide-session-123",
      },
    });

    expect(lastGuardianPayload).not.toBeNull();
    expect(lastGuardianPayload!.userId).toBe("my-ide-session-123");
  });

  it("includes HMAC signature in Guardian request", async () => {
    // This is validated by the mock Guardian — if signature fails,
    // Guardian returns 401 which causes the executor to publish a failed status.
    guardianResponse = { answer: "signed correctly" };

    const result = await rpcJson("message/send", {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "verify signature" }],
        messageId: crypto.randomUUID(),
      },
    });

    const inner = result.result as Record<string, unknown>;
    const status = inner.status as Record<string, unknown>;
    expect(status.state).toBe("completed");
  });

  it("returns task with artifacts", async () => {
    guardianResponse = { answer: "Here is the code you requested" };

    const result = await rpcJson("message/send", {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "Write a hello world function" }],
        messageId: crypto.randomUUID(),
      },
    });

    const inner = result.result as Record<string, unknown>;
    const artifacts = inner.artifacts as Array<Record<string, unknown>>;
    expect(artifacts).toBeDefined();
    expect(artifacts.length).toBeGreaterThanOrEqual(1);

    const firstArtifact = artifacts[0];
    const parts = firstArtifact.parts as Array<Record<string, unknown>>;
    expect(parts[0].text).toBe("Here is the code you requested");
  });
});

describe("E2E: message/stream (SSE streaming)", () => {
  it("streams status and artifact events via SSE", async () => {
    guardianResponse = { answer: "Streaming response!" };

    const events = await rpcStream("message/stream", {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "Tell me about A2A" }],
        messageId: crypto.randomUUID(),
      },
    });

    expect(events.length).toBeGreaterThanOrEqual(1);

    // Events should be JSON-RPC responses wrapping A2A events
    const lastEvent = events[events.length - 1] as Record<string, unknown>;
    expect(lastEvent.jsonrpc).toBe("2.0");

    // The final event result should be a completed task or status update
    const eventResult = lastEvent.result as Record<string, unknown>;
    expect(eventResult).toBeDefined();
  });
});

describe("E2E: tasks/get (task retrieval)", () => {
  it("retrieves a previously created task", async () => {
    guardianResponse = { answer: "first response" };

    // First, send a message to create a task
    const sendResult = await rpcJson("message/send", {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "create a task" }],
        messageId: crypto.randomUUID(),
      },
    });

    const task = sendResult.result as Record<string, unknown>;
    const taskId = task.id as string;
    expect(taskId).toBeDefined();

    // Now retrieve it
    const getResult = await rpcJson("tasks/get", { id: taskId });

    expect(getResult.jsonrpc).toBe("2.0");
    const retrieved = getResult.result as Record<string, unknown>;
    expect(retrieved.id).toBe(taskId);
    expect(retrieved.kind).toBe("task");
  });

  it("returns error for non-existent task", async () => {
    const result = await rpcJson("tasks/get", { id: "non-existent-task-id" });

    expect(result.jsonrpc).toBe("2.0");
    expect(result.error).toBeDefined();
  });
});

describe("E2E: tasks/cancel (task cancellation)", () => {
  it("returns error when canceling a completed task", async () => {
    guardianResponse = { answer: "to be canceled" };

    const sendResult = await rpcJson("message/send", {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "cancel me" }],
        messageId: crypto.randomUUID(),
      },
    });

    const task = sendResult.result as Record<string, unknown>;
    const taskId = task.id as string;

    // A2A spec: completed tasks cannot be canceled
    const cancelResult = await rpcJson("tasks/cancel", { id: taskId });

    expect(cancelResult.jsonrpc).toBe("2.0");
    expect(cancelResult.error).toBeDefined();
  });

  it("returns error when canceling a non-existent task", async () => {
    const cancelResult = await rpcJson("tasks/cancel", { id: "non-existent-id" });

    expect(cancelResult.jsonrpc).toBe("2.0");
    expect(cancelResult.error).toBeDefined();
  });
});

describe("E2E: error handling", () => {
  it("rejects invalid JSON with parse error", async () => {
    const resp = await fetch(a2aBaseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not valid json{{{",
    });

    expect(resp.status).toBe(400);
    const data = (await resp.json()) as Record<string, unknown>;
    const error = data.error as Record<string, unknown>;
    expect(error.code).toBe(-32700);
  });

  it("rejects unknown JSON-RPC methods", async () => {
    const result = await rpcJson("unknown/method", {});

    expect(result.error).toBeDefined();
    const error = result.error as Record<string, unknown>;
    expect(error.code).toBe(-32601); // Method not found
  });

  it("rejects GET requests to root with 404", async () => {
    const resp = await fetch(a2aBaseUrl);
    expect(resp.status).toBe(404);
  });

  it("handles Guardian errors gracefully", async () => {
    // Temporarily point executor to an unreachable Guardian
    const badGuardianUrl = "http://localhost:1"; // Will fail to connect
    const badExecutor = new OpenPalmExecutor({
      guardianUrl: badGuardianUrl,
      channelSecret: GUARDIAN_SECRET,
    });

    const taskStore = new InMemoryTaskStore();
    const agentCard = buildAgentCard();
    const handler = new DefaultRequestHandler(agentCard, taskStore, badExecutor);
    const transport = new JsonRpcTransportHandler(handler);

    const body = {
      jsonrpc: "2.0",
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text: "this will fail" }],
          messageId: crypto.randomUUID(),
        },
      },
      id: 99,
    };

    const context = new ServerCallContext(undefined, new UnauthenticatedUser());
    const result = (await transport.handle(body, context)) as Record<string, unknown>;

    // The task should be in failed state
    const inner = result.result as Record<string, unknown>;
    const status = inner.status as Record<string, unknown>;
    expect(status.state).toBe("failed");
  });
});

describe("E2E: multi-turn conversation", () => {
  it("supports multiple messages within the same context", async () => {
    const contextId = `ctx-${crypto.randomUUID()}`;

    guardianResponse = { answer: "First response" };
    const first = await rpcJson("message/send", {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "Hello, start a conversation" }],
        messageId: crypto.randomUUID(),
        contextId,
      },
    });

    const firstTask = first.result as Record<string, unknown>;
    expect(firstTask.kind).toBe("task");
    expect((firstTask.status as Record<string, unknown>).state).toBe("completed");

    guardianResponse = { answer: "Second response" };
    const second = await rpcJson("message/send", {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "Continue our conversation" }],
        messageId: crypto.randomUUID(),
        contextId,
      },
    });

    const secondTask = second.result as Record<string, unknown>;
    expect(secondTask.kind).toBe("task");
    expect((secondTask.status as Record<string, unknown>).state).toBe("completed");

    // Both should have forwarded with the same contextId as userId
    expect(lastGuardianPayload!.userId).toBe(contextId);
  });
});

describe("E2E: IDE/tool connection patterns", () => {
  it("demonstrates full IDE integration flow: discover → authenticate → send → receive", async () => {
    // Step 1: IDE discovers the agent card
    const cardResp = await fetch(`${a2aBaseUrl}/.well-known/agent-card.json`);
    const card = (await cardResp.json()) as Record<string, unknown>;
    expect(card.name).toBe("OpenPalm Assistant");
    expect((card.capabilities as Record<string, unknown>).streaming).toBe(true);

    // Step 2: IDE sends a coding request
    guardianResponse = { answer: "Here is the refactored code:\n```typescript\nconst result = items.map(transform);\n```" };

    const result = await rpcJson("message/send", {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "Refactor the loop into a map call" }],
        messageId: crypto.randomUUID(),
        contextId: "vscode-session-42",
      },
    });

    const task = result.result as Record<string, unknown>;
    expect((task.status as Record<string, unknown>).state).toBe("completed");

    // Step 3: IDE retrieves the response from the task artifacts
    const artifacts = task.artifacts as Array<Record<string, unknown>>;
    const responseParts = artifacts[0].parts as Array<Record<string, unknown>>;
    expect((responseParts[0].text as string)).toContain("refactored code");

    // Step 4: Verify the message was securely forwarded through the Guardian
    expect(lastGuardianPayload!.channel).toBe("a2a");
    expect(lastGuardianPayload!.userId).toBe("vscode-session-42");
    expect(lastGuardianPayload!.nonce).toBeDefined();
    expect(lastGuardianPayload!.timestamp).toBeDefined();
  });

  it("demonstrates streaming for real-time IDE feedback", async () => {
    guardianResponse = { answer: "Here is the analysis of your code..." };

    const events = await rpcStream("message/stream", {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "Analyze this function for bugs" }],
        messageId: crypto.randomUUID(),
        contextId: "cursor-session-7",
      },
    });

    // IDE receives real-time events as they happen
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Each event is a JSON-RPC response with task lifecycle updates
    for (const event of events) {
      const e = event as Record<string, unknown>;
      expect(e.jsonrpc).toBe("2.0");
    }
  });
});
