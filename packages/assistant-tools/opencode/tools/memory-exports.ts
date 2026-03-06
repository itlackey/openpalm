import { tool } from "@opencode-ai/plugin";
import { memoryFetch, memoryResponseHasError, resolveMemoryScopeUserId } from "./lib.ts";

export const create = tool({
  description:
    "Create a memory export job for snapshots, audits, and curation pipelines.",
  args: {
    scope: tool.schema
      .string()
      .optional()
      .describe("Memory scope to map to a deterministic user_id"),
    agent_id: tool.schema
      .string()
      .optional()
      .describe("Optional agent identifier"),
    app_id: tool.schema
      .string()
      .optional()
      .describe("Optional application/project identifier"),
    run_id: tool.schema
      .string()
      .optional()
      .describe("Optional session/run identifier"),
  },
  async execute(args) {
    const payload = {
      user_id: resolveMemoryScopeUserId(args.scope),
      agent_id: args.agent_id || "openpalm",
      app_id: args.app_id || "openpalm",
      ...(args.run_id ? { run_id: args.run_id } : {}),
    };
    let result = await memoryFetch("/api/v1/exports", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (memoryResponseHasError(result)) {
      result = await memoryFetch("/api/v2/exports", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    return result;
  },
});

export const get = tool({
  description:
    "Fetch status/details for a memory export job by export ID.",
  args: {
    export_id: tool.schema.string().describe("Export job identifier"),
    scope: tool.schema
      .string()
      .optional()
      .describe("Memory scope to map to a deterministic user_id"),
  },
  async execute(args) {
    const userId = resolveMemoryScopeUserId(args.scope);
    let result = await memoryFetch(
      `/api/v1/exports/${encodeURIComponent(args.export_id)}?user_id=${encodeURIComponent(userId)}`,
    );
    if (memoryResponseHasError(result)) {
      result = await memoryFetch(
        `/api/v2/exports/${encodeURIComponent(args.export_id)}?user_id=${encodeURIComponent(userId)}`,
      );
    }
    return result;
  },
});
