import { tool } from "@opencode-ai/plugin";
import { memoryFetch, USER_ID } from "./lib.ts";

const APP_NAME = "openpalm-assistant";

export default tool({
  description:
    "Store a new memory. Call this when the user shares preferences, makes decisions, provides project context, states facts about themselves or their environment, or when you learn something important that should persist across sessions. The memory system will automatically extract and deduplicate facts. Write memories as clear, standalone statements.",
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
    let metadata: Record<string, unknown> = {};
    if (args.metadata) {
      try {
        const parsed = JSON.parse(args.metadata) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        } else {
          return JSON.stringify({ error: true, message: "metadata must be a JSON object" });
        }
      } catch {
        return JSON.stringify({ error: true, message: "Invalid JSON in metadata argument" });
      }
    }
    // Apply defaults for categorisation fields when not provided
    if (typeof metadata.category !== "string") metadata.category = "semantic";
    if (typeof metadata.source !== "string") metadata.source = "manual";
    if (typeof metadata.confidence !== "number") metadata.confidence = 1.0;
    if (typeof metadata.access_count !== "number") metadata.access_count = 0;
    if (typeof metadata.last_accessed !== "string") metadata.last_accessed = new Date().toISOString();
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
