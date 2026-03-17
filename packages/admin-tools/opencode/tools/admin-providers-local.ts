import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export default tool({
  description:
    "Detect local LLM providers available on the host. Returns discovered providers (Ollama, Docker Model Runner, LM Studio) with their availability status and base URLs. Use this during initial setup or when configuring connections.",
  async execute() {
    return adminFetch("/admin/providers/local", {
      signal: AbortSignal.timeout(15_000),
    });
  },
});
