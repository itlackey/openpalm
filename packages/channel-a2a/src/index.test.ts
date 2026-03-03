/**
 * Tests for the OpenPalm A2A channel.
 *
 * Tests the executor (Guardian bridge), agent card, and channel structure.
 * The SDK's JSON-RPC dispatch and task lifecycle are covered by @a2a-js/sdk
 * tests — we test our integration layer.
 */

import { describe, expect, it, mock } from "bun:test";
import { signPayload } from "@openpalm/channels-sdk";
import { buildAgentCard } from "./agent-card.ts";
import { OpenPalmExecutor } from "./executor.ts";
import A2AChannel from "./index.ts";

// ── Agent Card ────────────────────────────────────────────────────────────

describe("agent card", () => {
  it("returns a valid A2A agent card", () => {
    const card = buildAgentCard();
    expect(card.name).toBe("OpenPalm Assistant");
    expect(card.version).toBe("0.1.0");
    expect(card.protocolVersion).toBe("0.2.1");
    expect(card.capabilities?.streaming).toBe(true);
    expect(card.capabilities?.pushNotifications).toBe(false);
    expect(card.skills).toHaveLength(1);
    expect(card.skills![0].id).toBe("general");
    expect(card.securitySchemes?.bearer).toBeDefined();
    expect(card.security).toEqual([{ bearer: [] }]);
    expect(card.defaultInputModes).toContain("text");
    expect(card.defaultOutputModes).toContain("text");
  });
});

// ── Channel structure ─────────────────────────────────────────────────────

describe("A2AChannel", () => {
  it("is a BaseChannel subclass with name 'a2a'", () => {
    const channel = new A2AChannel();
    expect(channel.name).toBe("a2a");
  });

  it("handleRequest returns null (all logic in start())", async () => {
    const channel = new A2AChannel();
    const result = await channel.handleRequest(new Request("http://test/"));
    expect(result).toBeNull();
  });
});

// ── Executor ──────────────────────────────────────────────────────────────

