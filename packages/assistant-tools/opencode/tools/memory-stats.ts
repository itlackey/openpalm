import { tool } from "@opencode-ai/plugin";
import { memoryFetch, USER_ID } from "./lib.ts";

export default tool({
  description:
    "Get memory statistics — total number of memories and apps. Use this for a quick overview of the memory store's size and health.",
  async execute() {
    return memoryFetch(`/api/v1/stats/?user_id=${encodeURIComponent(USER_ID)}`);
  },
});
