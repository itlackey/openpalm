import { tool } from "@opencode-ai/plugin";
import { memoryFetch } from "./lib.ts";

export const list = tool({
  description:
    "List all apps (memory sources/clients) registered in OpenMemory with their memory counts and access statistics. Use this to understand which applications are contributing memories.",
  async execute() {
    return memoryFetch("/api/v1/apps/?page=1&page_size=50");
  },
});

export const get = tool({
  description:
    "Get details for a specific app including memory count, access statistics, and activity timestamps.",
  args: {
    app_id: tool.schema.string().uuid().describe("The UUID of the app to inspect"),
  },
  async execute(args) {
    return memoryFetch(`/api/v1/apps/${args.app_id}`);
  },
});

export const memories = tool({
  description:
    "List memories created by a specific app. Use this to review what a particular application has stored.",
  args: {
    app_id: tool.schema.string().uuid().describe("The UUID of the app"),
    page: tool.schema.number().optional().describe("Page number (default: 1)"),
    page_size: tool.schema.number().optional().describe("Results per page (default: 20)"),
  },
  async execute(args) {
    const page = args.page || 1;
    const size = args.page_size || 20;
    return memoryFetch(`/api/v1/apps/${args.app_id}/memories?page=${page}&page_size=${size}`);
  },
});
