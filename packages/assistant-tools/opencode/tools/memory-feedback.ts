import { tool } from "@opencode-ai/plugin";
import { memoryFetch, USER_ID } from "./lib.ts";

const STACK_USER_ID = "openpalm";
const GLOBAL_USER_ID = "global";

function resolveUserId(scope?: string): string {
  if (scope === "stack") return STACK_USER_ID;
  if (scope === "global") return GLOBAL_USER_ID;
  return USER_ID;
}

export default tool({
  description:
    "Submit outcome feedback for a memory after it is used. Positive feedback reinforces useful memory; negative feedback demotes noisy or harmful memory.",
  args: {
    memory_id: tool.schema.string().uuid().describe("The UUID of the memory"),
    sentiment: tool.schema
      .string()
      .describe("Whether the memory helped or hurt the outcome"),
    reason: tool.schema
      .string()
      .optional()
      .describe("Optional short reason for the feedback"),
    scope: tool.schema
      .string()
      .optional()
      .describe("Memory scope to map to a deterministic user_id"),
    agent_id: tool.schema
      .string()
      .optional()
      .describe("Optional agent identifier (defaults to openpalm)"),
    app_id: tool.schema
      .string()
      .optional()
      .describe("Optional project/application identifier"),
    run_id: tool.schema
      .string()
      .optional()
      .describe("Optional session/run identifier"),
  },
  async execute(args) {
    const payload = {
      memory_id: args.memory_id,
      user_id: resolveUserId(args.scope),
      agent_id: args.agent_id || "openpalm",
      app_id: args.app_id || "openpalm",
      ...(args.run_id ? { run_id: args.run_id } : {}),
      value: args.sentiment === "negative" ? -1 : 1,
      reason: args.reason,
    };

    let result = await memoryFetch(
      `/api/v1/memories/${args.memory_id}/feedback`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
    if (result.includes('"error":true')) {
      result = await memoryFetch("/api/v1/feedback", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    if (result.includes('"error":true')) {
      result = await memoryFetch("/api/v2/feedback", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    return result;
  },
});
