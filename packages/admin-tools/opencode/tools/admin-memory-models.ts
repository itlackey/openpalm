import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export default tool({
  description:
    "Check the memory service embedding model configuration. Returns the configured embedding model, dimensions, and whether the model is available. Use this to diagnose memory/embedding issues.",
  async execute() {
    return adminFetch("/admin/memory/models");
  },
});
