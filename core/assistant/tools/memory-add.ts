import { tool } from "@opencode-ai/plugin";
import { memoryFetch, USER_ID } from "./lib.ts";

const APP_NAME = "openpalm-assistant";

export default tool({
  description:
    "Store a new memory in OpenMemory. Call this when the user shares preferences, makes decisions, provides project context, states facts about themselves or their environment, or when you learn something important that should persist across sessions. The memory system will automatically extract and deduplicate facts. Write memories as clear, standalone statements.",
  args: {
    text: tool.schema
      .string()
      .describe(
        "The memory content to store. Write as a clear, self-contained statement. Examples: 'User prefers TypeScript over JavaScript', 'Project uses PostgreSQL 18 with Qdrant vector store', 'Deploy target is Docker Compose on Ubuntu 24.04'"
      ),
    metadata: tool.schema
      .string()
      .optional()
      .describe("Optional JSON object of key-value metadata to attach, e.g. '{\"category\":\"preference\",\"project\":\"openpalm\"}'"),
  },
  async execute(args) {
    let metadata: Record<string, string> = {};
    if (args.metadata) {
      try { metadata = JSON.parse(args.metadata); } catch {}
    }
    return memoryFetch("/api/v1/memories/", {
      method: "POST",
      body: JSON.stringify({
        user_id: USER_ID,
        text: args.text,
        app: APP_NAME,
        metadata,
        infer: true,
      }),
    });
  },
});
