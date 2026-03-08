import { tool } from "@opencode-ai/plugin";
import { memoryFetch, memoryResponseHasError, resolveMemoryScopeUserId } from "./lib.ts";

export default tool({
  description:
    "Submit outcome feedback for a memory after it is used. Positive feedback reinforces useful memory; negative feedback demotes noisy or harmful memory.",
  args: {
    memory_id: tool.schema.string().uuid().describe("The UUID of the memory"),
    sentiment: tool.schema
      .enum(["positive", "negative"])
      .describe(
        "Feedback sentiment: 'positive' if the memory helped the outcome, 'negative' if it hurt the outcome",
      ),
    reason: tool.schema
      .string()
      .optional()
      .describe("Optional short reason for the feedback"),
    scope: tool.schema
      .enum(["personal", "stack", "global"])
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
    if (args.sentiment !== "positive" && args.sentiment !== "negative") {
      return JSON.stringify({
        error: true,
        message: "Invalid sentiment. Expected 'positive' or 'negative'.",
      });
    }

    const payload = {
      memory_id: args.memory_id,
      user_id: resolveMemoryScopeUserId(args.scope),
      agent_id: args.agent_id || "openpalm",
      app_id: args.app_id || "openpalm",
      ...(args.run_id ? { run_id: args.run_id } : {}),
      value: args.sentiment === "negative" ? -1 : 1,
      reason: args.reason,
    };

    let result = await memoryFetch(
      `/api/v1/memories/${encodeURIComponent(args.memory_id)}/feedback`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
    if (memoryResponseHasError(result)) {
      result = await memoryFetch("/api/v1/feedback", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    if (memoryResponseHasError(result)) {
      result = await memoryFetch("/api/v2/feedback", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    return result;
  },
});
