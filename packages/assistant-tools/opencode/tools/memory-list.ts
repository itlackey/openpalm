import { tool } from "@opencode-ai/plugin";
import { memoryFetch, USER_ID } from "./lib.ts";

export default tool({
  description:
    "List all memories stored in the memory service with filtering and pagination. Use this to browse the full memory store, filter by app or category, or review what has been remembered.",
  args: {
    page: tool.schema.number().optional().describe("Page number (default: 1)"),
    size: tool.schema.number().optional().describe("Results per page (default: 20, max: 100)"),
    search_query: tool.schema.string().optional().describe("Text search filter (substring match, not semantic)"),
    sort_column: tool.schema.string().optional().describe("Column to sort by: memory, app_name, or created_at (default: created_at)"),
    sort_direction: tool.schema.string().optional().describe("Sort direction: asc or desc (default: desc)"),
  },
  async execute(args) {
    const page = typeof args.page === "number" && Number.isFinite(args.page) && args.page > 0
      ? Math.floor(args.page)
      : 1;
    const sizeInput = typeof args.size === "number" && Number.isFinite(args.size)
      ? Math.floor(args.size)
      : 20;
    const size = Math.min(Math.max(sizeInput, 1), 100);
    const sortColumn = ["created_at", "memory", "app_name"].includes(args.sort_column || "")
      ? args.sort_column
      : "created_at";
    const sortDirection = args.sort_direction === "asc" ? "asc" : "desc";
    return memoryFetch("/api/v1/memories/filter", {
      method: "POST",
      body: JSON.stringify({
        user_id: USER_ID,
        page,
        size,
        search_query: args.search_query || null,
        sort_column: sortColumn,
        sort_direction: sortDirection,
      }),
    });
  },
});
