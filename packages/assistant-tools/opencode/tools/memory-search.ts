import { tool } from "@opencode-ai/plugin";
import { memoryFetch, USER_ID } from "./lib.ts";

export default tool({
  description:
    "Semantically search memories stored in OpenMemory. Use this EVERY TIME a user asks a question, starts a new task, or when you need context about the user's preferences, past decisions, project details, or prior conversations. Returns the most relevant memories ranked by similarity score.",
  args: {
    query: tool.schema.string().describe("The search query — describe what you're looking for in natural language"),
  },
  async execute(args) {
    return memoryFetch("/api/v1/memories/filter", {
      method: "POST",
      body: JSON.stringify({ user_id: USER_ID, search_query: args.query, page: 1, size: 20 }),
    });
  },
});
