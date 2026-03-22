import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export default tool({
  description:
    "List available models from a provider for memory/embedding configuration. Requires a provider name (e.g. 'openai', 'ollama'). Optionally accepts an API key reference and base URL.",
  args: {
    provider: tool.schema.string().describe("Provider name (e.g. 'openai', 'ollama', 'anthropic')"),
    apiKeyRef: tool.schema.string().optional().describe("API key env reference (e.g. 'env:OPENAI_API_KEY')"),
    baseUrl: tool.schema.string().optional().describe("Provider base URL override"),
  },
  async execute(args) {
    return adminFetch("/admin/memory/models", {
      method: "POST",
      body: JSON.stringify({
        provider: args.provider,
        apiKeyRef: args.apiKeyRef,
        baseUrl: args.baseUrl ?? "",
      }),
    });
  },
});
