import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export default tool({
  description:
    "Test connectivity to an LLM provider endpoint. Returns whether the provider is reachable, which models are available, and any connection errors. Use this to verify API keys and URLs before saving them.",
  args: {
    baseUrl: tool.schema
      .string()
      .describe("Provider API URL to test (e.g. http://host.docker.internal:11434 for Ollama)"),
    apiKey: tool.schema
      .string()
      .optional()
      .describe("API key to use for the test. Omit for providers that don't require one."),
    kind: tool.schema
      .string()
      .optional()
      .describe('Provider kind hint (e.g. "ollama", "openai", "anthropic")'),
  },
  async execute(args) {
    if (!args.baseUrl.startsWith("http://") && !args.baseUrl.startsWith("https://")) {
      return JSON.stringify({
        error: true,
        message: "baseUrl must start with http:// or https://",
      });
    }

    const body: Record<string, string> = { baseUrl: args.baseUrl };
    if (args.apiKey) body.apiKey = args.apiKey;
    if (args.kind) body.kind = args.kind;

    return adminFetch("/admin/connections/test", {
      method: "POST",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  },
});
