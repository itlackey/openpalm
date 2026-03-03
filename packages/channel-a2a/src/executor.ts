/**
 * OpenPalm A2A AgentExecutor — bridges A2A protocol to Guardian.
 *
 * Implements the @a2a-js/sdk AgentExecutor interface. When the SDK's
 * request handler receives a message/send or message/stream request,
 * it calls execute() which:
 *   1. Extracts text from A2A message parts
 *   2. HMAC-signs and forwards to the Guardian
 *   3. Publishes task status and artifact events back through the event bus
 */

import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { TaskStatusUpdateEvent, TaskArtifactUpdateEvent, Message } from "@a2a-js/sdk";
import { buildChannelMessage, forwardChannelMessage, createLogger } from "@openpalm/channels-sdk";

const logger = createLogger("channel-a2a");

export interface ExecutorConfig {
  guardianUrl: string;
  channelSecret: string;
}

export class OpenPalmExecutor implements AgentExecutor {
  private config: ExecutorConfig;

  constructor(config: ExecutorConfig) {
    this.config = config;
  }

  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = context;

    // Extract text from A2A message parts
    const textParts: string[] = [];
    for (const part of userMessage.parts) {
      if (part.kind === "text") {
        textParts.push(part.text);
      }
    }
    const text = textParts.join("\n").trim();

    if (!text) {
      const failedStatus: TaskStatusUpdateEvent = {
        kind: "status-update",
        taskId,
        contextId,
        status: { state: "failed", timestamp: new Date().toISOString() },
        final: true,
      };
      eventBus.publish(failedStatus);
      eventBus.finished();
      return;
    }

    // Use contextId as userId for the Guardian, falling back to a default
    const userId = contextId || "a2a-agent";

    // Publish "working" status
    const workingStatus: TaskStatusUpdateEvent = {
      kind: "status-update",
      taskId,
      contextId,
      status: { state: "working", timestamp: new Date().toISOString() },
      final: false,
    };
    eventBus.publish(workingStatus);

    // Build HMAC-signed payload and forward to Guardian
    const payload = buildChannelMessage({
      userId,
      channel: "a2a",
      text,
      metadata: { contextId, taskId },
    });

    let guardianResp: Response;
    try {
      guardianResp = await forwardChannelMessage(
        this.config.guardianUrl,
        this.config.channelSecret,
        payload,
      );
    } catch (err) {
      logger.error("guardian_forward_failed", { taskId, error: String(err) });
      const failedStatus: TaskStatusUpdateEvent = {
        kind: "status-update",
        taskId,
        contextId,
        status: {
          state: "failed",
          timestamp: new Date().toISOString(),
        },
        final: true,
      };
      eventBus.publish(failedStatus);
      eventBus.finished();
      return;
    }

    if (!guardianResp.ok) {
      const body = await guardianResp.text().catch(() => "");
      logger.error("guardian_error_response", { taskId, status: guardianResp.status, body });
      const failedStatus: TaskStatusUpdateEvent = {
        kind: "status-update",
        taskId,
        contextId,
        status: {
          state: "failed",
          timestamp: new Date().toISOString(),
        },
        final: true,
      };
      eventBus.publish(failedStatus);
      eventBus.finished();
      return;
    }

    const data = (await guardianResp.json()) as Record<string, unknown>;
    const answer = typeof data.answer === "string" ? data.answer : "(no response)";

    // Publish artifact with assistant response
    const artifactEvent: TaskArtifactUpdateEvent = {
      kind: "artifact-update",
      taskId,
      contextId,
      artifact: {
        artifactId: crypto.randomUUID(),
        parts: [{ kind: "text", text: answer }],
      },
      append: false,
      lastChunk: true,
    };
    eventBus.publish(artifactEvent);

    // Build a response message for the completed status
    const responseMessage: Message = {
      kind: "message",
      messageId: crypto.randomUUID(),
      role: "agent",
      parts: [{ kind: "text", text: answer }],
    };

    // Publish completed status
    const completedStatus: TaskStatusUpdateEvent = {
      kind: "status-update",
      taskId,
      contextId,
      status: {
        state: "completed",
        timestamp: new Date().toISOString(),
        message: responseMessage,
      },
      final: true,
    };
    eventBus.publish(completedStatus);
    eventBus.finished();
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    logger.info("task_canceled", { taskId });
    const canceledStatus: TaskStatusUpdateEvent = {
      kind: "status-update",
      taskId,
      contextId: "",
      status: { state: "canceled", timestamp: new Date().toISOString() },
      final: true,
    };
    eventBus.publish(canceledStatus);
    eventBus.finished();
  }
}
