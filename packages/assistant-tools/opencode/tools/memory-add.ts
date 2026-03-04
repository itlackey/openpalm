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
      .describe(
        "Optional JSON object of key-value metadata. Supports 'category' ('semantic' for facts/preferences, 'episodic' for events/outcomes, 'procedural' for workflows/patterns), 'source', 'project', etc. Example: '{\"category\":\"semantic\",\"project\":\"openpalm\"}'",
      ),
  },
  async execute(args) {
    let metadata: Record<string, any> = {};
    if (args.metadata) {
      try { metadata = JSON.parse(args.metadata); } catch {}
    }
    // Apply defaults for categorisation fields when not provided
    if (!metadata.category) metadata.category = "semantic";
    if (!metadata.source) metadata.source = "manual";
    if (metadata.confidence === undefined) metadata.confidence = 1.0;
    if (!metadata.access_count) metadata.access_count = 0;
    if (!metadata.last_accessed) metadata.last_accessed = new Date().toISOString();
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
