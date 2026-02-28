import { tool } from "@opencode-ai/plugin";
import { memoryFetch, USER_ID } from "./lib.ts";

export default tool({
  description:
    "Update the content of an existing memory. Use this to correct or refine a previously stored memory when you learn that information has changed or was inaccurate.",
  args: {
    memory_id: tool.schema.string().uuid().describe("The UUID of the memory to update"),
    memory_content: tool.schema.string().describe("The updated memory content"),
  },
  async execute(args) {
    return memoryFetch(`/api/v1/memories/${args.memory_id}`, {
      method: "PUT",
      body: JSON.stringify({ memory_content: args.memory_content, user_id: USER_ID }),
    });
  },
});
