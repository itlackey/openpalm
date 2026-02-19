/**
 * Defensive policy plugin for OpenCode.
 *
 * Scans tool arguments for secret patterns and blocks execution if detected.
 * Logs all tool calls as structured JSON for audit purposes.
 *
 * The Gateway is the final authority — this plugin is a secondary guardrail.
 */

const SECRET_PATTERNS = [/api[_-]?key/i, /token/i, /password/i, /private[_-]?key/i];

function containsSecret(value: unknown): boolean {
  const text = JSON.stringify(value ?? "");
  return SECRET_PATTERNS.some((p) => p.test(text));
}

export const PolicyAndTelemetry = async () => {
  return {
    "tool.execute.before": async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args: Record<string, unknown> },
    ) => {
      if (containsSecret(output.args)) {
        throw new Error(
          "Policy blocked: potential secret detected in tool arguments.",
        );
      }

      console.log(
        JSON.stringify({
          kind: "tool_call",
          tool: input.tool,
          ts: new Date().toISOString(),
        }),
      );
    },
  };
};
