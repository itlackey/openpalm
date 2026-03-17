/**
 * Assistant action executor — sends a message to the OpenCode API.
 *
 * Creates a new session and sends the automation prompt. The assistant
 * URL defaults to http://assistant:4096 (the internal compose service name).
 */
import type { AutomationAction } from "@openpalm/lib";
import { createLogger } from "@openpalm/lib";

const logger = createLogger("scheduler:assistant");

export async function executeAssistantAction(action: AutomationAction): Promise<void> {
  if (!action.content) {
    throw new Error("assistant action requires a non-empty 'content' field");
  }

  const baseUrl = process.env.OPENCODE_API_URL ?? "http://assistant:4096";
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (password) {
    headers["authorization"] = `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
  }

  // Create session
  const sessionRes = await fetch(`${baseUrl}/session`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ title: `automation/${action.agent ?? "default"}` }),
  });
  if (!sessionRes.ok) {
    const body = await sessionRes.text().catch(() => "");
    throw new Error(`OpenCode POST /session ${sessionRes.status}: ${body}`);
  }
  const { id: sessionId } = (await sessionRes.json()) as { id: string };
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error("Invalid session ID from assistant");
  }

  // Send message
  const msgRes = await fetch(`${baseUrl}/session/${sessionId}/message`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(action.timeout ?? 120_000),
    body: JSON.stringify({ parts: [{ type: "text", text: action.content }] }),
  });
  if (!msgRes.ok) {
    const body = await msgRes.text().catch(() => "");
    throw new Error(`OpenCode POST /session/${sessionId}/message ${msgRes.status}: ${body}`);
  }
  logger.info("assistant action completed", { sessionId });
}
