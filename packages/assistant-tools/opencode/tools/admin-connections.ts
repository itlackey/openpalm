import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export const get = tool({
  description: "Get current LLM provider connection keys and config values. API key values are masked (all but last 4 characters visible). Use this to see which keys are configured without exposing actual values.",
  async execute() {
    return adminFetch("/admin/connections");
  },
});

export const set = tool({
  description: "Update one or more LLM provider connection keys in secrets.env. Only allowed keys are accepted: OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, GOOGLE_API_KEY, SYSTEM_LLM_PROVIDER, SYSTEM_LLM_BASE_URL, SYSTEM_LLM_MODEL, OPENAI_BASE_URL, EMBEDDING_MODEL, EMBEDDING_DIMS, OPENMEMORY_USER_ID. Never log or echo the actual key values.",
  args: {
    patches: tool.schema.string().describe("JSON object of key-value pairs to update, e.g. '{\"OPENAI_API_KEY\":\"sk-...\",\"SYSTEM_LLM_PROVIDER\":\"anthropic\"}'"),
  },
  async execute(args) {
    let body: Record<string, string>;
    try {
      body = JSON.parse(args.patches);
    } catch {
      return JSON.stringify({ error: true, message: "Invalid JSON in patches argument" });
    }
    return adminFetch("/admin/connections", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
});

export const status = tool({
  description: "Check whether the system LLM connection is configured (provider and model set). Returns { complete: boolean, missing: string[] }. API keys are optional for all providers.",
  async execute() {
    return adminFetch("/admin/connections/status");
  },
});
