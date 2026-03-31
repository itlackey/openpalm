import { tool } from "@opencode-ai/plugin";
import { vikingFetch } from "./viking-lib.ts";

export default tool({
  description:
    "Semantic vector search across Viking knowledge. Returns scored results from resources, memories, and skills. Use this to find relevant knowledge by meaning rather than exact text.",
  args: {
    query: tool.schema.string().describe("The search query — describe what you're looking for in natural language"),
    target_uri: tool.schema
      .string()
      .optional()
      .describe("Scope search to a Viking URI path like 'viking://resources/docs'"),
    limit: tool.schema
      .string()
      .optional()
      .describe("Number of results to return (default: 10)"),
    score_threshold: tool.schema
      .string()
      .optional()
      .describe("Minimum relevance score (0.0–1.0) to include in results"),
  },
  async execute(args) {
    if (args.target_uri && !args.target_uri.startsWith("viking://")) {
      return JSON.stringify({ error: true, message: "target_uri must start with 'viking://'" });
    }
    const body: Record<string, unknown> = { query: args.query };
    if (args.target_uri) body.target_uri = args.target_uri;
    if (args.limit) {
      const parsed = Number(args.limit);
      if (Number.isFinite(parsed) && parsed > 0) body.limit = Math.floor(parsed);
    }
    if (args.score_threshold) {
      const parsed = Number(args.score_threshold);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
        body.score_threshold = parsed;
      }
    }
    return vikingFetch("/search/find", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
});