describe("OpenPalmExecutor", () => {
  function createMockEventBus() {
    const events: unknown[] = [];
    return {
      events,
      publish: (event: unknown) => { events.push(event); },
      finished: mock(() => {}),
      on: mock(() => ({})),
      off: mock(() => ({})),
      once: mock(() => ({})),
      removeAllListeners: mock(() => ({})),
    };
  }

  function createMockContext(text: string, contextId = "ctx-1", taskId = "task-1") {
    return {
      userMessage: {
        kind: "message" as const,
        messageId: "msg-1",
        role: "user" as const,
        parts: [{ kind: "text" as const, text }],
      },
      taskId,
      contextId,
      task: undefined,
      referenceTasks: undefined,
      context: undefined,
    };
  }

  it("forwards text to guardian and publishes completed status", async () => {
    let forwardedUrl = "";
    let forwardedBody = "";
    let forwardedSignature = "";

    // Mock fetch that captures the guardian request
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      forwardedUrl = String(input);
      forwardedBody = String(init?.body ?? "");
      forwardedSignature = String(
        (init?.headers as Record<string, string>)?.["x-channel-signature"] ?? "",
      );
      return new Response(JSON.stringify({ answer: "Hello from assistant" }), {
        status: 200,
      });
    }) as typeof fetch;

    try {
      const executor = new OpenPalmExecutor({
        guardianUrl: "http://guardian:8080",
        channelSecret: "test-secret",
      });

      const context = createMockContext("Hello from external agent");
      const eventBus = createMockEventBus();

      await executor.execute(context as any, eventBus as any);

      // Verify guardian was called
      expect(forwardedUrl).toBe("http://guardian:8080/channel/inbound");

      // Verify HMAC signature
      expect(forwardedSignature).toBe(signPayload("test-secret", forwardedBody));

      // Verify payload
      const payload = JSON.parse(forwardedBody) as Record<string, unknown>;
      expect(payload.channel).toBe("a2a");
      expect(payload.text).toBe("Hello from external agent");
      expect(payload.userId).toBe("ctx-1");

      // Verify event bus received correct events:
      // 1. task (working) — registers with SDK ResultManager
      // 2. artifact update
      // 3. completed status
      expect(eventBus.events).toHaveLength(3);

      const taskEvent = eventBus.events[0] as Record<string, unknown>;
      expect(taskEvent.kind).toBe("task");
      expect((taskEvent.status as Record<string, unknown>).state).toBe("working");

      const artifactEvent = eventBus.events[1] as Record<string, unknown>;
      expect(artifactEvent.kind).toBe("artifact-update");
      const artifactParts = (artifactEvent.artifact as Record<string, unknown>).parts as Array<Record<string, unknown>>;
      expect(artifactParts[0].text).toBe("Hello from assistant");

      const completedEvent = eventBus.events[2] as Record<string, unknown>;
      expect(completedEvent.kind).toBe("status-update");
      expect((completedEvent.status as Record<string, unknown>).state).toBe("completed");

      expect(eventBus.finished).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("publishes failed status when guardian returns error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 });
    }) as typeof fetch;

    try {
      const executor = new OpenPalmExecutor({
        guardianUrl: "http://guardian:8080",
        channelSecret: "test-secret",
      });

      const context = createMockContext("Hello");
      const eventBus = createMockEventBus();

      await executor.execute(context as any, eventBus as any);

      // Should have: task (working), then failed status
      expect(eventBus.events).toHaveLength(2);

      const failedEvent = eventBus.events[1] as Record<string, unknown>;
      expect(failedEvent.kind).toBe("status-update");
      expect((failedEvent.status as Record<string, unknown>).state).toBe("failed");
      expect(eventBus.finished).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("publishes failed status when guardian is unreachable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Connection refused");
    }) as typeof fetch;

    try {
      const executor = new OpenPalmExecutor({
        guardianUrl: "http://guardian:8080",
        channelSecret: "test-secret",
      });

      const context = createMockContext("Hello");
      const eventBus = createMockEventBus();

      await executor.execute(context as any, eventBus as any);

      // Should have: task (working), then failed status
      expect(eventBus.events).toHaveLength(2);

      const failedEvent = eventBus.events[1] as Record<string, unknown>;
      expect((failedEvent.status as Record<string, unknown>).state).toBe("failed");
      expect(eventBus.finished).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("publishes failed task when message has no text parts", async () => {
    const executor = new OpenPalmExecutor({
      guardianUrl: "http://guardian:8080",
      channelSecret: "test-secret",
    });

    const context = {
      userMessage: {
        kind: "message" as const,
        messageId: "msg-1",
        role: "user" as const,
        parts: [{ kind: "data" as const, data: { key: "value" } }],
      },
      taskId: "task-1",
      contextId: "ctx-1",
      task: undefined,
      referenceTasks: undefined,
      context: undefined,
    };
    const eventBus = createMockEventBus();

    await executor.execute(context as any, eventBus as any);

    expect(eventBus.events).toHaveLength(1);
    const failedEvent = eventBus.events[0] as Record<string, unknown>;
    expect(failedEvent.kind).toBe("task");
    expect((failedEvent.status as Record<string, unknown>).state).toBe("failed");
    expect(eventBus.finished).toHaveBeenCalled();
  });

  it("handles task cancellation", async () => {
    const executor = new OpenPalmExecutor({
      guardianUrl: "http://guardian:8080",
      channelSecret: "test-secret",
    });

    const eventBus = createMockEventBus();
    await executor.cancelTask("task-1", eventBus as any);

    expect(eventBus.events).toHaveLength(1);
    const canceledEvent = eventBus.events[0] as Record<string, unknown>;
    expect(canceledEvent.kind).toBe("status-update");
    expect((canceledEvent.status as Record<string, unknown>).state).toBe("canceled");
    expect(eventBus.finished).toHaveBeenCalled();
  });

  it("concatenates multiple text parts", async () => {
    let forwardedBody = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwardedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ answer: "ok" }), { status: 200 });
    }) as typeof fetch;

    try {
      const executor = new OpenPalmExecutor({
        guardianUrl: "http://guardian:8080",
        channelSecret: "test-secret",
      });

      const context = {
        userMessage: {
          kind: "message" as const,
          messageId: "msg-1",
          role: "user" as const,
          parts: [
            { kind: "text" as const, text: "First part" },
            { kind: "text" as const, text: "Second part" },
          ],
        },
        taskId: "task-1",
        contextId: "ctx-1",
        task: undefined,
        referenceTasks: undefined,
        context: undefined,
      };
      const eventBus = createMockEventBus();

      await executor.execute(context as any, eventBus as any);

      const payload = JSON.parse(forwardedBody) as Record<string, unknown>;
      expect(payload.text).toBe("First part\nSecond part");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses contextId as userId for guardian", async () => {
    let forwardedBody = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwardedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ answer: "ok" }), { status: 200 });
    }) as typeof fetch;

    try {
      const executor = new OpenPalmExecutor({
        guardianUrl: "http://guardian:8080",
        channelSecret: "test-secret",
      });

      const context = createMockContext("Hello", "custom-agent-id");
      const eventBus = createMockEventBus();

      await executor.execute(context as any, eventBus as any);

      const payload = JSON.parse(forwardedBody) as Record<string, unknown>;
      expect(payload.userId).toBe("custom-agent-id");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
