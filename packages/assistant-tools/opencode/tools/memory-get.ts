import { tool } from "@opencode-ai/plugin";
import { memoryFetch } from "./lib.ts";

export default tool({
  description:
    "Get a specific memory by its UUID. Use this to inspect the full content, metadata, categories, and state of a single memory entry.",
  args: {
    memory_id: tool.schema.string().uuid().describe("The UUID of the memory to retrieve"),
  },
  async execute(args) {
    return memoryFetch(`/api/v1/memories/${args.memory_id}`);
  },
});
