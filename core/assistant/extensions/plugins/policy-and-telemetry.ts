/**
 * Defensive policy plugin for OpenCode.
 *
 * Scans tool arguments for secret patterns and blocks execution if detected.
 * Logs all tool calls as structured JSON for audit purposes.
 */

import { containsSecret } from "../lib/openmemory-client.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("plugin-policy");

type Plugin = () => Promise<Record<string, unknown>>;

export const PolicyAndTelemetry: Plugin = async () => {
  return {
    "tool.execute.before": async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args: Record<string, unknown> },
    ) => {
      if (containsSecret(JSON.stringify(output.args ?? ""))) {
        throw new Error(
          "Policy blocked: potential secret detected in tool arguments.",
        );
      }

      log.info("tool_call", { tool: input.tool });
    },
  };
};
