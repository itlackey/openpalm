import { tool } from "@opencode-ai/plugin";
import { memoryFetch, USER_ID } from "./lib.ts";

export default tool({
  description:
    "Delete one or more memories by their UUIDs. Use this when the user asks you to forget something, or to remove outdated/incorrect memories.",
  args: {
    memory_ids: tool.schema
      .string()
      .describe("Comma-separated list of memory UUIDs to delete (at least one required)"),
  },
  async execute(args) {
    const ids = args.memory_ids.split(",").map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return JSON.stringify({ error: true, message: "No memory IDs provided" });
    return memoryFetch("/api/v1/memories/", {
      method: "DELETE",
      body: JSON.stringify({ memory_ids: ids, user_id: USER_ID }),
    });
  },
});
