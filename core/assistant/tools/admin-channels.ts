import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export const list = tool({
  description: "List all discovered channels, their routing status (hasRoute), and whether they are built-in or community-added",
  async execute() {
    return adminFetch("/admin/channels");
  },
});
