/*
  Defensive plugin scaffold.
  This plugin intentionally keeps logic simple because the Gateway is the final authority.
*/

type ToolEvent = {
  toolName?: string;
  arguments?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

const SECRET_PATTERNS = [/api[_-]?key/i, /token/i, /password/i, /private[_-]?key/i];

function containsSecret(value: unknown): boolean {
  const text = JSON.stringify(value ?? "");
  return SECRET_PATTERNS.some((p) => p.test(text));
}

export default {
  name: "policy-and-telemetry",
  async onToolCall(event: ToolEvent) {
    if (containsSecret(event.arguments)) {
      throw new Error("Policy blocked: potential secret detected in tool arguments.");
    }

    console.log(
      JSON.stringify({
        kind: "tool_call",
        tool: event.toolName,
        metadata: event.metadata ?? {},
        ts: new Date().toISOString()
      })
    );
  }
};
